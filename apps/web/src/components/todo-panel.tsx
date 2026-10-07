/**
 * 任务面板（M1）：渲染当前会话的任务清单。
 * 数据由 SSE todo.list_updated 事件驱动 reducer 更新。
 * 排序与服务端 todoread 一致：in_progress > pending > completed。
 */

import type { TodoItem } from "@shuyi-harness/types";
import { useState } from "react";
import { type PaneSlot, useSessionStore } from "../core/store.js";

const STATUS_ICON: Record<TodoItem["status"], string> = {
	completed: "●",
	in_progress: "◐",
	pending: "○",
};

const STATUS_LABEL: Record<TodoItem["status"], string> = {
	completed: "已完成",
	in_progress: "进行中",
	pending: "待办",
};

const STATUS_ORDER: Record<TodoItem["status"], number> = {
	completed: 2,
	in_progress: 0,
	pending: 1,
};

export function TodoPanel({ slot = "primary" }: { slot?: PaneSlot }) {
	const trajectory = useSessionStore((s) =>
		slot === "secondary" ? s.splitTrajectory : s.trajectory
	);
	const current = useSessionStore((s) =>
		slot === "secondary" ? s.split : s.current
	);
	const [collapsed, setCollapsed] = useState(false);

	const todos = trajectory.todos;
	if (!current || todos.length === 0) return null;

	const done = todos.filter((t) => t.status === "completed").length;
	const percent = Math.round((done / todos.length) * 100);
	const sorted = todos
		.map((t, i) => ({ i, t }))
		.sort(
			(a, b) => STATUS_ORDER[a.t.status] - STATUS_ORDER[b.t.status] || a.i - b.i
		)
		.map(({ t }) => t);

	return (
		<div className="todo-panel">
			<div
				className="todo-panel-header"
				onClick={() => setCollapsed(!collapsed)}
			>
				<span>{collapsed ? "▸" : "▾"}</span>
				<span className="todo-panel-title">任务</span>
				<span className="todo-panel-count">
					{done}/{todos.length}
				</span>
				<div className="todo-progress" title={`完成度 ${percent}%`}>
					<div className="todo-progress-bar" style={{ width: `${percent}%` }} />
				</div>
			</div>
			{!collapsed && (
				<ul className="todo-list">
					{sorted.map((t, i) => (
						<li className={`todo-item todo-${t.status}`} key={i}>
							<span className="todo-icon" title={STATUS_LABEL[t.status]}>
								{STATUS_ICON[t.status]}
							</span>
							<span className="todo-content">{t.content}</span>
							{t.priority && (
								<span className={`todo-priority prio-${t.priority}`}>
									{t.priority}
								</span>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
