/**
 * Zustand store：会话事件流状态 + 动作。
 * M5：双栏槽位——primary（当前会话）/ secondary（分栏会话），各自独立轨迹与 SSE；
 * 聚合事件流（/api/events）驱动非可见会话的列表状态与审批提醒。
 * 会话列表等快照数据走 TanStack Query（见 App.tsx），不进此 store。
 */
import { create } from "zustand";
import type { AgentEvent, SessionRecord, SessionStatus } from "@shuyi/types";
import {
  initialTrajectory,
  reduceEvent,
  type TrajectoryState,
} from "./reducer.js";
import { AggregateEventSource, SessionEventSource } from "./sse.js";

/** M5：分栏槽位（最多 2 栏，超过仍是切换式） */
export type PaneSlot = "primary" | "secondary";

interface SessionStoreState {
  current: SessionRecord | null;
  trajectory: TrajectoryState;
  /** M5：分栏会话（右栏） */
  split: SessionRecord | null;
  splitTrajectory: TrajectoryState;
  /** M5：非可见会话的审批提醒（sessionId → 触发时间戳），SessionList 闪烁提示 */
  approvalAlerts: Record<string, number>;
  /** M5：非可见会话的最新状态（聚合流驱动，叠加在列表查询结果上） */
  liveStatus: Record<string, SessionStatus>;

  selectSession: (s: SessionRecord) => void;
  /** M5：把会话放进右栏（再次点击同一会话则收起分栏） */
  openSplit: (s: SessionRecord) => void;
  closeSplit: () => void;
  clearAlert: (sessionId: string) => void;
  dispatch: (slot: PaneSlot, e: AgentEvent) => void;

  sendMessage: (slot: PaneSlot, text: string, attachments?: File[]) => Promise<void>;
  abort: (slot: PaneSlot) => Promise<void>;
  resolveApproval: (
    slot: PaneSlot,
    approvalId: string,
    decision: "approve" | "deny",
    rememberRule?: boolean,
    /** M3：记住的 glob 规则模式（粒度细于 rememberRule 的整工具放行） */
    rememberPattern?: string,
    /** P0：question 工具的回答 */
    answer?: string,
  ) => Promise<void>;
  setMode: (slot: PaneSlot, mode: "plan" | "build") => Promise<void>;
  setModel: (slot: PaneSlot, model: string) => Promise<void>;
  /** M2：切换会话代理 */
  setAgent: (slot: PaneSlot, agent: string) => Promise<void>;
  rollback: (slot: PaneSlot, commit: string) => Promise<void>;
}

let primarySource: SessionEventSource | null = null;
let secondarySource: SessionEventSource | null = null;
let aggregateSource: AggregateEventSource | null = null;

