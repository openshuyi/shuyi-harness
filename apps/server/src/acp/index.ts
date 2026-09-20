/**
 * M6：ACP（Agent Client Protocol）服务端——JSON-RPC 2.0 over stdio（ndjson）。
 * 对齐 ACP v1 schema（agentclientprotocol.com，2026-09）：
 *
 *   Client → Agent 方法：initialize / session/new / session/prompt / session/set_mode
 *   Client → Agent 通知：session/cancel
 *   Agent → Client 通知：session/update（agent_message_chunk / agent_thought_chunk /
 *                        tool_call / tool_call_update / plan / current_mode_update /
 *                        available_commands_update / usage_update）
 *   Agent → Client 请求：session/request_permission（权限桥接：我们的审批流 ↔ 客户端弹窗）
 *
 * 设计：协议层与传输层分离——AcpServer 纯内存实现（handleMessage 进、write 回调出），
 * stdio.ts 只负责换行分隔 JSON 的读写。事件→SessionUpdate 是单向纯映射。
 *
 * 复用全部服务端语义：同一 SessionManager/事件总线/权限链/工具面——
 * ACP 只是核心 Loop 的又一个投影（架构原则：未来所有入口都是同一服务端的投影）。
 */
import type { AgentEvent } from "@shuyi/types";
import type { EventBus } from "../bus/index.js";
import type { SqliteEventStore } from "../store/event-store.js";
import type { SessionManager } from "../session/manager.js";
import type { RuntimeModelRegistry } from "../model/registry.js";
import { loadProjectConfig } from "../config/project.js";
import { loadCommands } from "../commands/index.js";

// ---------- 极简 JSON-RPC 类型 ----------
interface JsonRpcRequest { jsonrpc: "2.0"; id: number | string; method: string; params?: Record<string, unknown> }
interface JsonRpcNotification { jsonrpc: "2.0"; method: string; params?: Record<string, unknown> }
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}
type OutMsg = JsonRpcResponse | JsonRpcNotification | JsonRpcRequest;

class AcpError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

/** 工具 → ACP kind 映射（客户端图标/渲染提示） */
function toolKind(tool: string): string {
  switch (tool) {
    case "read":
      return "read";
    case "write":
    case "edit":
    case "memory_write":
      return "edit";
    case "bash":
    case "bash_status":
    case "bash_kill":
      return "execute";
    case "glob":
    case "grep":
      return "search";
    case "webfetch":
    case "websearch":
      return "fetch";
    default:
      return "other";
  }
}

/** tool_call 标题：工具名 + 关键参数摘要 */
function toolTitle(tool: string, args: Record<string, unknown>): string {
  const target = (args.path ?? args.command ?? args.query ?? args.url ?? args.name ?? "") as string;
  return target ? `${tool} ${String(target).slice(0, 80)}` : tool;
}

/** 从参数提取 locations（客户端 follow-along） */
function toolLocations(args: Record<string, unknown>): { path: string }[] | undefined {
  const p = args.path as string | undefined;
  return p ? [{ path: p }] : undefined;
}

export interface AcpDeps {
  store: SqliteEventStore;
  bus: EventBus;
  sessions: SessionManager;
  models: RuntimeModelRegistry;
}

export class AcpServer {
  private nextRequestId = 1;
  /** 我们发给客户端的请求（session/request_permission）等待中：id → 处理回调 */
  private pendingClientRequests = new Map<
    number | string,
    (result: unknown) => void
  >();
  /** session/prompt 等待轮次结束：sessionId → stopReason 回调 */
  private promptWaiters = new Map<string, (stopReason: string) => void>();
  /** ACP 会话元数据 */
  private acpSessions = new Map<string, { cwd: string }>();

  constructor(
    private deps: AcpDeps,
    private write: (msg: OutMsg) => void,
  ) {
    deps.bus.subscribe((e) => this.onAgentEvent(e));
  }

