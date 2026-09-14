/**
 * 事件流 → UI 状态的纯函数 fold（零框架依赖核心）。
 * 与服务端上下文重建同构，但面向渲染。
 * 对应文档：《事件模型设计》§7 前端 Reducer 契约
 */
import type { AgentEvent, SessionStatus } from "@shuyi/types";

export type TimelineItem =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      key: string;
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
  | { kind: "marker"; key: string; text: string; tone: "info" | "warn" | "error" };

export interface PendingApproval {
  approvalId: string;
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  riskSummary: string;
}

export interface TrajectoryState {
  items: TimelineItem[];
  pendingApprovals: PendingApproval[];
  status: SessionStatus;
  lastSeq: number;
  usage: { prompt: number; completion: number };
}

export const initialTrajectory: TrajectoryState = {
  items: [],
  pendingApprovals: [],
  status: "idle",
  lastSeq: -1,
  usage: { prompt: 0, completion: 0 },
};

export function reduceEvent(state: TrajectoryState, e: AgentEvent): TrajectoryState {
  if (e.seq <= state.lastSeq) return state; // 弱网重连去重
  const s: TrajectoryState = { ...state, lastSeq: e.seq };
  const p = e.payload as Record<string, unknown>;

  switch (e.type) {
    case "message.user":
      return { ...s, items: [...s.items, { kind: "user", key: e.event_id, text: p.text as string }] };

    case "message.assistant.delta": {
      const items = [...s.items];
      const last = items[items.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + (p.text_delta as string) };
      } else {
        items.push({ kind: "assistant", key: e.event_id, text: p.text_delta as string, streaming: true });
      }
      return { ...s, items };
    }

    case "message.assistant.completed": {
      const items = [...s.items];
      const last = items[items.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, text: (p.text as string) || last.text, streaming: false };
      } else if ((p.text as string)?.length) {
        items.push({ kind: "assistant", key: e.event_id, text: p.text as string, streaming: false });
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
            key: e.event_id,
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
            key: e.event_id,
            text: `上下文已压缩（${p.tokens_before} → ${p.tokens_after} tokens）`,
            tone: "info",
          },
        ],
      };

    case "session.config_changed": {
      const changes = Object.entries(p).map(([k, v]) => `${k} → ${v}`).join(", ");
      return { ...s, items: [...s.items, { kind: "marker", key: e.event_id, text: `配置变更：${changes}`, tone: "info" }] };
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
      return { ...s, items: [...s.items, { kind: "marker", key: e.event_id, text: `轮次已中断：${p.reason}`, tone: "warn" }] };

    case "error.occurred":
      return { ...s, items: [...s.items, { kind: "marker", key: e.event_id, text: `错误：${p.message}`, tone: "error" }] };

    case "subagent.started":
      return {
        ...s,
        items: [
          ...s.items,
          { kind: "marker", key: e.event_id, text: `子代理开始：${(p.task as string).slice(0, 80)}`, tone: "info" },
        ],
      };

    case "subagent.completed":
      return {
        ...s,
        items: [
          ...s.items,
          { kind: "marker", key: e.event_id, text: `子代理完成（${p.duration_ms}ms）：${(p.summary_excerpt as string).slice(0, 120)}`, tone: "info" },
        ],
      };

    case "memory.written":
      return {
        ...s,
        items: [
          ...s.items,
          { kind: "marker", key: e.event_id, text: `已写入记忆：${p.excerpt}`, tone: "info" },
        ],
      };

    case "session.status_changed":
      return { ...s, status: p.status as SessionStatus };

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
