/**
 * API 层：唯一对外门面，只做转发与序列化，不含逻辑。
 * - 会话操作：创建/列表/发消息/中断/配置/分叉/归档
 * - 事件订阅：GET /api/sessions/:id/events?after_seq=N（SSE，先补缺口再转实时）
 * - 审批响应：POST /api/sessions/:id/approvals/:approvalId
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  CreateSessionRequest,
  PostMessageRequest,
  ResolveApprovalRequest,
  ForkSessionRequest,
} from "@shuyi/types";
import type { EventStore } from "../store/event-store.js";
import type { EventBus } from "../bus/index.js";
import type { SessionManager } from "../session/manager.js";
import type { RuntimeModelRegistry, AddModelInput } from "../model/registry.js";
import { renderReplayHtml } from "./replay.js";
import type { AgentRegistry } from "../agents/index.js";
import { loadProjectConfig } from "../config/project.js";
import { enrichFromModelsDev } from "../model/modelsdev.js";

export interface ApiDeps {
  store: EventStore;
  bus: EventBus;
  sessions: SessionManager;
  models: RuntimeModelRegistry;
  agents: AgentRegistry;
}

export function createApi(deps: ApiDeps): Hono {
  const app = new Hono();
  app.use("/api/*", cors());

  app.onError((err, c) => {
    console.error("[api]", err);
    return c.json({ error: err.message }, 500);
  });

  // ---------- 会话 ----------
  app.post("/api/sessions", async (c) => {
    const body = CreateSessionRequest.parse(await c.req.json());
    // 模型分层解析（P8-5）：显式指定 → 项目 shuyi.json → 注册表默认
    let model = body.model;
    if (!model) {
      const configured = loadProjectConfig(body.cwd).model;
      model = configured && deps.models.get(configured) ? configured : deps.models.defaultModel;
    }
    const session = deps.sessions.createSession({ ...body, model });
    return c.json(session, 201);
  });

  app.get("/api/sessions", (c) => {
    return c.json(deps.sessions.listSessions());
  });

  app.get("/api/sessions/:id", (c) => {
    const session = deps.sessions.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "会话不存在" }, 404);
    return c.json(session);
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const body = PostMessageRequest.parse(await c.req.json());
    deps.sessions.postMessage(c.req.param("id"), body.text);
    return c.json({ ok: true }, 202);
  });

  // 带附件发消息：multipart/form-data（text 字段 + 任意数量文件）
  app.post("/api/sessions/:id/messages/with-attachments", async (c) => {
    const sessionId = c.req.param("id");
    const form = await c.req.formData();
    const text = String(form.get("text") ?? "").trim();
    if (!text) return c.json({ error: "text 不能为空" }, 400);
    const attachments: { name: string; path: string }[] = [];
    for (const [, value] of form.entries()) {
      // Hono FormData 的值类型为 string | File；以结构化特征判断（避免 instanceof 跨 realm 问题）
      if (typeof value === "object" && value !== null && "arrayBuffer" in value && "name" in value) {
        const file = value as File;
        const buf = Buffer.from(await file.arrayBuffer());
        attachments.push(deps.sessions.saveAttachment(sessionId, file.name, buf));
      }
    }
    deps.sessions.postMessageWithAttachments(sessionId, text, attachments);
    return c.json({ ok: true, attachments }, 202);
  });

  app.post("/api/sessions/:id/abort", (c) => {
    deps.sessions.abort(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/config", async (c) => {
    const body = await c.req.json();
    deps.sessions.updateConfig(c.req.param("id"), body);
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/fork", async (c) => {
    const body = ForkSessionRequest.parse(await c.req.json());
    const fork = deps.sessions.fork(c.req.param("id"), body.at_seq);
    return c.json(fork, 201);
  });

  app.post("/api/sessions/:id/archive", (c) => {
    deps.sessions.archive(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---------- 回滚（P7）：工作区恢复到某轮开始时的 git 状态 ----------
  app.post("/api/sessions/:id/rollback", async (c) => {
    const body = (await c.req.json()) as { commit?: string };
    if (!body?.commit) return c.json({ error: "缺少 commit 参数" }, 400);
    try {
      deps.sessions.rollback(c.req.param("id"), body.commit);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ---------- 审批 ----------
  app.post("/api/sessions/:id/approvals/:approvalId", async (c) => {
    const body = ResolveApprovalRequest.parse(await c.req.json());
    const ok = deps.sessions.resolveApproval(c.req.param("id"), c.req.param("approvalId"), body);
    if (!ok) return c.json({ error: "审批不存在或已处理" }, 404);
    return c.json({ ok: true });
  });

  // ---------- 全文搜索（P4） ----------
  app.get("/api/search", (c) => {
    const q = c.req.query("q")?.trim();
    if (!q) return c.json([]);
    return c.json(deps.store.search(q));
  });

  // ---------- 会话回放导出（P6） ----------
  app.get("/api/sessions/:id/replay", (c) => {
    const session = deps.sessions.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "会话不存在" }, 404);
    const events = deps.store.readSince(session.session_id, -1);
    const html = renderReplayHtml(session, events);
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `attachment; filename="replay-${session.session_id.slice(0, 8)}.html"`,
      },
    });
  });

  // ---------- 代理定义（P8-3） ----------
  app.get("/api/agents", (c) => {
    const cwd = c.req.query("cwd") || undefined;
    return c.json(deps.agents.list(cwd));
  });

  // ---------- 模型 ----------
  app.get("/api/models", (c) => {
    return c.json(deps.models.list());
  });

  app.post("/api/models", async (c) => {
    const body = (await c.req.json()) as AddModelInput;
    if (!body?.id || !body.baseURL || !body.apiKey || !body.model) {
      return c.json({ error: "缺少必填字段：id / baseURL / apiKey / model" }, 400);
    }
    try {
      const item = deps.models.add(body);
      // P8-6：未显式提供窗口/定价时，后台用 models.dev 元数据补全（走 24h 缓存）
      if (!body.contextWindow || !body.pricing) {
        void enrichFromModelsDev(deps.models).catch(() => {});
      }
      return c.json(item, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  app.delete("/api/models/:id", (c) => {
    try {
      deps.models.remove(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/models/:id/default", (c) => {
    try {
      deps.models.setDefault(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  // ---------- SSE 事件订阅 ----------
  app.get("/api/sessions/:id/events", (c) => {
    const sessionId = c.req.param("id");
    const afterSeq = Number(c.req.query("after_seq") ?? "-1");
    if (!deps.sessions.getSession(sessionId)) return c.json({ error: "会话不存在" }, 404);

    return streamSSE(c, async (stream) => {
      // 1. 补发缺口
      const missed = deps.store.readSince(sessionId, afterSeq);
      for (const e of missed) {
        await stream.writeSSE({ data: JSON.stringify(e) });
      }

      // 2. 转入实时推送
      let closed = false;
      const unsubscribe = deps.bus.subscribe((event) => {
        if (closed || event.session_id !== sessionId) return;
        void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {
          closed = true;
          unsubscribe();
        });
      });

      // 心跳防代理断连
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "" }).catch(() => {
          closed = true;
        });
      }, 15000);

      stream.onAbort(() => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      });

      // 保持连接打开，直到客户端断开
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (closed) {
            clearInterval(check);
            clearInterval(heartbeat);
            unsubscribe();
            resolve();
          }
        }, 1000);
      });
    });
  });

  return app;
}
