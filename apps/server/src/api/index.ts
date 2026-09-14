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
import { estimateCost } from "../model/index.js";

export interface ApiDeps {
  store: EventStore;
  bus: EventBus;
  sessions: SessionManager;
  models: RuntimeModelRegistry;
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
    const session = deps.sessions.createSession(body);
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
