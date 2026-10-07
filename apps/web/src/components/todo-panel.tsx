/**
 * 任务面板（M1）：渲染当前会话的任务清单。
 * 数据由 SSE todo.list_updated 事件驱动 reducer 更新。
 * 排序与服务端 todoread 一致：in_progress > pending > completed。
 * 墨仪 §04：状态点即指示灯（进行中 accent 呼吸 / 待办 黛 / 完成 石绿）；
 * 不可折叠——显隐由右栏 Tabs 负责。
 */

import type { TodoItem } from "@shuyi-harness/types";
import { Badge } from "@shuyi-harness/ui/components/ui/badge";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@shuyi-harness/ui/components/ui/empty";
import { StatusDot } from "@shuyi-harness/ui/components/ui/status-dot";
import { type PaneSlot, useSessionStore } from "../core/store.js";

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

const STATUS_TONE: Record<TodoItem["status"], "accent" | "idle" | "success"> = {
	completed: "success",
	in_progress: "accent",
	pending: "idle",
};

const PRIORITY_VARIANT: Record<
	NonNullable<TodoItem["priority"]>,
	"destructive" | "warning" | "idle"
> = {
	high: "destructive",
	low: "idle",
	medium: "warning",
};

export function TodoPanel({ slot = "primary" }: { slot?: PaneSlot }) {
	const trajectory = useSessionStore((s) =>
		slot === "secondary" ? s.splitTrajectory : s.trajectory
	);
	const current = useSessionStore((s) =>
		slot === "secondary" ? s.split : s.current
	);

	const todos = trajectory.todos;

	if (!current || todos.length === 0) {
		return (
			<div className="h-full overflow-y-auto p-3">
				<Empty className="h-full rounded-md">
					<EmptyHeader>
						<EmptyMedia>
							<span className="grid size-[38px] rotate-[-4deg] place-items-center rounded-[5px] bg-seal font-serif text-[19px] font-bold text-seal-foreground">
								办
							</span>
						</EmptyMedia>
						<EmptyTitle>暂无任务</EmptyTitle>
						<EmptyDescription>
							agent 使用 todo 工具后在此跟踪进度
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			</div>
		);
	}

	const done = todos.filter((t) => t.status === "completed").length;
	const percent = Math.round((done / todos.length) * 100);
	const sorted = todos
		.map((t, i) => ({ i, t }))
		.sort(
			(a, b) => STATUS_ORDER[a.t.status] - STATUS_ORDER[b.t.status] || a.i - b.i
		)
		.map(({ t }) => t);

	return (
		<div className="h-full overflow-y-auto p-3">
			<div className="mb-2 flex items-center gap-2 px-1">
				<span className="label-mono text-faint">任务</span>
				<span className="font-mono text-[11px] tnum text-muted-foreground">
					{done}/{todos.length}
				</span>
				<div
					className="h-1 flex-1 overflow-hidden rounded-full bg-inset"
					title={`完成度 ${percent}%`}
				>
					<div
						className="h-full rounded-full bg-primary transition-all"
						style={{ width: `${percent}%` }}
					/>
				</div>
			</div>
			<ul className="flex flex-col gap-0.5">
				{sorted.map((t, i) => (
					<li
						className="flex items-start gap-2 rounded-sm px-2 py-1.5 hover:bg-accent"
						key={i}
					>
						<StatusDot
							className="mt-[7px]"
							pulse={t.status === "in_progress"}
							title={STATUS_LABEL[t.status]}
							tone={STATUS_TONE[t.status]}
						/>
						<span
							className={`min-w-0 flex-1 text-[12.5px] leading-relaxed ${
								t.status === "completed"
									? "text-muted-foreground line-through"
									: "text-foreground"
							}`}
						>
							{t.content}
						</span>
						{t.priority && (
							<Badge variant={PRIORITY_VARIANT[t.priority]}>{t.priority}</Badge>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
