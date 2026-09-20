/**
 * 事件模型 v1 —— 全系统第一份契约。
 * 对应文档：《编码智能体-事件模型设计.md》
 * 演进规则：只增不改。新增事件类型直接追加；payload 只加可选字段。
 */
import { z } from "zod";

// ---------- 基础枚举 ----------
export const Actor = z.enum(["user", "agent", "system"]);
export type Actor = z.infer<typeof Actor>;

export const SessionMode = z.enum(["plan", "build"]);
export type SessionMode = z.infer<typeof SessionMode>;

export const SandboxLevel = z.enum(["readonly", "workspace", "full"]);
export type SandboxLevel = z.infer<typeof SandboxLevel>;

export const SessionStatus = z.enum(["idle", "running", "awaiting_approval"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

// ---------- Payload 定义 ----------

// 会话生命周期
export const SessionCreatedPayload = z.object({
  title: z.string(),
  cwd: z.string(),
  mode: SessionMode,
  model: z.string(),
  sandbox_level: SandboxLevel,
  /** v0.3 / M2 新增：会话绑定的代理定义名（缺省为内置 build 代理） */
  agent: z.string().optional(),
});
export const SessionConfigChangedPayload = z.object({
  mode: SessionMode.optional(),
  model: z.string().optional(),
  sandbox_level: SandboxLevel.optional(),
  /** v0.3 / M2 新增：切换当前代理 */
  agent: z.string().optional(),
});
export const SessionForkedPayload = z.object({
  from_session_id: z.string(),
  fork_at_seq: z.number().int(),
});
export const SessionArchivedPayload = z.object({});

// 消息与流式输出
export const MessageUserPayload = z.object({
  text: z.string(),
  attachments: z.array(z.object({ name: z.string(), path: z.string() })).optional(),
});
export const AssistantDeltaPayload = z.object({ text_delta: z.string() });
export const AssistantThinkingDeltaPayload = z.object({ thinking_delta: z.string() });
export const AssistantCompletedPayload = z.object({
  text: z.string(),
  thinking: z.string().optional(),
  finish_reason: z.string(),
});

// 工具调用
export const ToolCallProposedPayload = z.object({
  call_id: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  permission_hint: z.enum(["allow", "ask", "deny"]),
});
export const ApprovalRequestedPayload = z.object({
  approval_id: z.string(),
  call_id: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  risk_summary: z.string(),
});
export const ApprovalResolvedPayload = z.object({
  approval_id: z.string(),
  decision: z.enum(["approve", "deny"]),
  remember_rule: z.string().optional(),
  /** M3：可选新增字段——记住的 glob 规则（事件模型只增不改，回放端可忽略） */
  remember_pattern: z.string().optional(),
  deny_reason: z.string().optional(),
  /** P0：question 工具的用户回答（事件模型只增不改） */
  answer: z.string().optional(),
});
export const ToolCallStartedPayload = z.object({ call_id: z.string() });
export const ToolCallOutputDeltaPayload = z.object({ call_id: z.string(), chunk: z.string() });
export const ToolCallCompletedPayload = z.object({
  call_id: z.string(),
  result: z.string(),
  truncated: z.boolean(),
  blob_path: z.string().optional(),
  duration_ms: z.number(),
  side_effects: z
    .object({
      files_written: z.array(z.string()).optional(),
      diff: z.string().optional(),
      commit: z.string().optional(),
    })
    .optional(),
});
export const ToolCallFailedPayload = z.object({
  call_id: z.string(),
  error: z.string(),
  duration_ms: z.number(),
});

// 上下文与记忆
export const ContextAssembledPayload = z.object({
  prefix_hash: z.string(),
  message_count: z.number().int(),
  token_estimate: z.number().int(),
  model: z.string(),
});
export const ContextCompactedPayload = z.object({
  summary: z.object({
    session_intent: z.string(),
    files_modified: z.array(z.string()),
    key_decisions: z.array(z.string()),
    active_goals: z.array(z.string()),
    next_steps: z.string(),
  }),
  covers_until_seq: z.number().int(),
  tokens_before: z.number().int(),
  tokens_after: z.number().int(),
});
export const MemoryWrittenPayload = z.object({
  file: z.string(),
  excerpt: z.string(),
  reason: z.string(),
});

// 任务清单（v0.3 / M1 新增）
export const TodoItem = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  priority: z.enum(["high", "medium", "low"]).optional(),
});
export type TodoItem = z.infer<typeof TodoItem>;
export const TodoListUpdatedPayload = z.object({
  todos: z.array(TodoItem),
});

// 子代理（v1.1 新增）
export const SubagentStartedPayload = z.object({
  task: z.string(),
  parent_call_id: z.string(),
});
export const SubagentCompletedPayload = z.object({
  task: z.string(),
  parent_call_id: z.string(),
  summary_excerpt: z.string(),
  duration_ms: z.number(),
});

