/**
 * 会话管理：生命周期（创建/恢复/分叉/删除）+ 活跃 Loop 注册表。
 * 恢复 = 事件日志已在库中，Loop 下次 runTurn 时 rebuild 即恢复上下文；
 *       服务端重启后无需特殊动作——这正是事件日志是唯一事实来源的含义。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
	SandboxLevel,
	SessionMode,
	SessionRecord,
} from "@shuyi-harness/types";
import { AgentRegistry } from "../agents/index.js";
import { type DiffResult, unifiedDiff } from "../checkpoint/diff.js";
import {
	collectChanges,
	restoreAfter,
	reviewChange,
} from "../checkpoint/index.js";
import {
	type CommandDefinition,
	loadCommands,
	tryExpandCommandInput,
} from "../commands/index.js";
import { loadProjectConfig } from "../config/project.js";
import {
	createWorktree,
	discardWorktree,
	mergeWorktree,
	rollbackTo,
} from "../git/index.js";
import { runTurn } from "../loop/index.js";
import type { RuntimeModelRegistry } from "../model/registry.js";
import { loadPermissionRules } from "../permission/config.js";
import type { PermissionService } from "../permission/index.js";
import { PermissionService as PermissionServiceImpl } from "../permission/index.js";
import type { EventStore } from "../store/event-store.js";
import type { ToolRegistry } from "../tools/index.js";
import { restoreTodosFromEvents, TodoStore } from "../tools/todo.js";

const DEFAULT_TITLE_RE = /^会话 \d/;

/** M3：审批决议（remember_pattern = 记住一条 glob 规则，粒度细于 remember_rule 的整工具放行） */
export interface ApprovalResolution {
	/** P0：question 工具的用户回答 */
	answer?: string;
	decision: "approve" | "deny";
	deny_reason?: string;
	remember_pattern?: string;
	remember_rule?: string;
}

interface PendingApproval {
	resolve: (r: ApprovalResolution) => void;
}

/** F3（v0.4）：@路径 引用展开。单文件 8KB、总量 32KB 截断；不存在的引用保留原文 */
export function expandFileRefs(text: string, cwd: string): string {
	const refs = [...text.matchAll(/@([\w./\-一-龥]+)/g)]
		.map((m) => m[1])
		.filter((r): r is string => r !== undefined);
	if (refs.length === 0) {
		return text;
	}
	const blocks: string[] = [];
	let total = 0;
	for (const ref of new Set(refs)) {
		const abs = path.resolve(cwd, ref);
		const rel = path.relative(cwd, abs);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			continue;
		}
		try {
			if (!fs.statSync(abs).isFile()) {
				continue;
			}
			const content = fs.readFileSync(abs, "utf8");
			const truncated =
				content.length > 8192
					? `${content.slice(0, 8192)}\n… [文件过长已截断]`
					: content;
			if (total + truncated.length > 32_768) {
				break;
			}
			total += truncated.length;
			blocks.push(`<file path="${rel}">\n${truncated}\n</file>`);
		} catch {
			/* 不存在/不可读 → 保留原文 */
		}
	}
	return blocks.length
		? `${text}\n\n引用文件内容：\n${blocks.join("\n\n")}`
		: text;
}

export class SessionManager {
	/** 活跃轮次的中断控制器 */
	private readonly abortControllers = new Map<string, AbortController>();
	/** 挂起中的审批：approvalId → resolver */
	private readonly pendingApprovals = new Map<string, PendingApproval>();
	/** 每会话独立的权限服务（记住的规则是会话作用域） */
	private readonly permissions = new Map<string, PermissionService>();
	/** F4（v0.4）：busy 时的消息队列（内存；FIFO，turn 结束自动出队） */
	private readonly queues = new Map<
		string,
		{
			id: string;
			text: string;
			attachments: { name: string; path: string }[];
		}[]
	>();

