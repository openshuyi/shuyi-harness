/**
 * Zustand store：当前会话的事件流状态 + 动作。
 * 会话列表等快照数据走 TanStack Query（见 App.tsx），不进此 store。
 */
import { create } from "zustand";
import type { AgentEvent, SessionRecord } from "@shuyi/types";
import {
  initialTrajectory,
  reduceEvent,
  type TrajectoryState,
} from "./reducer.js";
import { SessionEventSource } from "./sse.js";

interface SessionStoreState {
  current: SessionRecord | null;
  trajectory: TrajectoryState;
  selectSession: (s: SessionRecord) => void;
  dispatch: (e: AgentEvent) => void;
  sendMessage: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  resolveApproval: (
    approvalId: string,
    decision: "approve" | "deny",
    rememberRule?: boolean,
  ) => Promise<void>;
  setMode: (mode: "plan" | "build") => Promise<void>;
  setModel: (model: string) => Promise<void>;
}

let eventSource: SessionEventSource | null = null;

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  current: null,
  trajectory: initialTrajectory,

  selectSession(session) {
    eventSource?.stop();
    set({ current: session, trajectory: initialTrajectory });
    eventSource = new SessionEventSource(session.session_id, (e) => get().dispatch(e));
    eventSource.start();
  },

  dispatch(e) {
    set((state) => ({ trajectory: reduceEvent(state.trajectory, e) }));
  },

  async sendMessage(text) {
    const s = get().current;
    if (!s) return;
    const res = await fetch(`/api/sessions/${s.session_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `发送失败 ${res.status}`);
    }
  },

  async abort() {
    const s = get().current;
    if (!s) return;
    await fetch(`/api/sessions/${s.session_id}/abort`, { method: "POST" });
  },

  async resolveApproval(approvalId, decision, rememberRule) {
    const s = get().current;
    if (!s) return;
    await fetch(`/api/sessions/${s.session_id}/approvals/${approvalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision,
        remember_rule: rememberRule ? "allow" : undefined,
      }),
    });
  },

  async setMode(mode) {
    const s = get().current;
    if (!s) return;
    await fetch(`/api/sessions/${s.session_id}/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    set({ current: { ...s, mode } });
  },

  async setModel(model) {
    const s = get().current;
    if (!s) return;
    await fetch(`/api/sessions/${s.session_id}/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
    set({ current: { ...s, model } });
  },
}));
