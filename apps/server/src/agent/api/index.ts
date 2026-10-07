/**
 * API 层：唯一对外门面，只做转发与序列化，不含逻辑。
 * - 会话操作：创建/列表/发消息/中断/配置/分叉/归档
 * - 事件订阅：GET /api/sessions/:id/events?after_seq=N（SSE，先补缺口再转实时）
 * - 审批响应：POST /api/sessions/:id/approvals/:approvalId
 */

import os from "node:os";

const HOME_PREFIX_RE = /^~/;

import {
	CreateSessionRequest,
	ForkSessionRequest,
	PostMessageRequest,
	ResolveApprovalRequest,
} from "@shuyi-harness/types";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../bus/index.js";
import type { ModelRegistry } from "../model/index.js";
import type { SessionManager } from "../session/manager.js";
import type { EventStore } from "../store/event-store.js";

export interface ApiDeps {
	bus: EventBus;
	models: ModelRegistry;
	sessions: SessionManager;
	store: EventStore;
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
		// 展开 `~` 为家目录（浏览器端不便可靠解析）
		const cwd = body.cwd.startsWith("~")
			? body.cwd.replace(HOME_PREFIX_RE, os.homedir())
			: body.cwd;
		const session = await deps.sessions.createSession({ ...body, cwd });
		return c.json(session, 201);
	});

	app.get("/api/sessions", async (c) =>
		c.json(await deps.sessions.listSessions())
	);

	app.get("/api/sessions/:id", async (c) => {
		const session = await deps.sessions.getSession(c.req.param("id"));
		if (!session) {
			return c.json({ error: "会话不存在" }, 404);
		}
		return c.json(session);
	});

	app.post("/api/sessions/:id/messages", async (c) => {
		const body = PostMessageRequest.parse(await c.req.json());
		await deps.sessions.postMessage(c.req.param("id"), body.text);
		return c.json({ ok: true }, 202);
	});

	app.post("/api/sessions/:id/abort", (c) => {
		deps.sessions.abort(c.req.param("id"));
		return c.json({ ok: true });
	});

	app.post("/api/sessions/:id/config", async (c) => {
		const body = await c.req.json();
		await deps.sessions.updateConfig(c.req.param("id"), body);
		return c.json({ ok: true });
	});

	app.post("/api/sessions/:id/fork", async (c) => {
		const body = ForkSessionRequest.parse(await c.req.json());
		const fork = await deps.sessions.fork(c.req.param("id"), body.at_seq);
		return c.json(fork, 201);
	});

	app.post("/api/sessions/:id/archive", async (c) => {
		await deps.sessions.archive(c.req.param("id"));
		return c.json({ ok: true });
	});

	// ---------- 审批 ----------
	app.post("/api/sessions/:id/approvals/:approvalId", async (c) => {
		const body = ResolveApprovalRequest.parse(await c.req.json());
		const ok = deps.sessions.resolveApproval(
			c.req.param("id"),
			c.req.param("approvalId"),
			body
		);
		if (!ok) {
			return c.json({ error: "审批不存在或已处理" }, 404);
		}
		return c.json({ ok: true });
	});

	// ---------- 全文搜索（P4） ----------
	app.get("/api/search", async (c) => {
		const q = c.req.query("q")?.trim();
		if (!q) {
			return c.json([]);
		}
		return c.json(await deps.store.search(q));
	});

	// ---------- 模型 ----------
	app.get("/api/models", (c) =>
		c.json(
			[...deps.models.adapters.values()].map((a) => ({
				id: a.id,
				label: a.label,
				provider: a.id === "mock" ? "local" : "openai-compatible",
			}))
		)
	);

	// ---------- SSE 事件订阅 ----------
	app.get("/api/sessions/:id/events", async (c) => {
		const sessionId = c.req.param("id");
		const afterSeq = Number(c.req.query("after_seq") ?? "-1");
		if (!(await deps.sessions.getSession(sessionId))) {
			return c.json({ error: "会话不存在" }, 404);
		}

		return streamSSE(c, async (stream) => {
			// 1. 补发缺口
			const missed = await deps.store.readSince(sessionId, afterSeq);
			for (const e of missed) {
				// biome-ignore lint/performance/noAwaitInLoops: SSE 按序逐帧写出
				await stream.writeSSE({ data: JSON.stringify(e) });
			}

			// 2. 转入实时推送
			let closed = false;
			const unsubscribe = deps.bus.subscribe((event) => {
				if (closed || event.session_id !== sessionId) {
					return;
				}
				// biome-ignore lint/complexity/noVoid: 事件回调内 fire-and-forget 写流
				void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {
					closed = true;
					unsubscribe();
				});
			});

			// 心跳防代理断连
			const heartbeat = setInterval(() => {
				// biome-ignore lint/complexity/noVoid: 定时回调内 fire-and-forget 心跳
				void stream.writeSSE({ data: "", event: "ping" }).catch(() => {
					closed = true;
				});
			}, 15_000);

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