  /** 入口：一条 ndjson 消息（请求/通知/响应）。 */
  async handleMessage(msg: Record<string, unknown>): Promise<void> {
    // 客户端响应（我们发出的 request_permission 的回包）
    if (!msg.method && msg.id !== undefined && ("result" in msg || "error" in msg)) {
      const pending = this.pendingClientRequests.get(msg.id as number | string);
      this.pendingClientRequests.delete(msg.id as number | string);
      pending?.(msg.error ?? msg.result);
      return;
    }
    if (typeof msg.method !== "string") return;
    if (msg.id !== undefined) {
      // 请求 → 必须回响应
      try {
        const result = await this.dispatch(
          msg as unknown as JsonRpcRequest,
        );
        this.write({ jsonrpc: "2.0", id: msg.id as number | string, result });
      } catch (err) {
        this.write({
          jsonrpc: "2.0",
          id: msg.id as number | string,
          error: {
            code: err instanceof AcpError ? err.code : -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    } else {
      // 通知 → 无响应
      try {
        this.dispatchNotification(msg as unknown as JsonRpcNotification);
      } catch {
        // 通知处理失败静默（协议不允许回错误）
      }
    }
  }

  private async dispatch(req: JsonRpcRequest): Promise<unknown> {
    const p = (req.params ?? {}) as Record<string, unknown>;
    switch (req.method) {
      case "initialize":
        return this.onInitialize(p);
      case "session/new":
        return this.onSessionNew(p);
      case "session/prompt":
        return this.onSessionPrompt(p);
      case "session/set_mode":
        return this.onSetMode(p);
      case "authenticate":
        return {}; // authMethods 为空，客户端不应走到这
      default:
        throw new AcpError(-32601, "Method not found");
    }
  }

  private dispatchNotification(msg: JsonRpcNotification): void {
    const p = (msg.params ?? {}) as Record<string, unknown>;
    if (msg.method === "session/cancel") {
      const sid = p.sessionId as string;
      if (sid) this.deps.sessions.abort(sid);
    }
  }

  // ---------- 方法实现 ----------

  private onInitialize(p: Record<string, unknown>): unknown {
    return {
      // 回显客户端版本（我们兼容 v1 全部基线方法）
      protocolVersion: p.protocolVersion ?? 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
      agentInfo: { name: "shuyi-agent", version: "0.3.1" },
    };
  }

  private onSessionNew(p: Record<string, unknown>): unknown {
    const cwd = p.cwd as string;
    if (!cwd) throw new AcpError(-32602, "session/new 缺少 cwd");
    // 模型分层解析（与 HTTP API 一致）：项目 shuyi.json → 注册表默认
    const configured = loadProjectConfig(cwd).model;
    const model =
      configured && this.deps.models.get(configured) ? configured : this.deps.models.defaultModel;
    const session = this.deps.sessions.createSession({
      cwd,
      mode: "build",
      model,
      sandbox_level: "workspace",
    });
    this.acpSessions.set(session.session_id, { cwd });

    // 可用斜杠命令 → available_commands_update（ACP 原生渲染为客户端命令面板）
    const commands = loadCommands(cwd);
    if (commands.length) {
      this.notify(session.session_id, {
        sessionUpdate: "available_commands_update",
        availableCommands: commands.map((c) => ({ name: c.name, description: c.description })),
      });
    }

    return {
      sessionId: session.session_id,
      modes: {
        availableModes: [
          { id: "build", name: "Build（完整工具）" },
          { id: "plan", name: "Plan（只读规划）" },
        ],
        currentModeId: "build",
      },
    };
  }

  private async onSessionPrompt(p: Record<string, unknown>): Promise<unknown> {
    const sid = p.sessionId as string;
    if (!sid || !this.acpSessions.has(sid)) throw new AcpError(-32602, "未知 sessionId");
    const blocks = (p.prompt ?? []) as { type?: string; text?: string }[];
    const text = blocks
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    if (!text.trim()) throw new AcpError(-32602, "prompt 缺少 text 内容块");

    const stopReason = new Promise<string>((resolve) => {
      this.promptWaiters.set(sid, resolve);
    });
    try {
      this.deps.sessions.postMessage(sid, text);
    } catch (err) {
      this.promptWaiters.delete(sid);
      throw new AcpError(-32603, err instanceof Error ? err.message : String(err));
    }
    return { stopReason: await stopReason };
  }

  private onSetMode(p: Record<string, unknown>): unknown {
    const sid = p.sessionId as string;
    const modeId = p.modeId as string;
    if (!sid || !this.acpSessions.has(sid)) throw new AcpError(-32602, "未知 sessionId");
    if (modeId !== "plan" && modeId !== "build") throw new AcpError(-32602, `未知 modeId: ${modeId}`);
    this.deps.sessions.updateConfig(sid, { mode: modeId });
    return {};
  }

  // ---------- 事件 → SessionUpdate 纯映射 ----------

  private notify(sessionId: string, update: Record<string, unknown>): void {
    this.write({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    });
  }

  private onAgentEvent(e: AgentEvent): void {
    const sid = e.session_id;
    if (!this.acpSessions.has(sid)) return;
    const p = e.payload as Record<string, unknown>;

    switch (e.type) {
      case "message.assistant.delta":
        this.notify(sid, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: p.text_delta },
        });
        break;
      case "message.assistant.thinking_delta":
        this.notify(sid, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: p.text_delta },
        });
        break;
      case "tool.call.proposed": {
        const args = (p.args ?? {}) as Record<string, unknown>;
        this.notify(sid, {
          sessionUpdate: "tool_call",
          toolCallId: p.call_id,
          title: toolTitle(p.tool as string, args),
          kind: toolKind(p.tool as string),
          status: "pending",
          rawInput: args,
          locations: toolLocations(args),
        });
        break;
      }
      case "tool.call.started":
        this.notify(sid, {
          sessionUpdate: "tool_call_update",
          toolCallId: p.call_id,
          status: "in_progress",
        });
        break;
      case "tool.call.completed":
        this.notify(sid, {
          sessionUpdate: "tool_call_update",
          toolCallId: p.call_id,
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: String(p.result ?? "").slice(0, 4000) },
            },
          ],
        });
        break;
      case "tool.call.failed":
        this.notify(sid, {
          sessionUpdate: "tool_call_update",
          toolCallId: p.call_id,
          status: "failed",
          content: [
            {
              type: "content",
              content: { type: "text", text: String(p.error ?? "").slice(0, 2000) },
            },
          ],
        });
        break;
      case "approval.requested":
        this.bridgePermission(sid, p);
        break;
      case "todo.list_updated": {
        const todos = (p.todos ?? []) as { content: string; status: string; priority?: string }[];
        this.notify(sid, {
          sessionUpdate: "plan",
          entries: todos.map((t) => ({
            content: t.content,
            status: t.status,
            priority: t.priority ?? "medium",
          })),
        });
        break;
      }
      case "turn.completed": {
        const usage = (p.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
        const model = this.deps.models.get(this.deps.store.getSession(sid)?.model ?? "");
        this.notify(sid, {
          sessionUpdate: "usage_update",
          used: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
          size: model?.meta.contextWindow ?? 0,
        });
        this.promptWaiters.get(sid)?.("end_turn");
        this.promptWaiters.delete(sid);
        break;
      }
      case "turn.aborted":
        this.promptWaiters.get(sid)?.("cancelled");
        this.promptWaiters.delete(sid);
        break;
      case "session.config_changed":
        if (p.mode) {
          this.notify(sid, { sessionUpdate: "current_mode_update", modeId: p.mode });
        }
        break;
      default:
        break; // 其余事件无 ACP 对应物
    }
  }

  // ---------- 权限桥接：approval.requested → session/request_permission ----------

  private bridgePermission(sid: string, p: Record<string, unknown>): void {
    // 关键时序：本方法由 bus 同步派发（Loop 的 store.append 调用栈内）触发，
    // 而 Loop 的 waitForApproval 尚未注册 resolver——若客户端（尤其进程内 mock）
    // 同步回包，resolveApproval 会扑空导致轮次永久挂起。
    // 推迟到下一个事件循环，保证挂起注册先于任何可能的客户端响应。
    setTimeout(() => this.sendPermissionRequest(sid, p), 0);
  }

  private sendPermissionRequest(sid: string, p: Record<string, unknown>): void {
    const approvalId = p.approval_id as string;
    const tool = p.tool as string;
    const args = (p.args ?? {}) as Record<string, unknown>;
    const isQuestion = tool === "question";

    // question 工具：选项映射为 ACP 选项；自由文本超出 ACP 表达能力（选项即答案）
    const questionOptions = ((args.options as string[] | undefined) ?? []).map((o, i) => ({
      optionId: `opt_${i}`,
      name: o,
      kind: "allow_once" as const,
    }));
    const options = isQuestion
      ? [...questionOptions, { optionId: "reject", name: "拒绝回答", kind: "reject_once" as const }]
      : [
          { optionId: "allow", name: "允许", kind: "allow_once" as const },
          { optionId: "always", name: "本会话总是允许", kind: "allow_always" as const },
          { optionId: "reject", name: "拒绝", kind: "reject_once" as const },
        ];

    const reqId = this.nextRequestId++;
    this.pendingClientRequests.set(reqId, (result) => {
      const outcome = (result as { outcome?: { outcome?: string; optionId?: string } })?.outcome;
      const sessions = this.deps.sessions;
      if (!outcome || outcome.outcome === "cancelled") {
        sessions.resolveApproval(sid, approvalId, {
          decision: "deny",
          deny_reason: "客户端取消",
        });
        return;
      }
      const optionId = outcome.optionId ?? "";
      if (isQuestion) {
        if (optionId.startsWith("opt_")) {
          const idx = Number(optionId.slice(4));
          const answer = ((args.options as string[] | undefined) ?? [])[idx] ?? "";
          sessions.resolveApproval(sid, approvalId, { decision: "approve", answer });
        } else {
          sessions.resolveApproval(sid, approvalId, { decision: "deny", deny_reason: "用户拒绝回答" });
        }
        return;
      }
      if (optionId === "reject") {
        sessions.resolveApproval(sid, approvalId, { decision: "deny", deny_reason: "用户拒绝" });
      } else {
        sessions.resolveApproval(sid, approvalId, {
          decision: "approve",
          remember_rule: optionId === "always" ? "allow" : undefined,
        });
      }
    });

    this.write({
      jsonrpc: "2.0",
      id: reqId,
      method: "session/request_permission",
      params: {
        sessionId: sid,
        toolCall: {
          toolCallId: p.call_id,
          title: (p.risk_summary as string) ?? toolTitle(tool, args),
          kind: toolKind(tool),
          status: "pending",
          rawInput: args,
          locations: toolLocations(args),
        },
        options,
      },
    });
  }
}
