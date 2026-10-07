/**
 * 会话管理：生命周期（创建/恢复/分叉/删除）+ 活跃 Loop 注册表。
 * 恢复 = 事件日志已在库中，Loop 下次 runTurn 时 rebuild 即恢复上下文；
 *       服务端重启后无需特殊动作——这正是事件日志是唯一事实来源的含义。
 */
import { randomUUID } from "node:crypto";
import type {
	SandboxLevel,
	SessionMode,
	SessionRecord,
} from "@shuyi-harness/types";
import { runTurn } from "../loop/index.js";
import type { ModelRegistry } from "../model/index.js";
import type { PermissionService } from "../permission/index.js";
import { PermissionService as PermissionServiceImpl } from "../permission/index.js";
import type { EventStore } from "../store/event-store.js";
import type { ToolRegistry } from "../tools/index.js";

interface PendingApproval {
	resolve: (r: {
		decision: "approve" | "deny";
		remember_rule?: string;
		deny_reason?: string;
	}) => void;
}

export class SessionManager {
	/** 活跃轮次的中断控制器 */
	private readonly abortControllers = new Map<string, AbortController>();
	/** 挂起中的审批：approvalId → resolver */
	private readonly pendingApprovals = new Map<string, PendingApproval>();
	/** 每会话独立的权限服务（记住的规则是会话作用域） */
	private readonly permissions = new Map<string, PermissionService>();

	private readonly store: EventStore;
	private readonly tools: ToolRegistry;
	private readonly models: ModelRegistry;

	constructor(store: EventStore, tools: ToolRegistry, models: ModelRegistry) {
		this.store = store;
		this.tools = tools;
		this.models = models;
	}

	async createSession(opts: {
		title?: string;
		cwd: string;
		mode: SessionMode;
		model: string;
		sandbox_level: SandboxLevel;
	}): Promise<SessionRecord> {
		const sessionId = randomUUID();
		const record = await this.store.createSession({
			archived: false,
			caller_identity: "local-user", // 身份挂钩：个人版常量
			created_at: Date.now(),
			cwd: opts.cwd,
			forked_from: null,
			mode: opts.mode,
			model: opts.model,
			sandbox_level: opts.sandbox_level,
			session_id: sessionId,
			title: opts.title ?? `会话 ${new Date().toLocaleString("zh-CN")}`,
		});
		await this.store.append({
			actor: "system",
			payload: {
				cwd: record.cwd,
				mode: record.mode,
				model: record.model,
				sandbox_level: record.sandbox_level,
				title: record.title,
			},
			session_id: sessionId,
			type: "session.created",
		});
		const created = await this.store.getSession(sessionId);
		if (!created) {
			throw new Error("会话创建后读取失败（不应发生）");
		}
		return created;
	}

	getSession(sessionId: string): Promise<SessionRecord | null> {
		return this.store.getSession(sessionId);
	}

	listSessions(): Promise<SessionRecord[]> {
		return this.store.listSessions();
	}

	async postMessage(sessionId: string, text: string): Promise<void> {
		const session = await this.store.getSession(sessionId);
		if (!session) {
			throw new Error(`会话不存在: ${sessionId}`);
		}
		if (
			session.status === "running" ||
			session.status === "awaiting_approval"
		) {
			throw new Error("会话正忙，请先中断或等待当前轮次结束");
		}
		const adapter = this.models.adapters.get(session.model);
		if (!adapter) {
			throw new Error(`模型不可用: ${session.model}`);
		}

		const permission = this.permissionFor(sessionId);
		const controller = new AbortController();
		this.abortControllers.set(sessionId, controller);

		// 异步跑轮次；错误已由 Loop 内部落 error.occurred 事件
		// biome-ignore lint/complexity/noVoid: 轮次故意 fire-and-forget，由 Loop 落事件
		void runTurn(
			session,
			text,
			adapter,
			permission,
			{
				store: this.store,
				tools: this.tools,
				waitForApproval: (sid, approvalId) =>
					this.waitForApproval(sid, approvalId),
			},
			controller.signal
		).finally(() => {
			this.abortControllers.delete(sessionId);
		});
	}