export const useSessionStore = create<SessionStoreState>((set, get) => {
  /** 按槽位取会话记录 */
  const recordOf = (slot: PaneSlot): SessionRecord | null =>
    slot === "secondary" ? get().split : get().current;

  /** 更新指定槽位的会话记录 */
  const patchRecord = (slot: PaneSlot, patch: Partial<SessionRecord>): void => {
    const rec = recordOf(slot);
    if (!rec) return;
    const next = { ...rec, ...patch };
    set(slot === "secondary" ? { split: next } : { current: next });
  };

  /** 聚合流：非可见会话的状态与审批提醒（可见会话由专属流处理，忽略防重复） */
  const ensureAggregate = (): void => {
    if (aggregateSource) return;
    aggregateSource = new AggregateEventSource((e) => {
      const { current, split } = get();
      if (e.session_id === current?.session_id || e.session_id === split?.session_id) return;
      if (e.type === "session.status_changed") {
        const status = (e.payload as { status: SessionStatus }).status;
        set((st) => ({ liveStatus: { ...st.liveStatus, [e.session_id]: status } }));
      }
      if (e.type === "approval.requested") {
        set((st) => ({
          approvalAlerts: { ...st.approvalAlerts, [e.session_id]: Date.now() },
          liveStatus: { ...st.liveStatus, [e.session_id]: "awaiting_approval" },
        }));
      }
    });
    aggregateSource.start(null); // null = 全部会话
  };

  return {
    current: null,
    trajectory: initialTrajectory,
    split: null,
    splitTrajectory: initialTrajectory,
    approvalAlerts: {},
    liveStatus: {},

    selectSession(session) {
      primarySource?.stop();
      // 选中的会话若正在右栏，收起分栏（同一会话不占两栏）
      if (get().split?.session_id === session.session_id) get().closeSplit();
      set({ current: session, trajectory: initialTrajectory });
      get().clearAlert(session.session_id);
      primarySource = new SessionEventSource(session.session_id, (e) => get().dispatch("primary", e));
      primarySource.start();
      ensureAggregate();
    },

    openSplit(session) {
      if (session.session_id === get().current?.session_id) return; // 不与主栏重复
      if (get().split?.session_id === session.session_id) {
        get().closeSplit();
        return;
      }
      secondarySource?.stop();
      set({ split: session, splitTrajectory: initialTrajectory });
      get().clearAlert(session.session_id);
      secondarySource = new SessionEventSource(session.session_id, (e) => get().dispatch("secondary", e));
      secondarySource.start();
    },

    closeSplit() {
      secondarySource?.stop();
      secondarySource = null;
      set({ split: null, splitTrajectory: initialTrajectory });
    },

    clearAlert(sessionId) {
      if (!(sessionId in get().approvalAlerts)) return;
      set((st) => {
        const next = { ...st.approvalAlerts };
        delete next[sessionId];
        return { approvalAlerts: next };
      });
    },

    dispatch(slot, e) {
      if (slot === "secondary") {
        set((state) => ({ splitTrajectory: reduceEvent(state.splitTrajectory, e) }));
      } else {
        set((state) => ({ trajectory: reduceEvent(state.trajectory, e) }));
      }
    },

    async sendMessage(slot, text, attachments?: File[]) {
      const s = recordOf(slot);
      if (!s) return;
      let res: Response;
      if (attachments?.length) {
        const form = new FormData();
        form.set("text", text);
        for (const f of attachments) form.append("files", f);
        res = await fetch(`/api/sessions/${s.session_id}/messages/with-attachments`, {
          method: "POST",
          body: form,
        });
      } else {
        res = await fetch(`/api/sessions/${s.session_id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `发送失败 ${res.status}`);
      }
    },

    async abort(slot) {
      const s = recordOf(slot);
      if (!s) return;
      await fetch(`/api/sessions/${s.session_id}/abort`, { method: "POST" });
    },

    async resolveApproval(slot, approvalId, decision, rememberRule, rememberPattern, answer) {
      const s = recordOf(slot);
      if (!s) return;
      await fetch(`/api/sessions/${s.session_id}/approvals/${approvalId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision,
          remember_rule: rememberRule ? "allow" : undefined,
          remember_pattern: decision === "approve" && rememberPattern ? rememberPattern : undefined,
          answer: decision === "approve" && answer ? answer : undefined,
        }),
      });
    },

    async setMode(slot, mode) {
      const s = recordOf(slot);
      if (!s) return;
      await fetch(`/api/sessions/${s.session_id}/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      patchRecord(slot, { mode });
    },

    async setModel(slot, model) {
      const s = recordOf(slot);
      if (!s) return;
      await fetch(`/api/sessions/${s.session_id}/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
      });
      patchRecord(slot, { model });
    },

    async setAgent(slot, agent) {
      const s = recordOf(slot);
      if (!s) return;
      const res = await fetch(`/api/sessions/${s.session_id}/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `切换代理失败 ${res.status}`);
      }
      patchRecord(slot, { agent });
    },

    async rollback(slot, commit) {
      const s = recordOf(slot);
      if (!s) return;
      const res = await fetch(`/api/sessions/${s.session_id}/rollback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commit }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `回滚失败 ${res.status}`);
      }
    },
  };
});
