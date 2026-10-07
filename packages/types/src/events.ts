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
	cwd: z.string(),
	mode: SessionMode,
	model: z.string(),
	sandbox_level: SandboxLevel,
	title: z.string(),
});
export const SessionConfigChangedPayload = z.object({
	mode: SessionMode.optional(),
	model: z.string().optional(),
	sandbox_level: SandboxLevel.optional(),
});
export const SessionForkedPayload = z.object({
	fork_at_seq: z.number().int(),
	from_session_id: z.string(),
});
export const SessionArchivedPayload = z.object({});

// 消息与流式输出
export const MessageUserPayload = z.object({
	attachments: z
		.array(z.object({ name: z.string(), path: z.string() }))
		.optional(),
	text: z.string(),
});
export const AssistantDeltaPayload = z.object({ text_delta: z.string() });
export const AssistantThinkingDeltaPayload = z.object({
	thinking_delta: z.string(),
});
export const AssistantCompletedPayload = z.object({
	finish_reason: z.string(),
	text: z.string(),
	thinking: z.string().optional(),
});

// 工具调用
export const ToolCallProposedPayload = z.object({
	args: z.record(z.string(), z.unknown()),
	call_id: z.string(),
	permission_hint: z.enum(["allow", "ask", "deny"]),
	tool: z.string(),
});
export const ApprovalRequestedPayload = z.object({
	approval_id: z.string(),
	args: z.record(z.string(), z.unknown()),
	call_id: z.string(),
	risk_summary: z.string(),
	tool: z.string(),
});
export const ApprovalResolvedPayload = z.object({
	approval_id: z.string(),
	decision: z.enum(["approve", "deny"]),
	deny_reason: z.string().optional(),
	remember_rule: z.string().optional(),
});
export const ToolCallStartedPayload = z.object({ call_id: z.string() });
export const ToolCallOutputDeltaPayload = z.object({
	call_id: z.string(),
	chunk: z.string(),
});
export const ToolCallCompletedPayload = z.object({
	blob_path: z.string().optional(),
	call_id: z.string(),
	duration_ms: z.number(),
	result: z.string(),
	side_effects: z
		.object({
			commit: z.string().optional(),
			diff: z.string().optional(),
			files_written: z.array(z.string()).optional(),
		})
		.optional(),
	truncated: z.boolean(),
});
export const ToolCallFailedPayload = z.object({
	call_id: z.string(),
	duration_ms: z.number(),
	error: z.string(),
});

// 上下文与记忆
export const ContextAssembledPayload = z.object({
	message_count: z.number().int(),
	model: z.string(),
	prefix_hash: z.string(),
	token_estimate: z.number().int(),
});
export const ContextCompactedPayload = z.object({
	covers_until_seq: z.number().int(),
	summary: z.object({
		active_goals: z.array(z.string()),
		files_modified: z.array(z.string()),
		key_decisions: z.array(z.string()),
		next_steps: z.string(),
		session_intent: z.string(),
	}),
	tokens_after: z.number().int(),
	tokens_before: z.number().int(),
});
export const MemoryWrittenPayload = z.object({
	excerpt: z.string(),
	file: z.string(),
	reason: z.string(),
});

// 子代理（v1.1 新增）
export const SubagentStartedPayload = z.object({
	parent_call_id: z.string(),
	task: z.string(),
});
export const SubagentCompletedPayload = z.object({
	duration_ms: z.number(),
	parent_call_id: z.string(),
	summary_excerpt: z.string(),
	task: z.string(),
});

// 轮次与状态
export const TurnStartedPayload = z.object({});
export const TurnCompletedPayload = z.object({
	cost_estimate: z.number().optional(),
	model: z.string(),
	usage: z.object({
		cached_tokens: z.number().int().optional(),
		completion_tokens: z.number().int(),
		prompt_tokens: z.number().int(),
	}),
});
export const TurnAbortedPayload = z.object({ reason: z.string() });
export const SessionStatusChangedPayload = z.object({ status: SessionStatus });
export const ErrorOccurredPayload = z.object({
	message: z.string(),
	retryable: z.boolean(),
	scope: z.string(),
});

// ---------- 事件类型注册表 ----------
export const EventPayloads = {
	"approval.requested": ApprovalRequestedPayload,
	"approval.resolved": ApprovalResolvedPayload,
	"context.compacted": ContextCompactedPayload,
	"context.request.assembled": ContextAssembledPayload,
	"error.occurred": ErrorOccurredPayload,
	"memory.written": MemoryWrittenPayload,
	"message.assistant.completed": AssistantCompletedPayload,
	"message.assistant.delta": AssistantDeltaPayload,
	"message.assistant.thinking_delta": AssistantThinkingDeltaPayload,
	"message.user": MessageUserPayload,
	"session.archived": SessionArchivedPayload,
	"session.config_changed": SessionConfigChangedPayload,
	"session.created": SessionCreatedPayload,
	"session.forked": SessionForkedPayload,
	"session.status_changed": SessionStatusChangedPayload,
	"subagent.completed": SubagentCompletedPayload,
	"subagent.started": SubagentStartedPayload,
	"tool.call.completed": ToolCallCompletedPayload,
	"tool.call.failed": ToolCallFailedPayload,
	"tool.call.output_delta": ToolCallOutputDeltaPayload,
	"tool.call.proposed": ToolCallProposedPayload,
	"tool.call.started": ToolCallStartedPayload,
	"turn.aborted": TurnAbortedPayload,
	"turn.completed": TurnCompletedPayload,
	"turn.started": TurnStartedPayload,
} as const;

export type EventType = keyof typeof EventPayloads;
export type PayloadOf<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;

// ---------- 事件信封 ----------
export const EventEnvelope = z.object({
	actor: Actor,
	causation_id: z.string().nullable(),
	event_id: z.string().uuid(),
	payload: z.record(z.string(), z.unknown()),
	seq: z.number().int().nonnegative(),
	session_id: z.string(),
	ts: z.number().int(),
	turn_id: z.string().nullable(),
	type: z.string(),
});
export type AgentEvent<T extends EventType = EventType> = Omit<
	z.infer<typeof EventEnvelope>,
	"type" | "payload"
> & {
	type: T;
	payload: PayloadOf<T>;
};

/** append 时的输入：seq 由存储层在事务内分配 */
export interface EventInput<T extends EventType = EventType> {
	actor: Actor;
	causation_id?: string | null;
	payload: PayloadOf<T>;
	session_id: string;
	turn_id?: string | null;
	type: T;
}

// ---------- 会话记录 ----------
export const SessionRecord = z.object({
	archived: z.boolean(),
	caller_identity: z.string(),
	created_at: z.number().int(),
	cwd: z.string(),
	forked_from: z.string().nullable(),
	last_seq: z.number().int(),
	mode: SessionMode,
	model: z.string(),
	sandbox_level: SandboxLevel,
	session_id: z.string(),
	status: SessionStatus,
	title: z.string(),
	/** v1.1 新增：累计 token 用量（由 turn.completed 聚合） */
	usage: z
		.object({
			completion_tokens: z.number().int(),
			prompt_tokens: z.number().int(),
		})
		.optional(),
});
export type SessionRecord = z.infer<typeof SessionRecord>;
