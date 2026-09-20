/**
 * 事件流 → UI 状态的纯函数 fold（零框架依赖核心）。
 * 与服务端上下文重建同构，但面向渲染。
 * 对应文档：《事件模型设计》§7 前端 Reducer 契约
 */
import type { AgentEvent, SessionStatus, TodoItem } from "@shuyi/types";

export type TimelineItem =
  | { kind: "user"; key: string; seq: number; text: string }
  | { kind: "assistant"; key: string; seq: number; text: string; streaming: boolean }
  | {
      kind: "tool";
      key: string;
      seq: number;
      callId: string;
      tool: string;
      args: Record<string, unknown>;
      status: "proposed" | "awaiting" | "running" | "done" | "failed" | "denied";
      result?: string;
      error?: string;
      output?: string;
      durationMs?: number;
      diff?: string;
    }
  | { kind: "marker"; key: string; seq: number; text: string; tone: "info" | "warn" | "error" };

/** F4：排队中的消息（message.queued 事件驱动） */
export interface QueuedMessage {
  queueId: string;
  text: string;
}

export interface PendingApproval {
  approvalId: string;
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  riskSummary: string;
}

export interface TurnBaseline {
  turnId: string;
  baseCommit: string;
  seq: number;
}

export interface TrajectoryState {
  items: TimelineItem[];
  pendingApprovals: PendingApproval[];
  status: SessionStatus;
  lastSeq: number;
  usage: { prompt: number; completion: number };
  /** 各轮次的 git 基线（turn.started.base_commit），用于回滚按钮 */
  baselines: TurnBaseline[];
  /** M1：会话任务清单（todo.list_updated 事件的最新快照） */
  todos: TodoItem[];
  /** F4：排队中的消息 */
  queued: QueuedMessage[];
  /** F1：最近一次会话级 rewind 的水位线（轨迹截断展示；无则 -1） */
  rewoundTo: number;
}

export const initialTrajectory: TrajectoryState = {
  items: [],
  pendingApprovals: [],
  status: "idle",
  lastSeq: -1,
  usage: { prompt: 0, completion: 0 },
  baselines: [],
  todos: [],
  queued: [],
  rewoundTo: -1,
};