	abort(sessionId: string): void {
		this.abortControllers.get(sessionId)?.abort();
		// 若有挂起的审批，以拒绝释放，避免 Loop 永远悬挂
		for (const [key, pending] of this.pendingApprovals) {
			if (key.startsWith(`${sessionId}:`)) {
				pending.resolve({ decision: "deny", deny_reason: "会话被中断" });
				this.pendingApprovals.delete(key);
			}
		}
	}

	resolveApproval(
		sessionId: string,
		approvalId: string,
		resolution: {
			decision: "approve" | "deny";
			remember_rule?: string;
			deny_reason?: string;
		}
	): boolean {
		const key = `${sessionId}:${approvalId}`;
		const pending = this.pendingApprovals.get(key);
		if (!pending) {
			return false;
		}
		pending.resolve(resolution);
		this.pendingApprovals.delete(key);
		return true;
	}

	private waitForApproval(
		sessionId: string,
		approvalId: string
	): Promise<{
		decision: "approve" | "deny";
		remember_rule?: string;
		deny_reason?: string;
	}> {
		return new Promise((resolve) => {
			this.pendingApprovals.set(`${sessionId}:${approvalId}`, { resolve });
		});
	}

	async updateConfig(
		sessionId: string,
		patch: { mode?: SessionMode; model?: string; sandbox_level?: SandboxLevel }
	): Promise<void> {
		const session = await this.store.getSession(sessionId);
		if (!session) {
			throw new Error(`会话不存在: ${sessionId}`);
		}
		await this.store.updateSessionConfig(sessionId, patch);
		await this.store.append({
			actor: "user",
			payload: patch,
			session_id: sessionId,
			type: "session.config_changed",
		});
		// 模式变化影响「记住的规则」语义，清空避免越权
		if (patch.mode || patch.sandbox_level) {
			this.permissionFor(sessionId).clearRules();
		}
	}

	async fork(sessionId: string, atSeq: number): Promise<SessionRecord> {
		const source = await this.store.getSession(sessionId);
		if (!source) {
			throw new Error(`会话不存在: ${sessionId}`);
		}
		const fork = await this.createSession({
			cwd: source.cwd,
			mode: source.mode,
			model: source.model,
			sandbox_level: source.sandbox_level,
			title: `${source.title}（分叉）`,
		});
		// 复制 [0, atSeq] 事件（session.created 事件除外，新会话已有自己的）
		const events = await this.store.readRange(sessionId, 0, atSeq);
		for (const e of events) {
			if (e.type === "session.created") {
				continue;
			}
			// biome-ignore lint/performance/noAwaitInLoops: 分叉必须按序逐条复制事件
			await this.store.append({
				actor: e.actor,
				causation_id: e.causation_id,
				payload: e.payload,
				session_id: fork.session_id,
				turn_id: e.turn_id,
				type: e.type,
			} as never);
		}
		await this.store.append({
			actor: "user",
			payload: { fork_at_seq: atSeq, from_session_id: sessionId },
			session_id: fork.session_id,
			type: "session.forked",
		});
		const result = await this.store.getSession(fork.session_id);
		if (!result) {
			throw new Error("分叉会话读取失败（不应发生）");
		}
		return result;
	}

	async archive(sessionId: string): Promise<void> {
		await this.store.updateSessionConfig(sessionId, { archived: true });
		await this.store.append({
			actor: "user",
			payload: {},
			session_id: sessionId,
			type: "session.archived",
		});
	}

	private permissionFor(sessionId: string): PermissionService {
		let p = this.permissions.get(sessionId);
		if (!p) {
			p = new PermissionServiceImpl();
			this.permissions.set(sessionId, p);
		}
		return p;
	}
}
