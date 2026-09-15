/**
 * 会话管理：生命周期（创建/恢复/分叉/删除）+ 活跃 Loop 注册表。
 * 恢复 = 事件日志已在库中，Loop 下次 runTurn 时 rebuild 即恢复上下文；
 *       服务端重启后无需特殊动作——这正是事件日志是唯一事实来源的含义。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionMode, SandboxLevel, SessionRecord } from "@shuyi/types";
import type { EventStore } from "../store/event-store.js";
import type { ToolRegistry } from "../tools/index.js";
import type { PermissionService } from "../permission/index.js";
import { PermissionService as PermissionServiceImpl } from "../permission/index.js";
import type { RuntimeModelRegistry } from "../model/registry.js";
import { runTurn } from "../loop/index.js";
import { rollbackTo } from "../git/index.js";
import { AgentRegistry } from "../agents/index.js";
import { loadProjectConfig } from "../config/project.js";

interface PendingApproval {
  resolve: (r: { decision: "approve" | "deny"; remember_rule?: string; deny_reason?: string }) => void;
}

export class SessionManager {
  /** 活跃轮次的中断控制器 */
  private abortControllers = new Map<string, AbortController>();
  /** 挂起中的审批：approvalId → resolver */
  private pendingApprovals = new Map<string, PendingApproval>();
  /** 每会话独立的权限服务（记住的规则是会话作用域） */
  private permissions = new Map<string, PermissionService>();

  constructor(
    private store: EventStore,
    private tools: ToolRegistry,
    private models: RuntimeModelRegistry,
    /** P8-3：代理定义注册表（task 工具 / 自动标题共用） */
    private agents: AgentRegistry = new AgentRegistry(),
  ) {}

  createSession(opts: {
    title?: string;
    cwd: string;
    mode: SessionMode;
    model: string;
    sandbox_level: SandboxLevel;
  }): SessionRecord {
    const sessionId = randomUUID();
    const record = this.store.createSession({
      session_id: sessionId,
      title: opts.title ?? `会话 ${new Date().toLocaleString("zh-CN")}`,
      cwd: opts.cwd,
      mode: opts.mode,
      model: opts.model,
      sandbox_level: opts.sandbox_level,
      created_at: Date.now(),
      archived: false,
      forked_from: null,
      caller_identity: "local-user", // 身份挂钩：个人版常量
    });
    this.store.append({
      session_id: sessionId,
      type: "session.created",
      actor: "system",
      payload: {
        title: record.title,
        cwd: record.cwd,
        mode: record.mode,
        model: record.model,
        sandbox_level: record.sandbox_level,
      },
    });
    return this.store.getSession(sessionId)!;
  }

  getSession(sessionId: string): SessionRecord | null {
    return this.store.getSession(sessionId);
  }

  listSessions(): SessionRecord[] {
    return this.store.listSessions();
  }

  postMessage(sessionId: string, text: string): void {
    this.startTurn(sessionId, text, []);
  }

  /** 上传附件：保存到工作区 .agent/attachments/<sessionId>/，返回路径 */
  saveAttachment(sessionId: string, name: string, data: Buffer): { name: string; path: string } {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    // 防路径穿越：只取文件名部分
    const safeName = path.basename(name).replace(/[^\w.\-一-龥]/g, "_") || "attachment";
    const dir = path.join(session.cwd, ".agent", "attachments", sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${Date.now()}-${safeName}`);
    fs.writeFileSync(target, data);
    return { name: safeName, path: target };
  }

  postMessageWithAttachments(
    sessionId: string,
    text: string,
    attachments: { name: string; path: string }[],
  ): void {
    this.startTurn(sessionId, text, attachments);
  }

  private startTurn(
    sessionId: string,
    text: string,
    attachments: { name: string; path: string }[],
  ): void {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    if (session.status === "running" || session.status === "awaiting_approval") {
      throw new Error("会话正忙，请先中断或等待当前轮次结束");
    }
    const adapter = this.models.get(session.model);
    if (!adapter) throw new Error(`模型不可用: ${session.model}`);

    // 附件落事件（在轮次开始前，保证 message.user 事件带附件信息）
    const effectiveText = attachments.length
      ? `${text}\n\n[附件 ${attachments.length} 个，可用 read 工具读取：${attachments.map((a) => a.path).join(", ")}]`
      : text;

    const permission = this.permissionFor(sessionId);
    // P8-5：项目级预置权限规则（shuyi.json permissions）在轮次开始前应用
    const projectCfg = loadProjectConfig(session.cwd);
    for (const name of projectCfg.permissions?.allow ?? []) permission.rememberRule(name, "allow");
    for (const name of projectCfg.permissions?.deny ?? []) permission.rememberRule(name, "deny");

    const controller = new AbortController();
    this.abortControllers.set(sessionId, controller);

    void runTurn(session, effectiveText, adapter, permission, {
      store: this.store,
      tools: this.tools,
      waitForApproval: (sid, approvalId) => this.waitForApproval(sid, approvalId),
      agents: this.agents,
      models: this.models,
    }, controller.signal).finally(() => {
      this.abortControllers.delete(sessionId);
      // P8-4：首轮完成后自动生成会话标题（失败静默，不影响主流程）
      void this.maybeAutoTitle(sessionId, projectCfg.auto_title);
    });
  }

  /**
   * 自动标题（P8-4）：首轮完成后，用内置 title 代理据首条用户消息生成短标题。
   * 仅在标题仍为默认值、且恰好完成一轮时触发；mock 模型跳过。
   */
  private async maybeAutoTitle(sessionId: string, autoTitleCfg?: boolean): Promise<void> {
    try {
      if (autoTitleCfg === false) return;
      const session = this.store.getSession(sessionId);
      if (!session || !/^会话 \d/.test(session.title)) return;
      const events = this.store.readSince(sessionId, -1);
      const userMsgs = events.filter((e) => e.type === "message.user");
      const completedTurns = events.filter((e) => e.type === "turn.completed").length;
      if (userMsgs.length !== 1 || completedTurns !== 1) return;
      const adapter = this.models.get(session.model);
      if (!adapter || adapter.meta.provider === "local") return; // mock 不生成标题
      const titleAgent = this.agents.get("title", session.cwd);
      const firstUser = (userMsgs[0].payload as { text: string }).text.slice(0, 500);
      const result = await adapter.streamChat(
        {
          model: session.model,
          system:
            titleAgent?.system ??
            "根据用户的请求，生成一个不超过 15 个字的简短中文标题。只输出标题本身。",
          messages: [{ role: "user", content: firstUser }],
          tools: [],
        },
        {},
        AbortSignal.timeout(30_000),
      );
      const title = result.text
        .trim()
        .split("\n")[0]
        .replace(/^["'「『]+|["'」』。．.]+$/g, "")
        .slice(0, 30);
      if (!title) return;
      this.store.updateSessionConfig(sessionId, { title });
      this.store.append({
        session_id: sessionId,
        type: "session.titled",
        actor: "system",
        payload: { title },
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
    resolution: { decision: "approve" | "deny"; remember_rule?: string; deny_reason?: string },
  ): boolean {
    const key = `${sessionId}:${approvalId}`;
    const pending = this.pendingApprovals.get(key);
    if (!pending) return false;
    pending.resolve(resolution);
    this.pendingApprovals.delete(key);
    return true;
  }

  private waitForApproval(
    sessionId: string,
    approvalId: string,
  ): Promise<{ decision: "approve" | "deny"; remember_rule?: string; deny_reason?: string }> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(`${sessionId}:${approvalId}`, { resolve });
    });
  }

  updateConfig(
    sessionId: string,
    patch: { mode?: SessionMode; model?: string; sandbox_level?: SandboxLevel },
  ): void {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    this.store.updateSessionConfig(sessionId, patch);
    this.store.append({
      session_id: sessionId,
      type: "session.config_changed",
      actor: "user",
      payload: patch,
    });
    // 模式变化影响「记住的规则」语义，清空避免越权
    if (patch.mode || patch.sandbox_level) this.permissionFor(sessionId).clearRules();
  }

  fork(sessionId: string, atSeq: number): SessionRecord {
    const source = this.store.getSession(sessionId);
    if (!source) throw new Error(`会话不存在: ${sessionId}`);
    const fork = this.createSession({
      title: `${source.title}（分叉）`,
      cwd: source.cwd,
      mode: source.mode,
      model: source.model,
      sandbox_level: source.sandbox_level,
    });
    // 复制 [0, atSeq] 事件（session.created 事件除外，新会话已有自己的）
    const events = this.store.readRange(sessionId, 0, atSeq);
    for (const e of events) {
      if (e.type === "session.created") continue;
      this.store.append({
        session_id: fork.session_id,
        type: e.type,
        actor: e.actor,
        turn_id: e.turn_id,
        causation_id: e.causation_id,
        payload: e.payload,
      } as never);
    }
    this.store.append({
      session_id: fork.session_id,
      type: "session.forked",
      actor: "user",
      payload: { from_session_id: sessionId, fork_at_seq: atSeq },
    });
    return this.store.getSession(fork.session_id)!;
  }

  archive(sessionId: string): void {
    this.store.updateSessionConfig(sessionId, { archived: true });
    this.store.append({
      session_id: sessionId,
      type: "session.archived",
      actor: "user",
      payload: {},
    });
  }

  /**
   * 回滚工作区到某一轮开始时的状态（git reset 到该轮的 base_commit）。
   * 事件日志保持 append-only：不删除任何事件，只追加 turn.rollback 记录。
   */
  rollback(sessionId: string, commit: string): void {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    if (session.status === "running" || session.status === "awaiting_approval") {
      throw new Error("会话正忙，请先中断再回滚");
    }
    const result = rollbackTo(session.cwd, commit);
    if (!result.ok) throw new Error(result.error ?? "回滚失败");
    this.store.append({
      session_id: sessionId,
      type: "turn.rollback",
      actor: "user",
      payload: { commit },
    });
  }

  /** headless/脚本场景：预放行指定工具（等价于逐个「本会话放行」） */
  rememberAllowAll(sessionId: string, toolNames: string[]): void {
    const p = this.permissionFor(sessionId);
    for (const name of toolNames) p.rememberRule(name, "allow");
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