export function reduceEvent(state: TrajectoryState, e: AgentEvent): TrajectoryState {
  if (e.seq <= state.lastSeq) return state; // 弱网重连去重
  const s: TrajectoryState = { ...state, lastSeq: e.seq };
  const p = e.payload as Record<string, unknown>;

  switch (e.type) {
    case "turn.started": {
      const base = p.base_commit as string | undefined;
      if (!base || !e.turn_id) return s;
      return {
        ...s,
        baselines: [...s.baselines, { turnId: e.turn_id, baseCommit: base, seq: e.seq }],
      };
    }

    case "message.user":
      return {
        ...s,
        // F4：出队执行的消息到达时，从排队列表移除（按文本匹配第一条）
        queued: (() => {
          const idx = s.queued.findIndex((q) => q.text === (p.text as string));
          if (idx < 0) return s.queued;
          return [...s.queued.slice(0, idx), ...s.queued.slice(idx + 1)];
        })(),
        items: [...s.items, { kind: "user", key: e.event_id, seq: e.seq, text: p.text as string }],
      };

    // F1：会话级 rewind——conversation/both 时截断水位线之后的轨迹与基线
    case "session.rewound": {
      const toSeq = p.to_seq as number;
      const mode = p.mode as string;
      const truncate = mode === "conversation" || mode === "both";
      const items = truncate
        ? [
            ...s.items.filter((i) => i.seq <= toSeq),
            {
              kind: "marker" as const,
              key: e.event_id,
              seq: e.seq,
              text: mode === "both" ? "已回滚会话与代码到此处" : "会话已回滚到此处（代码未动）",
              tone: "warn" as const,
            },
          ]
        : [
            ...s.items,
            {
              kind: "marker" as const,
              key: e.event_id,
              seq: e.seq,
              text: `代码已回滚（恢复 ${(p.files_restored as number) ?? 0} 个文件）`,
              tone: "warn" as const,
            },
          ];
      return {
        ...s,
        items,
        rewoundTo: truncate ? toSeq : s.rewoundTo,
        baselines: truncate ? s.baselines.filter((b) => b.seq <= toSeq) : s.baselines,
      };
    }

    // F4：消息排队 / 撤队
    case "message.queued":
      return {
        ...s,
        queued: [...s.queued, { queueId: p.queue_id as string, text: p.text as string }],
      };
    case "message.queue_cancelled":
      return { ...s, queued: s.queued.filter((q) => q.queueId !== (p.queue_id as string)) };

    case "message.assistant.delta": {
      const items = [...s.items];
      const last = items[items.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + (p.text_delta as string) };
      } else {
        items.push({ kind: "assistant", key: e.event_id, seq: e.seq, text: p.text_delta as string, streaming: true });
      }
      return { ...s, items };
    }

    case "message.assistant.completed": {
      const items = [...s.items];
      const last = items[items.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, text: (p.text as string) || last.text, streaming: false };
      } else if ((p.text as string)?.length) {
        items.push({ kind: "assistant", key: e.event_id, seq: e.seq, text: p.text as string, streaming: false });
      }
      return { ...s, items };
    }

    case "tool.call.proposed":
      return {
        ...s,
        items: [
          ...s.items,
          {
            kind: "tool",
            key: e.event_id, seq: e.seq,
            callId: p.call_id as string,
            tool: p.tool as string,
            args: p.args as Record<string, unknown>,
            status: "proposed",
          },
        ],
      };

    case "approval.requested": {
      const items = updateTool(s.items, p.call_id as string, { status: "awaiting" });
      return {
        ...s,
        items,
        pendingApprovals: [
          ...s.pendingApprovals,
          {
            approvalId: p.approval_id as string,
            callId: p.call_id as string,
            tool: p.tool as string,
            args: p.args as Record<string, unknown>,
            riskSummary: p.risk_summary as string,
          },
        ],
      };
    }

    case "approval.resolved": {
      const remaining = s.pendingApprovals.filter((a) => a.approvalId !== (p.approval_id as string));
      const denied = p.decision === "deny";
      const items = denied
        ? updateToolByApproval(s, p.approval_id as string, { status: "denied" })
        : s.items;
      return { ...s, items, pendingApprovals: remaining };
    }

    case "tool.call.started":
      return { ...s, items: updateTool(s.items, p.call_id as string, { status: "running" }) };

    case "tool.call.output_delta": {
      const item = findTool(s.items, p.call_id as string);
      if (!item) return s;
      return {
        ...s,
        items: updateTool(s.items, p.call_id as string, {
          output: (item.output ?? "") + (p.chunk as string),
        }),
      };
    }

    case "tool.call.completed":
      return {
        ...s,
        items: updateTool(s.items, p.call_id as string, {
          status: "done",
          result: p.result as string,
          durationMs: p.duration_ms as number,
          diff: (p.side_effects as { diff?: string } | undefined)?.diff,
        }),
      };

    case "tool.call.failed": {
      const error = p.error as string;
      const isDenied = error.startsWith("[用户拒绝]") || error.startsWith("[权限拒绝]");
      return {
        ...s,
        items: updateTool(s.items, p.call_id as string, {
          status: isDenied ? "denied" : "failed",
          error,
          durationMs: p.duration_ms as number,
        }),
      };
    }

    case "context.compacted":
      return {
        ...s,
        items: [
          ...s.items,
          {
            kind: "marker",
            key: e.event_id, seq: e.seq,
            text: `上下文已压缩（${p.tokens_before} → ${p.tokens_after} tokens）`,
            tone: "info",
          },
        ],
      };

    case "session.config_changed": {
      const changes = Object.entries(p).map(([k, v]) => `${k} → ${v}`).join(", ");
      return { ...s, items: [...s.items, { kind: "marker", key: e.event_id, seq: e.seq, text: `配置变更：${changes}`, tone: "info" }] };
    }

    case "turn.completed":
      return {
        ...s,
        usage: {
          prompt: s.usage.prompt + ((p.usage as { prompt_tokens: number }).prompt_tokens ?? 0),
          completion: s.usage.completion + ((p.usage as { completion_tokens: number }).completion_tokens ?? 0),
        },
      };

    case "turn.aborted":
      return { ...s, items: [...s.items, { kind: "marker", key: e.event_id, seq: e.seq, text: `轮次已中断：${p.reason}`, tone: "warn" }] };

    case "turn.rollback":
      return {
        ...s,
        items: [
          ...s.items,
          { kind: "marker", key: e.event_id, seq: e.seq, text: `工作区已回滚到提交 ${String(p.commit).slice(0, 8)}`, tone: "warn" },
        ],
      };

    case "error.occurred":
      return { ...s, items: [...s.items, { kind: "marker", key: e.event_id, seq: e.seq, text: `错误：${p.message}`, tone: "error" }] };

    case "subagent.started":
      return {
        ...s,
        items: [
          ...s.items,
          { kind: "marker", key: e.event_id, seq: e.seq, text: `子代理开始：${(p.task as string).slice(0, 80)}`, tone: "info" },
        ],
      };

    case "subagent.completed":
      return {
        ...s,
        items: [
          ...s.items,
          { kind: "marker", key: e.event_id, seq: e.seq, text: `子代理完成（${p.duration_ms}ms）：${(p.summary_excerpt as string).slice(0, 120)}`, tone: "info" },
        ],
      };

    case "memory.written":
      return {
        ...s,
        items: [
          ...s.items,
          { kind: "marker", key: e.event_id, seq: e.seq, text: `已写入记忆：${p.excerpt}`, tone: "info" },
        ],
      };

    case "session.status_changed":
      return { ...s, status: p.status as SessionStatus };

    case "todo.list_updated":
      return { ...s, todos: (p.todos as TodoItem[]) ?? [] };

    case "session.titled":
      return { ...s, items: [...s.items, { kind: "marker", key: e.event_id, seq: e.seq, text: `会话已命名为：${p.title}`, tone: "info" }] };

    default:
      return s;
  }
}

function findTool(items: TimelineItem[], callId: string) {
  return items.find((i): i is Extract<TimelineItem, { kind: "tool" }> => i.kind === "tool" && i.callId === callId);
}

function updateTool(
  items: TimelineItem[],
  callId: string,
  patch: Partial<Extract<TimelineItem, { kind: "tool" }>>,
): TimelineItem[] {
  return items.map((i) => (i.kind === "tool" && i.callId === callId ? { ...i, ...patch } : i));
}

function updateToolByApproval(
  state: TrajectoryState,
  approvalId: string,
  patch: Partial<Extract<TimelineItem, { kind: "tool" }>>,
): TimelineItem[] {
  const approval = state.pendingApprovals.find((a) => a.approvalId === approvalId);
  if (!approval) return state.items;
  return updateTool(state.items, approval.callId, patch);
}
