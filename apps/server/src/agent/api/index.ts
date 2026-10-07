/**
 * API 层：唯一对外门面，只做转发与序列化，不含逻辑。
 * - 会话操作：创建/列表/发消息/中断/配置/分叉/归档
 * - 事件订阅：GET /api/sessions/:id/events?after_seq=N（SSE，先补缺口再转实时）
 * - 审批响应：POST /api/sessions/:id/approvals/:approvalId
 */

import os from "node:os";

const HOME_PREFIX_RE = /^~/;

import path from "node:path";
import {
	CreateSessionRequest,
	ForkSessionRequest,
	PostMessageRequest,
	ResolveApprovalRequest,
} from "@shuyi-harness/types";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { AgentRegistry } from "../agents/index.js";
import type { EventBus } from "../bus/index.js";
import { loadProjectConfig } from "../config/project.js";
import { enrichFromModelsDev } from "../model/modelsdev.js";
import type { AddModelInput, RuntimeModelRegistry } from "../model/registry.js";
import {
	appendPermissionRule,
	deletePermissionRule,
	loadPermissionRules,
} from "../permission/config.js";
import type { SessionManager } from "../session/manager.js";
import type { EventStore } from "../store/event-store.js";
import { renderReplayHtml } from "./replay.js";

export interface ApiDeps {
	agents: AgentRegistry;
	bus: EventBus;
	models: RuntimeModelRegistry;
	sessions: SessionManager;
	store: EventStore;
}

