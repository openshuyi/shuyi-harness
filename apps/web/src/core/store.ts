/**
 * Zustand store：会话事件流状态 + 动作。
 * M5：双栏槽位——primary（当前会话）/ secondary（分栏会话），各自独立轨迹与 SSE；
 * 聚合事件流（/api/events）驱动非可见会话的列表状态与审批提醒。
 * 会话列表等快照数据走 TanStack Query（见 App.tsx），不进此 store。
 */

import type {
	AgentEvent,
	SessionRecord,
	SessionStatus,
} from "@shuyi-harness/types";
import { create } from "zustand";
import { apiBase } from "./api.js";
import {
	initialTrajectory,
	reduceEvent,
	type TrajectoryState,
} from "./reducer.js";
import { AggregateEventSource, SessionEventSource } from "./sse.js";

/** M5：分栏槽位（最多 2 栏，超过仍是切换式） */
export type PaneSlot = "primary" | "secondary";

interface SessionStoreState {
	abort: (slot: PaneSlot) => Promise<void>;
	/** M5：非可见会话的审批提醒（sessionId → 触发时间戳），SessionList 闪烁提示 */
	approvalAlerts: Record<string, number>;
	/** F5：批准计划（可附修订文本） */
	approvePlan: (slot: PaneSlot, revisedText?: string) => Promise<void>;
	/** F4：撤回排队消息 */
	cancelQueued: (slot: PaneSlot, queueId: string) => Promise<void>;
	clearAlert: (sessionId: string) => void;
	clearEditRequest: () => void;
	closeSplit: () => void;
	current: SessionRecord | null;
	dispatch: (slot: PaneSlot, e: AgentEvent) => void;
	/** F6：消息编辑重发——请求把某条用户消息载入 Composer（seq 用于提交前先截断） */
	editRequest: { slot: PaneSlot; seq: number; text: string } | null;
	/** F9：从指定 seq 分叉出新会话（返回新会话记录） */
	forkSession: (slot: PaneSlot, atSeq: number) => Promise<SessionRecord | null>;
	/** F6：每会话输入历史（↑ 召回；模块级，不落盘） */
	inputHistory: (slot: PaneSlot) => string[];
	/** M5：非可见会话的最新状态（聚合流驱动，叠加在列表查询结果上） */
	liveStatus: Record<string, SessionStatus>;
	/** M5：把会话放进右栏（再次点击同一会话则收起分栏） */
	openSplit: (s: SessionRecord) => void;
	requestEdit: (slot: PaneSlot, seq: number, text: string) => void;
	resolveApproval: (
		slot: PaneSlot,
		approvalId: string,
		decision: "approve" | "deny",
		rememberRule?: boolean,
		/** M3：记住的 glob 规则模式（粒度细于 rememberRule 的整工具放行） */
		rememberPattern?: string,
		/** P0：question 工具的回答 */
		answer?: string
	) => Promise<void>;
	/** F1（v0.4）：rewind 到指定 seq（code/conversation/both） */
	rewind: (
		slot: PaneSlot,
		toSeq: number,
		mode: "code" | "conversation" | "both"
	) => Promise<void>;
	rollback: (slot: PaneSlot, commit: string) => Promise<void>;

	selectSession: (s: SessionRecord) => void;

	sendMessage: (
		slot: PaneSlot,
		text: string,
		attachments?: File[]
	) => Promise<void>;
	/** M2：切换会话代理 */
	setAgent: (slot: PaneSlot, agent: string) => Promise<void>;
	setMode: (slot: PaneSlot, mode: "plan" | "build") => Promise<void>;
	setModel: (slot: PaneSlot, model: string) => Promise<void>;
	/** M5：分栏会话（右栏） */
	split: SessionRecord | null;
	splitTrajectory: TrajectoryState;
	trajectory: TrajectoryState;
}

