/**
 * Zustand store：当前会话的事件流状态 + 动作。
 * 会话列表等快照数据走 TanStack Query（见 App.tsx），不进此 store。
 */

import type { AgentEvent, SessionRecord } from "@shuyi-harness/types";
import { create } from "zustand";
import { apiBase } from "./api.js";
import {
	initialTrajectory,
	reduceEvent,
	type TrajectoryState,
} from "./reducer.js";
import { SessionEventSource } from "./sse.js";

interface SessionStoreState {
	abort: () => Promise<void>;
	current: SessionRecord | null;
	dispatch: (e: AgentEvent) => void;
	resolveApproval: (
		approvalId: string,
		decision: "approve" | "deny",
		rememberRule?: boolean
	) => Promise<void>;
	selectSession: (s: SessionRecord) => void;
	sendMessage: (text: string) => Promise<void>;
	setMode: (mode: "plan" | "build") => Promise<void>;
	setModel: (model: string) => Promise<void>;
	trajectory: TrajectoryState;
}

let eventSource: SessionEventSource | null = null;

export const useSessionStore = create<SessionStoreState>((set, get) => ({
	async abort() {
		const s = get().current;
		if (!s) {
			return;
		}
		await fetch(`${apiBase()}/api/sessions/${s.session_id}/abort`, {
			method: "POST",
		});
	},
	current: null,

	dispatch(e) {
		set((state) => ({ trajectory: reduceEvent(state.trajectory, e) }));
	},

	async resolveApproval(approvalId, decision, rememberRule) {
		const s = get().current;
		if (!s) {
			return;
		}
		await fetch(
			`${apiBase()}/api/sessions/${s.session_id}/approvals/${approvalId}`,
			{
				body: JSON.stringify({
					decision,
					remember_rule: rememberRule ? "allow" : undefined,
				}),
				headers: { "content-type": "application/json" },
				method: "POST",
			}
		);
	},

	selectSession(session) {
		eventSource?.stop();
		set({ current: session, trajectory: initialTrajectory });
		eventSource = new SessionEventSource(session.session_id, (e) =>
			get().dispatch(e)
		);
		eventSource.start();
	},

	async sendMessage(text) {
		const s = get().current;
		if (!s) {
			return;
		}
		const res = await fetch(
			`${apiBase()}/api/sessions/${s.session_id}/messages`,
			{
				body: JSON.stringify({ text }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}
		);
		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			throw new Error(err.error ?? `发送失败 ${res.status}`);
		}
	},

	async setMode(mode) {
		const s = get().current;
		if (!s) {
			return;
		}
		await fetch(`${apiBase()}/api/sessions/${s.session_id}/config`, {
			body: JSON.stringify({ mode }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		set({ current: { ...s, mode } });
	},

	async setModel(model) {
		const s = get().current;
		if (!s) {
			return;
		}
		await fetch(`${apiBase()}/api/sessions/${s.session_id}/config`, {
			body: JSON.stringify({ model }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		set({ current: { ...s, model } });
	},
	trajectory: initialTrajectory,
}));
