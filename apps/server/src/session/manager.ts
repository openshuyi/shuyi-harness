/**
 * 会话管理：生命周期（创建/恢复/分叉/删除）+ 活跃 Loop 注册表。
 * 恢复 = 事件日志已在库中，Loop 下次 runTurn 时 rebuild 即恢复上下文；
 *       服务端重启后无需特殊动作——这正是事件日志是唯一事实来源的含义。
 */
import { randomUUID } from "node:crypto";
import type { SessionMode, SandboxLevel, SessionRecord } from "@shuyi/types";
import type { EventStore } from "../store/event-store.js";
import type { ToolRegistry } from "../tools/index.js";
import type { PermissionService } from "../permission/index.js";
import { PermissionService as PermissionServiceImpl } from "../permission/index.js";
import type { RuntimeModelRegistry } from "../model/registry.js";
import { runTurn } from "../loop/index.js";

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
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    if (session.status === "running" || session.status === "awaiting_approval") {
      throw new Error("会话正忙，请先中断或等待当前轮次结束");
    }
    const adapter = this.models.get(session.model);
    if (!adapter) throw new Error(`模型不可用: ${session.model}`);

    const permission = this.permissionFor(sessionId);
    const controller = new AbortController();
    this.abortControllers.set(sessionId, controller);

    // 异步跑轮次；错误已由 Loop 内部落 error.occurred 事件
    void runTurn(session, text, adapter, permission, {
      store: this.store,
      tools: this.tools,
      waitForApproval: (sid, approvalId) => this.waitForApproval(sid, approvalId),
    }, controller.signal).finally(() => {
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

  private permissionFor(sessionId: string): PermissionService {
    let p = this.permissions.get(sessionId);
    if (!p) {
      p = new PermissionServiceImpl();
      this.permissions.set(sessionId, p);
    }
    return p;
  }
}