const GLOB_CHARS_RE = /[*?{}[\]]/;

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
		let { model } = body;
		if (!model) {
			const configured = loadProjectConfig(body.cwd).model;
			model =
				configured && deps.models.get(configured)
					? configured
					: deps.models.defaultModel;
		}
		// M2：起始代理校验（存在才允许绑定）
		if (body.agent && !deps.agents.get(body.agent, body.cwd)) {
			return c.json({ error: `代理定义不存在: ${body.agent}` }, 400);
		}
		// 展开 `~` 为家目录（浏览器端不便可靠解析）
		const cwd = body.cwd.startsWith("~")
			? body.cwd.replace(HOME_PREFIX_RE, os.homedir())
			: body.cwd;
		const session = await deps.sessions.createSession({ ...body, cwd, model });
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
		const r = await deps.sessions.postMessage(c.req.param("id"), body.text);
		return c.json({ ok: true, queued: r.queued }, 202);
	});

	// ---------- v0.4：交互体验（F1–F5） ----------
	// F1：rewind（code 恢复快照 / conversation 截断轨迹 / both）
	app.post("/api/sessions/:id/rewind", async (c) => {
		const body = ((await c.req.json()) ?? {}) as {
			to_seq?: number;
			mode?: string;
		};
		if (
			typeof body.to_seq !== "number" ||
			!["code", "conversation", "both"].includes(body.mode ?? "")
		) {
			return c.json(
				{ error: "缺少 to_seq / mode（code|conversation|both）" },
				400
			);
		}
		try {
			const r = deps.sessions.rewind(
				c.req.param("id"),
				body.to_seq,
				body.mode as "code" | "conversation" | "both"
			);
			return c.json({ ok: true, ...r });
		} catch (err) {
			return c.json(
				{ error: err instanceof Error ? err.message : String(err) },
				409
			);
		}
	});

	// F2：变更面板
	app.get("/api/sessions/:id/changes", (c) => {
		try {
			return c.json({ changes: deps.sessions.listChanges(c.req.param("id")) });
		} catch (err) {
			return c.json(
				{ error: err instanceof Error ? err.message : String(err) },
				404
			);
		}
	});
	app.post("/api/sessions/:id/changes/review", async (c) => {
		const body = ((await c.req.json()) ?? {}) as {
			path?: string;
			action?: string;
		};
		if (!(body.path && ["accept", "revert"].includes(body.action ?? ""))) {
			return c.json({ error: "缺少 path / action（accept|revert）" }, 400);
		}
		const r = await deps.sessions.reviewChange(
			c.req.param("id"),
			body.path,
			body.action as "accept" | "revert"
		);
		return r.ok ? c.json(r) : c.json(r, 409);
	});

	// F4：撤回排队消息
	app.post("/api/sessions/:id/queue/:qid/cancel", async (c) => {
		const ok = await deps.sessions.cancelQueued(
			c.req.param("id"),
			c.req.param("qid")
		);
		return ok ? c.json({ ok: true }) : c.json({ error: "排队消息不存在" }, 404);
	});

	// F5：批准计划（plan → build 并开工）
	app.post("/api/sessions/:id/plan/approve", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { text?: string };
		try {
			deps.sessions.approvePlan(c.req.param("id"), body.text || undefined);
			return c.json({ ok: true });
		} catch (err) {
			return c.json(
				{ error: err instanceof Error ? err.message : String(err) },
				409
			);
		}
	});

	// F1：turn 锚点列表（TUI /rewind 与潜在时间轴 UI 用）
	app.get("/api/sessions/:id/turns", async (c) => {
		const session = await deps.sessions.getSession(c.req.param("id"));
		if (!session) {
			return c.json({ error: "会话不存在" }, 404);
		}
		const turnSeqs = (await deps.store.readSince(session.session_id, -1))
			.filter((e) => e.type === "turn.started")
			.map((e) => e.seq);
		return c.json({ turn_seqs: turnSeqs });
	});

	// F3：@ 文件引用补全数据源
	app.get("/api/sessions/:id/files", (c) => {
		try {
			return c.json({
				files: deps.sessions.listFiles(
					c.req.param("id"),
					c.req.query("q") ?? ""
				),
			});
		} catch (err) {
			return c.json(
				{ error: err instanceof Error ? err.message : String(err) },
				404
			);
		}
	});

	// P0-4a：斜杠命令清单（供前端输入 "/" 时自动补全）
	app.get("/api/sessions/:id/commands", (c) =>
		c.json({ commands: deps.sessions.listCommands(c.req.param("id")) })
	);

	// P1-6：worktree 合并回主分支 / 放弃
	app.post("/api/sessions/:id/worktree/merge", async (c) => {
		const r = await deps.sessions.mergeSessionWorktree(c.req.param("id"));
		return r.ok ? c.json(r) : c.json(r, 409);
	});
	app.post("/api/sessions/:id/worktree/discard", async (c) => {
		const r = await deps.sessions.discardSessionWorktree(c.req.param("id"));
		return r.ok ? c.json(r) : c.json(r, 409);
	});

	// 带附件发消息：multipart/form-data（text 字段 + 任意数量文件）
	app.post("/api/sessions/:id/messages/with-attachments", async (c) => {
		const sessionId = c.req.param("id");
		const form = await c.req.formData();
		const text = String(form.get("text") ?? "").trim();
		if (!text) {
			return c.json({ error: "text 不能为空" }, 400);
		}
		const attachments: { name: string; path: string }[] = [];
		for (const [, value] of form.entries()) {
			// Hono FormData 的值类型为 string | File；以结构化特征判断（避免 instanceof 跨 realm 问题）
			if (
				typeof value === "object" &&
				value !== null &&
				"arrayBuffer" in value &&
				"name" in value
			) {
				const file = value as File;
				// biome-ignore lint/performance/noAwaitInLoops: 附件逐个顺序读取与落盘，保证顺序稳定
				const buf = Buffer.from(await file.arrayBuffer());
				attachments.push(
					await deps.sessions.saveAttachment(sessionId, file.name, buf)
				);
			}
		}
		await deps.sessions.postMessageWithAttachments(
			sessionId,
			text,
			attachments
		);
		return c.json({ attachments, ok: true }, 202);
	});

	app.post("/api/sessions/:id/abort", (c) => {
		deps.sessions.abort(c.req.param("id"));
		return c.json({ ok: true });
	});

	app.post("/api/sessions/:id/config", async (c) => {
		const body = (await c.req.json()) as { agent?: string };
		// M2：切换代理前校验定义存在
		if (body.agent) {
			const session = await deps.sessions.getSession(c.req.param("id"));
			if (!deps.agents.get(body.agent, session?.cwd)) {
				return c.json({ error: `代理定义不存在: ${body.agent}` }, 400);
			}
		}
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

	// ---------- 回滚（P7）：工作区恢复到某轮开始时的 git 状态 ----------
	app.post("/api/sessions/:id/rollback", async (c) => {
		const body = ((await c.req.json()) ?? {}) as { commit?: string };
		if (!body.commit) {
			return c.json({ error: "缺少 commit 参数" }, 400);
		}
		try {
			deps.sessions.rollback(c.req.param("id"), body.commit);
			return c.json({ ok: true });
		} catch (err) {
			return c.json(
				{ error: err instanceof Error ? err.message : String(err) },
				400
			);
		}
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

	// ---------- 会话回放导出（P6） ----------
	app.get("/api/sessions/:id/replay", async (c) => {
		const session = await deps.sessions.getSession(c.req.param("id"));
		if (!session) {
			return c.json({ error: "会话不存在" }, 404);
		}
		const events = await deps.store.readSince(session.session_id, -1);
		const html = renderReplayHtml(session, events);
		return new Response(html, {
			headers: {
				"content-disposition": `attachment; filename="replay-${session.session_id.slice(0, 8)}.html"`,
				"content-type": "text/html; charset=utf-8",
			},
		});
	});

	// ---------- 代理定义（P8-3 / M2） ----------
	app.get("/api/agents", (c) => {
		const cwd = c.req.query("cwd") || undefined;
		return c.json(deps.agents.list(cwd));
	});

	// M2：运行时新增/更新代理（持久化 ~/.agent/agents.json；内置代理名拒绝）
	app.put("/api/agents/:name", async (c) => {
		const name = c.req.param("name");
		const body = (await c.req.json()) as {
			description?: string;
			tools?: "readonly" | "all" | string[];
			model?: string;
			system?: string;
			/** 设计文档字段名（等价 system） */
			prompt?: string;
			modeDefault?: "plan" | "build";
			permissionOverride?: unknown[];
		};
		try {
			const def = deps.agents.upsertRuntime({
				description: body.description ?? "",
				modeDefault: body.modeDefault,
				model: body.model,
				name,
				permissionOverride: body.permissionOverride,
				system: body.system ?? body.prompt ?? "",
				tools: body.tools ?? "all",
			});
			return c.json(def);
		} catch (err) {
			return c.json(
				{ error: err instanceof Error ? err.message : String(err) },
				409
			);
		}
	});

	// M2：删除运行时代理（builtin/project/user 来源只读）
	app.delete("/api/agents/:name", (c) => {
		try {
			deps.agents.removeRuntime(c.req.param("name"));
			return c.json({ ok: true });
		} catch (err) {
			return c.json(
				{ error: err instanceof Error ? err.message : String(err) },
				400
			);
		}
	});

	// ---------- 权限规则（M3） ----------
	// scope=global → ~/.agent/permissions.json；scope=project → <cwd>/.agent/permissions.json
	const permFile = (scope: string, cwd?: string): string | null => {
		if (scope === "global") {
			return path.join(os.homedir(), ".agent", "permissions.json");
		}
		if (scope === "project" && cwd) {
			return path.join(cwd, ".agent", "permissions.json");
		}
		return null;
	};

	app.get("/api/permissions/rules", (c) => {
		const cwd = c.req.query("cwd") || undefined;
		const { project, global: globalRules } = loadPermissionRules(
			cwd ?? process.cwd()
		);
		return c.json({
			global: globalRules.map((r, i) => ({ ...r, index: i })),
			project: project.map((r, i) => ({ ...r, index: i })),
		});
	});

	app.post("/api/permissions/rules", async (c) => {
		const body = (await c.req.json()) as {
			scope?: string;
			cwd?: string;
			tool?: string;
			pattern?: string;
			patternType?: "glob" | "regex" | "prefix";
			decision?: "allow" | "ask" | "deny";
		};
		const file = permFile(body.scope ?? "", body.cwd);
		if (!file) {
			return c.json(
				{ error: "scope 须为 global 或 project（project 需带 cwd）" },
				400
			);
		}
		if (
			!(
				body.pattern &&
				body.decision &&
				["allow", "ask", "deny"].includes(body.decision)
			)
		) {
			return c.json(
				{ error: "缺少 pattern / decision（allow|ask|deny）" },
				400
			);
		}
		try {
			appendPermissionRule(file, {
				decision: body.decision as "allow" | "ask" | "deny",
				pattern: body.pattern,
				patternType:
					body.patternType ??
					(GLOB_CHARS_RE.test(body.pattern) ? "glob" : "prefix"),
				tool: body.tool || "*",
			});
			return c.json({ ok: true }, 201);
		} catch (err) {
			return c.json(
				{ error: err instanceof Error ? err.message : String(err) },
				400
			);
		}
	});

	app.delete("/api/permissions/rules", async (c) => {
		const body = (await c.req.json()) as {
			scope?: string;
			cwd?: string;
			index?: number;
		};
		const file = permFile(body.scope ?? "", body.cwd);
		if (!file) {
			return c.json(
				{ error: "scope 须为 global 或 project（project 需带 cwd）" },
				400
			);
		}
		if (typeof body.index !== "number") {
			return c.json({ error: "缺少 index" }, 400);
		}
		if (!deletePermissionRule(file, body.index)) {
			return c.json({ error: "规则不存在" }, 404);
		}
		return c.json({ ok: true });
	});

	// ---------- 模型 ----------
	app.get("/api/models", (c) => c.json(deps.models.list()));

	app.post("/api/models", async (c) => {
		const body = ((await c.req.json()) ?? {}) as AddModelInput;
		if (!(body.id && body.baseURL && body.apiKey && body.model)) {
			return c.json(
				{ error: "缺少必填字段：id / baseURL / apiKey / model" },
				400
			);
		}
		try {
			const item = deps.models.add(body);
			// P8-6：未显式提供窗口/定价时，后台用 models.dev 元数据补全（走 24h 缓存）
			if (!(body.contextWindow && body.pricing)) {
				// biome-ignore lint/complexity/noVoid: 元数据补全为后台任务，故意 fire-and-forget
				void enrichFromModelsDev(deps.models).catch(() => {
					// 补全失败静默（离线场景正常）
				});
			}
			return c.json(item, 201);
		} catch (err) {
			return c.json(
				{ error: err instanceof Error ? err.message : String(err) },
				409
			);
		}
	});

	app.delete("/api/models/:id", (c) => {
		try {
			deps.models.remove(c.req.param("id"));
			return c.json({ ok: true });
		} catch (err) {
			return c.json(
				{ error: err instanceof Error ? err.message : String(err) },
				400
			);
		}
	});

	app.post("/api/models/:id/default", (c) => {
		try {
			deps.models.setDefault(c.req.param("id"));
			return c.json({ ok: true });
		} catch (err) {
			return c.json(
				{ error: err instanceof Error ? err.message : String(err) },
				404
			);
		}
	});

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
				// biome-ignore lint/performance/noAwaitInLoops: SSE 补发帧必须按序写入，不可并行
				await stream.writeSSE({ data: JSON.stringify(e) });
			}
			// 无缺口时也立即写一帧提交响应头（新会话无历史事件，避免客户端挂起）
			if (missed.length === 0) {
				await stream.writeSSE({ data: "", event: "ping" });
			}

			// 2. 转入实时推送
			let closed = false;
			const unsubscribe = deps.bus.subscribe((event) => {
				if (closed || event.session_id !== sessionId) {
					return;
				}
				// biome-ignore lint/complexity/noVoid: SSE 实时推送 fire-and-forget，失败走 catch 关闭流
				void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {
					closed = true;
					unsubscribe();
				});
			});

			// 心跳防代理断连
			const heartbeat = setInterval(() => {
				// biome-ignore lint/complexity/noVoid: 心跳帧 fire-and-forget，失败走 catch 关闭流
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

	// ---------- M5：聚合 SSE 流（多会话分派） ----------
	// GET /api/events?sessions=a,b,c —— 按订阅集合过滤推送（缺省/空 = 全部会话）。
	// 单会话流仍是 /api/sessions/:id/events（带缺口补发）；聚合流只做实时通知，不补发。
	app.get("/api/events", (c) => {
		const param = c.req.query("sessions")?.trim();
		const sessionIds = param
			? new Set(
					param
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				)
			: null;

		return streamSSE(c, async (stream) => {
			let closed = false;
			const unsubscribe = deps.bus.subscribe((event) => {
				if (closed) {
					return;
				}
				if (sessionIds && !sessionIds.has(event.session_id)) {
					return;
				}
				// biome-ignore lint/complexity/noVoid: SSE 实时推送 fire-and-forget，失败走 catch 关闭流
				void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {
					closed = true;
					unsubscribe();
				});
			});
			// 立即写一帧提交响应头（聚合流无补发，否则客户端等到首个事件才拿到响应）
			await stream.writeSSE({ data: "", event: "ping" });

			const heartbeat = setInterval(() => {
				// biome-ignore lint/complexity/noVoid: 心跳帧 fire-and-forget，失败走 catch 关闭流
				void stream.writeSSE({ data: "", event: "ping" }).catch(() => {
					closed = true;
				});
			}, 15_000);

			stream.onAbort(() => {
				closed = true;
				clearInterval(heartbeat);
				unsubscribe();
			});

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