// 轮次与状态
export const TurnStartedPayload = z.object({
  /** 轮次开始时工作区的 git HEAD（回滚基线；非仓库时缺省） */
  base_commit: z.string().optional(),
});
export const TurnCompletedPayload = z.object({
  usage: z.object({
    prompt_tokens: z.number().int(),
    completion_tokens: z.number().int(),
    cached_tokens: z.number().int().optional(),
  }),
  cost_estimate: z.number().optional(),
  model: z.string(),
});
export const TurnAbortedPayload = z.object({ reason: z.string() });
export const TurnRollbackPayload = z.object({
  /** 回滚目标提交（某轮的 base_commit） */
  commit: z.string(),
  /** 回滚涉及的轮次数（从目标轮次到当前） */
  turns_reverted: z.number().int().optional(),
});
export const SessionStatusChangedPayload = z.object({ status: SessionStatus });
/** 自动标题（P8-4）：首轮结束后由 title 代理生成 */
export const SessionTitledPayload = z.object({ title: z.string() });
export const ErrorOccurredPayload = z.object({
  scope: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
/** P1-5：hook 执行审计（.agent/hooks/ 下可执行文件，shuyi.json hooks:true 开启） */
export const HookExecutedPayload = z.object({
  hook: z.string(),
  point: z.enum(["tool.execute.before", "tool.execute.after", "event"]),
  exit_code: z.number().int(),
  duration_ms: z.number(),
  timed_out: z.boolean(),
  /** before hook 阻止工具执行时的原因（stderr） */
  blocked_reason: z.string().optional(),
  stderr_excerpt: z.string().optional(),
});

// ---------- 事件类型注册表 ----------
export const EventPayloads = {
  "session.created": SessionCreatedPayload,
  "session.config_changed": SessionConfigChangedPayload,
  "session.forked": SessionForkedPayload,
  "session.archived": SessionArchivedPayload,
  "message.user": MessageUserPayload,
  "message.assistant.delta": AssistantDeltaPayload,
  "message.assistant.thinking_delta": AssistantThinkingDeltaPayload,
  "message.assistant.completed": AssistantCompletedPayload,
  "tool.call.proposed": ToolCallProposedPayload,
  "approval.requested": ApprovalRequestedPayload,
  "approval.resolved": ApprovalResolvedPayload,
  "tool.call.started": ToolCallStartedPayload,
  "tool.call.output_delta": ToolCallOutputDeltaPayload,
  "tool.call.completed": ToolCallCompletedPayload,
  "tool.call.failed": ToolCallFailedPayload,
  "context.request.assembled": ContextAssembledPayload,
  "context.compacted": ContextCompactedPayload,
  "memory.written": MemoryWrittenPayload,
  "todo.list_updated": TodoListUpdatedPayload,
  "subagent.started": SubagentStartedPayload,
  "subagent.completed": SubagentCompletedPayload,
  "turn.started": TurnStartedPayload,
  "turn.completed": TurnCompletedPayload,
  "turn.aborted": TurnAbortedPayload,
  "turn.rollback": TurnRollbackPayload,
  "session.status_changed": SessionStatusChangedPayload,
  "session.titled": SessionTitledPayload,
  "error.occurred": ErrorOccurredPayload,
  "hook.executed": HookExecutedPayload,
} as const;

export type EventType = keyof typeof EventPayloads;
export type PayloadOf<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;

// ---------- 事件信封 ----------
export const EventEnvelope = z.object({
  event_id: z.string().uuid(),
  session_id: z.string(),
  seq: z.number().int().nonnegative(),
  ts: z.number().int(),
  type: z.string(),
  actor: Actor,
  turn_id: z.string().nullable(),
  causation_id: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type AgentEvent<T extends EventType = EventType> = Omit<
  z.infer<typeof EventEnvelope>,
  "type" | "payload"
> & {
  type: T;
  payload: PayloadOf<T>;
};

/** append 时的输入：seq 由存储层在事务内分配 */
export type EventInput<T extends EventType = EventType> = {
  session_id: string;
  type: T;
  actor: Actor;
  turn_id?: string | null;
  causation_id?: string | null;
  payload: PayloadOf<T>;
};

// ---------- 会话记录 ----------
export const SessionRecord = z.object({
  session_id: z.string(),
  title: z.string(),
  cwd: z.string(),
  mode: SessionMode,
  model: z.string(),
  sandbox_level: SandboxLevel,
  created_at: z.number().int(),
  archived: z.boolean(),
  forked_from: z.string().nullable(),
  caller_identity: z.string(),
  /** v0.3 / M2 新增：会话绑定的代理定义名 */
  agent: z.string().optional(),
  status: SessionStatus,
  last_seq: z.number().int(),
  /** v0.3 / M5 新增（可选）：活跃调用数（挂起审批数），由服务端列表接口聚合 */
  activeCallCount: z.number().int().optional(),
  /** v1.3 / P1-6 新增（可选）：worktree 隔离会话的 git 信息（合并/放弃后清除） */
  worktree: z
    .object({
      repo_root: z.string(),
      worktree_path: z.string(),
      branch: z.string(),
    })
    .optional(),
  /** v1.1 新增：累计 token 用量（由 turn.completed 聚合） */
  usage: z
    .object({
      prompt_tokens: z.number().int(),
      completion_tokens: z.number().int(),
      /** v1.2 新增：累计成本（美元），由 turn.completed.cost_estimate 聚合 */
      cost_usd: z.number().optional(),
    })
    .optional(),
});
export type SessionRecord = z.infer<typeof SessionRecord>;