let primarySource: SessionEventSource | null = null;
let secondarySource: SessionEventSource | null = null;
let aggregateSource: AggregateEventSource | null = null;
/** F6：输入历史（sessionId → 最近 50 条发送记录） */
const inputHistories = new Map<string, string[]>();

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
			if (
				e.session_id === current?.session_id ||
				e.session_id === split?.session_id
			)
				return;
			if (e.type === "session.status_changed") {
				const status = (e.payload as { status: SessionStatus }).status;
				set((st) => ({
					liveStatus: { ...st.liveStatus, [e.session_id]: status },
				}));
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
		async abort(slot) {
			const s = recordOf(slot);
			if (!s) return;
			await fetch(`${apiBase()}/api/sessions/${s.session_id}/abort`, {
				method: "POST",
			});
		},
		approvalAlerts: {},

		async approvePlan(slot, revisedText) {
			const s = recordOf(slot);
			if (!s) return;
			const res = await fetch(
				`${apiBase()}/api/sessions/${s.session_id}/plan/approve`,
				{
					body: JSON.stringify({ text: revisedText }),
					headers: { "content-type": "application/json" },
					method: "POST",
				}
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.error ?? `批准失败 ${res.status}`);
			}
			patchRecord(slot, { mode: "build" });
		},

		async cancelQueued(slot, queueId) {
			const s = recordOf(slot);
			if (!s) return;
			await fetch(
				`${apiBase()}/api/sessions/${s.session_id}/queue/${queueId}/cancel`,
				{ method: "POST" }
			);
		},

		clearAlert(sessionId) {
			if (!(sessionId in get().approvalAlerts)) return;
			set((st) => {
				const next = { ...st.approvalAlerts };
				delete next[sessionId];
				return { approvalAlerts: next };
			});
		},
		clearEditRequest() {
			set({ editRequest: null });
		},

		closeSplit() {
			secondarySource?.stop();
			secondarySource = null;
			set({ split: null, splitTrajectory: initialTrajectory });
		},
		current: null,

		dispatch(slot, e) {
			if (slot === "secondary") {
				set((state) => ({
					splitTrajectory: reduceEvent(state.splitTrajectory, e),
				}));
			} else {
				set((state) => ({ trajectory: reduceEvent(state.trajectory, e) }));
			}
		},
		editRequest: null,

		async forkSession(slot, atSeq) {
			const s = recordOf(slot);
			if (!s) return null;
			const res = await fetch(
				`${apiBase()}/api/sessions/${s.session_id}/fork`,
				{
					body: JSON.stringify({ at_seq: atSeq }),
					headers: { "content-type": "application/json" },
					method: "POST",
				}
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.error ?? `分叉失败 ${res.status}`);
			}
			return (await res.json()) as SessionRecord;
		},

		inputHistory(slot) {
			const s = recordOf(slot);
			return s ? (inputHistories.get(s.session_id) ?? []) : [];
		},
		liveStatus: {},

		openSplit(session) {
			if (session.session_id === get().current?.session_id) return; // 不与主栏重复
			if (get().split?.session_id === session.session_id) {
				get().closeSplit();
				return;
			}
			secondarySource?.stop();
			set({ split: session, splitTrajectory: initialTrajectory });
			get().clearAlert(session.session_id);
			secondarySource = new SessionEventSource(session.session_id, (e) =>
				get().dispatch("secondary", e)
			);
			secondarySource.start();
		},

		requestEdit(slot, seq, text) {
			set({ editRequest: { seq, slot, text } });
		},

		async resolveApproval(
			slot,
			approvalId,
			decision,
			rememberRule,
			rememberPattern,
			answer
		) {
			const s = recordOf(slot);
			if (!s) return;
			await fetch(
				`${apiBase()}/api/sessions/${s.session_id}/approvals/${approvalId}`,
				{
					body: JSON.stringify({
						answer: decision === "approve" && answer ? answer : undefined,
						decision,
						remember_pattern:
							decision === "approve" && rememberPattern
								? rememberPattern
								: undefined,
						remember_rule: rememberRule ? "allow" : undefined,
					}),
					headers: { "content-type": "application/json" },
					method: "POST",
				}
			);
		},

		async rewind(slot, toSeq, mode) {
			const s = recordOf(slot);
			if (!s) return;
			const res = await fetch(
				`${apiBase()}/api/sessions/${s.session_id}/rewind`,
				{
					body: JSON.stringify({ mode, to_seq: toSeq }),
					headers: { "content-type": "application/json" },
					method: "POST",
				}
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.error ?? `回滚失败 ${res.status}`);
			}
		},

		async rollback(slot, commit) {
			const s = recordOf(slot);
			if (!s) return;
			const res = await fetch(
				`${apiBase()}/api/sessions/${s.session_id}/rollback`,
				{
					body: JSON.stringify({ commit }),
					headers: { "content-type": "application/json" },
					method: "POST",
				}
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.error ?? `回滚失败 ${res.status}`);
			}
		},

		selectSession(session) {
			primarySource?.stop();
			// 选中的会话若正在右栏，收起分栏（同一会话不占两栏）
			if (get().split?.session_id === session.session_id) get().closeSplit();
			set({ current: session, trajectory: initialTrajectory });
			get().clearAlert(session.session_id);
			primarySource = new SessionEventSource(session.session_id, (e) =>
				get().dispatch("primary", e)
			);
			primarySource.start();
			ensureAggregate();
		},

		async sendMessage(slot, text, attachments?: File[]) {
			const s = recordOf(slot);
			if (!s) return;
			let res: Response;
			if (attachments?.length) {
				const form = new FormData();
				form.set("text", text);
				for (const f of attachments) form.append("files", f);
				res = await fetch(
					`${apiBase()}/api/sessions/${s.session_id}/messages/with-attachments`,
					{
						body: form,
						method: "POST",
					}
				);
			} else {
				res = await fetch(
					`${apiBase()}/api/sessions/${s.session_id}/messages`,
					{
						body: JSON.stringify({ text }),
						headers: { "content-type": "application/json" },
						method: "POST",
					}
				);
			}
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.error ?? `发送失败 ${res.status}`);
			}
			// F6：记入输入历史（去重，最多 50 条）
			const hist = inputHistories.get(s.session_id) ?? [];
			inputHistories.set(
				s.session_id,
				[text, ...hist.filter((h) => h !== text)].slice(0, 50)
			);
		},

		async setAgent(slot, agent) {
			const s = recordOf(slot);
			if (!s) return;
			const res = await fetch(
				`${apiBase()}/api/sessions/${s.session_id}/config`,
				{
					body: JSON.stringify({ agent }),
					headers: { "content-type": "application/json" },
					method: "POST",
				}
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.error ?? `切换代理失败 ${res.status}`);
			}
			patchRecord(slot, { agent });
		},

		async setMode(slot, mode) {
			const s = recordOf(slot);
			if (!s) return;
			await fetch(`${apiBase()}/api/sessions/${s.session_id}/config`, {
				body: JSON.stringify({ mode }),
				headers: { "content-type": "application/json" },
				method: "POST",
			});
			patchRecord(slot, { mode });
		},

		async setModel(slot, model) {
			const s = recordOf(slot);
			if (!s) return;
			await fetch(`${apiBase()}/api/sessions/${s.session_id}/config`, {
				body: JSON.stringify({ model }),
				headers: { "content-type": "application/json" },
				method: "POST",
			});
			patchRecord(slot, { model });
		},
		split: null,
		splitTrajectory: initialTrajectory,
		trajectory: initialTrajectory,
	};
});