	private readonly store: EventStore;
	private readonly tools: ToolRegistry;
	private readonly models: RuntimeModelRegistry;
	/** P8-3：代理定义注册表（task 工具 / 自动标题共用） */
	private readonly agents: AgentRegistry;
	private readonly todos: TodoStore;

	constructor(
		store: EventStore,
		tools: ToolRegistry,
		models: RuntimeModelRegistry,
		agents: AgentRegistry = new AgentRegistry()
	) {
		this.store = store;
		this.tools = tools;
		this.models = models;
		this.agents = agents;
		this.todos = new TodoStore(async (sessionId) =>
			restoreTodosFromEvents(await this.store.readSince(sessionId, -1))
		);
	}

	async createSession(opts: {
		title?: string;
		cwd: string;
		mode: SessionMode;
		model: string;
		sandbox_level: SandboxLevel;
		/** M2：起始代理定义名（缺省为内置 build 代理） */
		agent?: string;
		/** P1-6：在独立 git worktree 中运行（并行会话写隔离）；非仓库自动降级为普通会话 */
		worktree?: boolean;
	}): Promise<SessionRecord> {
		const sessionId = randomUUID();
		// P1-6：worktree 隔离——会话 cwd 指向独立工作区（分支 agent/<short>）
		const wt = opts.worktree ? createWorktree(opts.cwd, sessionId) : null;
		const record = await this.store.createSession({
			agent: opts.agent,
			archived: false,
			caller_identity: "local-user", // 身份挂钩：个人版常量
			created_at: Date.now(),
			cwd: wt?.worktree_path ?? opts.cwd,
			forked_from: null,
			mode: opts.mode,
			model: opts.model,
			sandbox_level: opts.sandbox_level,
			session_id: sessionId,
			title: opts.title ?? `会话 ${new Date().toLocaleString("zh-CN")}`,
			worktree: wt ?? undefined,
		});
		await this.store.append({
			actor: "system",
			payload: {
				agent: record.agent,
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

	/** M5：列表项增强——附 activeCallCount（当前挂起审批数，供列表徽标展示） */
	async listSessions(): Promise<SessionRecord[]> {
		const pendingCount = new Map<string, number>();
		for (const key of this.pendingApprovals.keys()) {
			const sid = key.slice(0, key.indexOf(":"));
			pendingCount.set(sid, (pendingCount.get(sid) ?? 0) + 1);
		}
		return (await this.store.listSessions()).map((s) => ({
			...s,
			activeCallCount: pendingCount.get(s.session_id) ?? 0,
		}));
	}

	/** P0-4a：列出会话可用的斜杠命令（项目 + 全局合并） */
	async listCommands(sessionId: string): Promise<CommandDefinition[]> {
		const session = await this.store.getSession(sessionId);
		if (!session) {
			throw new Error(`会话不存在: ${sessionId}`);
		}
		return loadCommands(session.cwd);
	}

	/**
	 * P1-6：合并 worktree 分支回主分支并清理（会话 cwd 切回仓库根）。
	 * 冲突时保留 worktree 供手工处理。
	 */
	async mergeSessionWorktree(
		sessionId: string
	): Promise<{ ok: boolean; error?: string }> {
		const session = await this.store.getSession(sessionId);
		if (!session) {
			throw new Error(`会话不存在: ${sessionId}`);
		}
		if (!session.worktree) {
			return { error: "不是 worktree 隔离会话", ok: false };
		}
		if (
			session.status === "running" ||
			session.status === "awaiting_approval"
		) {
			return { error: "会话正忙，请先等待或中断", ok: false };
		}
		const wt = session.worktree;
		const r = mergeWorktree(wt);
		if (!r.ok) {
			return r;
		}
		await this.store.updateSessionConfig(sessionId, {
			cwd: wt.repo_root,
			worktree: null,
		});
		await this.store.append({
			actor: "user",
			payload: { agent: session.agent },
			session_id: sessionId,
			type: "session.config_changed",
		});
		return { ok: true };
	}

	/** P1-6：放弃 worktree（未合并改动随分支删除，会话 cwd 切回仓库根）。 */
	async discardSessionWorktree(
		sessionId: string
	): Promise<{ ok: boolean; error?: string }> {
		const session = await this.store.getSession(sessionId);
		if (!session) {
			throw new Error(`会话不存在: ${sessionId}`);
		}
		if (!session.worktree) {
			return { error: "不是 worktree 隔离会话", ok: false };
		}
		if (
			session.status === "running" ||
			session.status === "awaiting_approval"
		) {
			return { error: "会话正忙，请先等待或中断", ok: false };
		}
		const wt = session.worktree;
		const r = discardWorktree(wt);
		if (!r.ok) {
			return r;
		}
		await this.store.updateSessionConfig(sessionId, {
			cwd: wt.repo_root,
			worktree: null,
		});
		await this.store.append({
			actor: "user",
			payload: { agent: session.agent },
			session_id: sessionId,
			type: "session.config_changed",
		});
		return { ok: true };
	}

	postMessage(sessionId: string, text: string): Promise<{ queued: boolean }> {
		return this.startTurn(sessionId, text, []);
	}

	/** 上传附件：保存到工作区 .agent/attachments/<sessionId>/，返回路径 */
	async saveAttachment(
		sessionId: string,
		name: string,
		data: Buffer
	): Promise<{ name: string; path: string }> {
		const session = await this.store.getSession(sessionId);
		if (!session) {
			throw new Error(`会话不存在: ${sessionId}`);
		}
		// 防路径穿越：只取文件名部分
		const safeName =
			path.basename(name).replace(/[^\w.\-一-龥]/g, "_") || "attachment";
		const dir = path.join(session.cwd, ".agent", "attachments", sessionId);
		fs.mkdirSync(dir, { recursive: true });
		const target = path.join(dir, `${Date.now()}-${safeName}`);
		fs.writeFileSync(target, data);
		return { name: safeName, path: target };
	}

	postMessageWithAttachments(
		sessionId: string,
		text: string,
		attachments: { name: string; path: string }[]
	): Promise<{ queued: boolean }> {
		return this.startTurn(sessionId, text, attachments);
	}

	private async startTurn(
		sessionId: string,
		text: string,
		attachments: { name: string; path: string }[]
	): Promise<{ queued: boolean }> {
		const session = await this.store.getSession(sessionId);
		if (!session) {
			throw new Error(`会话不存在: ${sessionId}`);
		}
		// F4（v0.4）：busy 时排队（Steering）——落审计事件，turn 结束自动出队
		if (
			session.status === "running" ||
			session.status === "awaiting_approval"
		) {
			const queueId = randomUUID();
			const q = this.queues.get(sessionId) ?? [];
			q.push({ attachments, id: queueId, text });
			this.queues.set(sessionId, q);
			await this.store.append({
				actor: "user",
				payload: { queue_id: queueId, text },
				session_id: sessionId,
				type: "message.queued",
			});
			return { queued: true };
		}
		const adapter = this.models.get(session.model);
		if (!adapter) {
			throw new Error(`模型不可用: ${session.model}`);
		}

		// P0-4a：斜杠命令展开（~/.agent/commands、<cwd>/.agent/commands；未命中按原文）
		const cmdHit = tryExpandCommandInput(text, session.cwd);
		let expandedText = cmdHit ? cmdHit.expanded : text;

		// F3（v0.4）：@文件引用展开——存在的相对/绝对路径注入为 <file> 上下文块
		expandedText = expandFileRefs(expandedText, session.cwd);

		// 附件落事件（在轮次开始前，保证 message.user 事件带附件信息）
		const effectiveText = attachments.length
			? `${expandedText}\n\n[附件 ${attachments.length} 个，可用 read 工具读取：${attachments.map((a) => a.path).join(", ")}]`
			: expandedText;

		const permission = this.permissionFor(sessionId);
		// P8-5：项目级预置权限规则（shuyi.json permissions）在轮次开始前应用
		const projectCfg = loadProjectConfig(session.cwd);
		for (const name of projectCfg.permissions?.allow ?? []) {
			permission.rememberRule(name, "allow");
		}
		for (const name of projectCfg.permissions?.deny ?? []) {
			permission.rememberRule(name, "deny");
		}
		// M3：用户配置规则（项目 .agent/permissions.json 优先于全局 ~/.agent/permissions.json）
		const cfg = loadPermissionRules(session.cwd);
		permission.setUserConfigRules([...cfg.project, ...cfg.global]);

		const controller = new AbortController();
		this.abortControllers.set(sessionId, controller);

		// biome-ignore lint/complexity/noVoid: 轮次后台执行，完成回调里清理与出队，故意 fire-and-forget
		void runTurn(
			session,
			effectiveText,
			adapter,
			permission,
			{
				agents: this.agents,
				models: this.models,
				store: this.store,
				todos: this.todos,
				tools: this.tools,
				waitForApproval: (sid, approvalId) =>
					this.waitForApproval(sid, approvalId),
			},
			controller.signal
		).finally(() => {
			this.abortControllers.delete(sessionId);
			// P8-4：首轮完成后自动生成会话标题（失败静默，不影响主流程）
			// biome-ignore lint/complexity/noVoid: 标题生成为后台任务，故意 fire-and-forget
			void this.maybeAutoTitle(sessionId, projectCfg.auto_title);
			// F4：出队——当前轮次结束（完成/中断/失败）后自动执行下一条排队消息
			const q = this.queues.get(sessionId);
			if (q?.length) {
				const next = q.shift();
				if (next) {
					if (q.length === 0) {
						this.queues.delete(sessionId);
					}
					// 微任务延迟，让 turn.aborted/completed 状态先落定
					queueMicrotask(() => {
						this.startTurn(sessionId, next.text, next.attachments).catch(
							(err) => {
								console.error("[queue] 出队执行失败:", err);
							}
						);
					});
				}
			}
		});
		return { queued: false };
	}

	/** F4：撤回排队消息 */
	async cancelQueued(sessionId: string, queueId: string): Promise<boolean> {
		const q = this.queues.get(sessionId);
		if (!q) {
			return false;
		}
		const idx = q.findIndex((m) => m.id === queueId);
		if (idx < 0) {
			return false;
		}
		q.splice(idx, 1);
		if (q.length === 0) {
			this.queues.delete(sessionId);
		}
		await this.store.append({
			actor: "user",
			payload: { queue_id: queueId },
			session_id: sessionId,
			type: "message.queue_cancelled",
		});
		return true;
	}

	/**
	 * 自动标题（P8-4）：首轮完成后，用内置 title 代理据首条用户消息生成短标题。
	 * 仅在标题仍为默认值、且恰好完成一轮时触发；mock 模型跳过。
	 */
	private async maybeAutoTitle(
		sessionId: string,
		autoTitleCfg?: boolean
	): Promise<void> {
		try {
			if (autoTitleCfg === false) {
				return;
			}
			const session = await this.store.getSession(sessionId);
			if (!(session && DEFAULT_TITLE_RE.test(session.title))) {
				return;
			}
			const events = await this.store.readSince(sessionId, -1);
			const userMsgs = events.filter((e) => e.type === "message.user");
			const completedTurns = events.filter(
				(e) => e.type === "turn.completed"
			).length;
			if (userMsgs.length !== 1 || completedTurns !== 1) {
				return;
			}
			const adapter = this.models.get(session.model);
			if (!adapter || adapter.meta.provider === "local") {
				return; // mock 不生成标题
			}
			const titleAgent = this.agents.get("title", session.cwd);
			const [firstUserMsg] = userMsgs;
			if (!firstUserMsg) {
				return;
			}
			const firstUser = (firstUserMsg.payload as { text: string }).text.slice(
				0,
				500
			);
			const result = await adapter.streamChat(
				{
					messages: [{ content: firstUser, role: "user" }],
					model: session.model,
					system:
						titleAgent?.system ??
						"根据用户的请求，生成一个不超过 15 个字的简短中文标题。只输出标题本身。",
					tools: [],
				},
				{},
				AbortSignal.timeout(30_000)
			);
			const firstLine = result.text.trim().split("\n")[0] ?? "";
			const title = firstLine
				.replace(/^["'「『]+|["'」』。．.]+$/g, "")
				.slice(0, 30);
			if (!title) {
				return;
			}
			await this.store.updateSessionConfig(sessionId, { title });
			await this.store.append({
				actor: "system",
				payload: { title },
				session_id: sessionId,
				type: "session.titled",
			});
		} catch {
			// 标题生成失败不影响会话
		}
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
		resolution: ApprovalResolution
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
	): Promise<ApprovalResolution> {
		return new Promise((resolve) => {
			this.pendingApprovals.set(`${sessionId}:${approvalId}`, { resolve });
		});
	}

	async updateConfig(
		sessionId: string,
		patch: {
			mode?: SessionMode;
			model?: string;
			sandbox_level?: SandboxLevel;
			agent?: string;
		}
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
			agent: source.agent,
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
			// biome-ignore lint/performance/noAwaitInLoops: 分叉复制必须保序落库，不可并行
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

	/**
	 * F1（v0.4）：rewind。code = 恢复快照（write/edit 的影子拷贝；bash 变更走 git rollback）；
	 * conversation = 追加 session.rewound 事件，上下文重建与轨迹在该 seq 截断。
	 */
	async rewind(
		sessionId: string,
		toSeq: number,
		mode: "code" | "conversation" | "both"
	): Promise<{ files_restored: number }> {
		const session = await this.store.getSession(sessionId);
		if (!session) {
			throw new Error(`会话不存在: ${sessionId}`);
		}
		if (
			session.status === "running" ||
			session.status === "awaiting_approval"
		) {
			throw new Error("会话正忙，请先中断再回滚");
		}
		let filesRestored = 0;
		if (mode === "code" || mode === "both") {
			filesRestored = restoreAfter(session.cwd, sessionId, toSeq).length;
		}
		if (mode === "conversation" || mode === "both") {
			await this.store.append({
				actor: "user",
				payload: { files_restored: filesRestored, mode, to_seq: toSeq },
				session_id: sessionId,
				type: "session.rewound",
			});
		} else if (filesRestored > 0) {
			// 纯代码回滚也留审计（mode=code 不截断轨迹，仅作标记事件）
			await this.store.append({
				actor: "user",
				payload: { files_restored: filesRestored, mode, to_seq: toSeq },
				session_id: sessionId,
				type: "session.rewound",
			});
		}
		return { files_restored: filesRestored };
	}

	/** F2（v0.4）：变更面板——会话快照文件 × 当前文件的 unified diff 聚合 */
	async listChanges(
		sessionId: string
	): Promise<
		{ path: string; diff: string; additions: number; deletions: number }[]
	> {
		const session = await this.store.getSession(sessionId);
		if (!session) {
			throw new Error(`会话不存在: ${sessionId}`);
		}
		return collectChanges(session.cwd, sessionId).map((ch) => {
			const d: DiffResult = unifiedDiff(ch.path, ch.before, ch.after);
			return {
				additions: d.additions,
				deletions: d.deletions,
				diff: d.text,
				path: ch.path,
			};
		});
	}

	/** F2：审查操作（accept 丢弃快照 / revert 恢复内容），落 changes.reviewed 审计事件 */
	async reviewChange(
		sessionId: string,
		relPath: string,
		action: "accept" | "revert"
	): Promise<{ ok: boolean; error?: string }> {
		const session = await this.store.getSession(sessionId);
		if (!session) {
			throw new Error(`会话不存在: ${sessionId}`);
		}
		if (
			session.status === "running" ||
			session.status === "awaiting_approval"
		) {
			return { error: "会话正忙，请先等待或中断", ok: false };
		}
		const r = reviewChange(session.cwd, sessionId, relPath, action);
		if (r.ok) {
			await this.store.append({
				actor: "user",
				payload: { action, path: relPath },
				session_id: sessionId,
				type: "changes.reviewed",
			});
		}
		return r;
	}

	/** F5（v0.4）：批准计划——切 build 模式并立即开工（可附修订后的计划文本） */
	async approvePlan(sessionId: string, revisedText?: string): Promise<void> {
		const session = await this.store.getSession(sessionId);
		if (!session) {
			throw new Error(`会话不存在: ${sessionId}`);
		}
		if (
			session.status === "running" ||
			session.status === "awaiting_approval"
		) {
			throw new Error("会话正忙");
		}
		await this.updateConfig(sessionId, { mode: "build" });
		await this.postMessage(
			sessionId,
			revisedText
				? `计划（已修订）已批准，请严格按以下计划执行：\n\n${revisedText}`
				: "计划已批准，请按计划开始执行。"
		);
	}

	/** F3（v0.4）：@ 补全数据源——cwd 下文件模糊搜索（忽略重型目录，前 20 条） */
	async listFiles(sessionId: string, query: string): Promise<string[]> {
		const session = await this.store.getSession(sessionId);
		if (!session) {
			throw new Error(`会话不存在: ${sessionId}`);
		}
		const IGNORE = new Set([
			"node_modules",
			".git",
			".agent",
			"dist",
			"build",
			".cache",
			"coverage",
		]);
		const q = query.toLowerCase();
		const hits: string[] = [];
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: 目录遍历限流（深度/数量/忽略目录），平移自 v0.x 成熟实现，保持 1:1
		const walk = (dir: string, depth: number): void => {
			if (hits.length >= 20 || depth > 6) {
				return;
			}
			let ents: fs.Dirent[];
			try {
				ents = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const ent of ents) {
				if (hits.length >= 20) {
					return;
				}
				if (ent.name.startsWith(".") && ent.name !== ".") {
					continue;
				}
				const full = path.join(dir, ent.name);
				const rel = path.relative(session.cwd, full);
				if (ent.isDirectory()) {
					if (!IGNORE.has(ent.name)) {
						walk(full, depth + 1);
					}
				} else if (!q || rel.toLowerCase().includes(q)) {
					hits.push(rel);
				}
			}
		};
		walk(session.cwd, 0);
		return hits;
	}

	/**
	 * 回滚工作区到某一轮开始时的状态（git reset 到该轮的 base_commit）。
	 * 事件日志保持 append-only：不删除任何事件，只追加 turn.rollback 记录。
	 */
	async rollback(sessionId: string, commit: string): Promise<void> {
		const session = await this.store.getSession(sessionId);
		if (!session) {
			throw new Error(`会话不存在: ${sessionId}`);
		}
		if (
			session.status === "running" ||
			session.status === "awaiting_approval"
		) {
			throw new Error("会话正忙，请先中断再回滚");
		}
		const result = rollbackTo(session.cwd, commit);
		if (!result.ok) {
			throw new Error(result.error ?? "回滚失败");
		}
		await this.store.append({
			actor: "user",
			payload: { commit },
			session_id: sessionId,
			type: "turn.rollback",
		});
	}

	/** headless/脚本场景：预放行指定工具（等价于逐个「本会话放行」） */
	rememberAllowAll(sessionId: string, toolNames: string[]): void {
		const p = this.permissionFor(sessionId);
		for (const name of toolNames) {
			p.rememberRule(name, "allow");
		}
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
