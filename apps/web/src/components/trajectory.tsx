/**
 * Trajectory 视图（墨仪 §06/§08/§09/§13）：按事件流渲染时间线。
 * - 工具卡：38px 头部 = 状态点 + mono 工具名 + mono 目标 + 耗时；默认折叠，展开 inset 读数区
 * - 用户消息右对齐 accent-soft 气泡；助手全宽 markdown 流式渲染 + caret
 * - 悬浮显形操作条：编辑 / 回滚三模式 / 分叉
 * - plan 模式闲置时展示计划批准卡片（accent 顶线 + 朱砂「批准执行」）
 */
import { Button } from "@shuyi-harness/ui/components/ui/button";
import { StatusDot } from "@shuyi-harness/ui/components/ui/status-dot";
import { Textarea } from "@shuyi-harness/ui/components/ui/textarea";
import {
	ChevronRightIcon,
	GitForkIcon,
	PencilIcon,
	Undo2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TimelineItem } from "../core/reducer.js";
import { type PaneSlot, useSessionStore } from "../core/store.js";
import { Markdown } from "./markdown.js";

/** 工具状态 → 指示灯（§04：色彩即信号） */
const TOOL_TONE: Record<
	string,
	{ pulse: boolean; tone: "accent" | "danger" | "idle" | "success" | "warning" }
> = {
	awaiting: { pulse: true, tone: "warning" },
	denied: { pulse: false, tone: "danger" },
	done: { pulse: false, tone: "success" },
	failed: { pulse: false, tone: "danger" },
	proposed: { pulse: false, tone: "idle" },
	running: { pulse: true, tone: "accent" },
};

/** 从工具入参提取头部「目标」读数（mono 短摘要） */
function targetOf(args: Record<string, unknown>): string {
	for (const key of [
		"command",
		"path",
		"file_path",
		"filePath",
		"pattern",
		"url",
		"query",
	]) {
		const v = args[key];
		if (typeof v === "string" && v) return v;
	}
	if (typeof args.description === "string" && args.description) {
		return args.description;
	}
	const json = JSON.stringify(args);
	return json.length > 80 ? `${json.slice(0, 80)}…` : json;
}

function ToolDot({
	status,
	className,
}: {
	status: string;
	className?: string;
}) {
	const { pulse, tone } = TOOL_TONE[status] ?? { pulse: false, tone: "idle" };
	return <StatusDot className={className} pulse={pulse} tone={tone} />;
}

/** §06 工具调用卡片 */
function ToolCard({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
	const [expanded, setExpanded] = useState(
		item.status === "failed" || item.status === "denied"
	);
	return (
		<div className="surface-lift my-2 overflow-hidden rounded-sm border bg-card">
			<button
				className="group flex h-[38px] w-full items-center gap-2.5 px-3 transition-colors hover:bg-popover"
				onClick={() => setExpanded(!expanded)}
				type="button"
			>
				<ToolDot status={item.status} />
				<span className="font-mono text-[11.5px] font-semibold tracking-[0.05em] whitespace-nowrap text-primary uppercase">
					{item.tool}
				</span>
				<span className="flex-1 truncate text-left font-mono text-xs text-muted-foreground">
					{targetOf(item.args)}
				</span>
				{item.durationMs !== undefined && (
					<span className="label-mono tnum shrink-0 text-faint">
						{item.durationMs}ms
					</span>
				)}
				{item.approved === true && (
					<span
						aria-hidden
						className="grid size-[22px] shrink-0 rotate-[-4deg] place-items-center rounded-[5px] border-[1.5px] border-seal font-serif text-[12px] font-bold text-seal opacity-90"
						title="已盖印批准"
					>
						准
					</span>
				)}
				<ChevronRightIcon
					className="size-3! shrink-0 text-faint transition-transform duration-200 group-hover:text-foreground"
					style={{ transform: expanded ? "rotate(90deg)" : undefined }}
				/>
			</button>
			{expanded && (
				<div className="animate-rise border-t bg-inset">
					<pre className="overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-[1.65] text-muted-foreground">
						{JSON.stringify(item.args, null, 2)}
					</pre>
					{item.output && (
						<pre className="mt-0 overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-[1.65] text-muted-foreground">
							{item.output}
						</pre>
					)}
					{item.result && (
						<div className="border-t px-3.5 py-2.5">
							<Markdown text={item.result} />
						</div>
					)}
					{item.error && (
						<pre className="border-t px-3.5 py-3 font-mono text-[12.5px] text-destructive">
							{item.error}
						</pre>
					)}
					{item.diff && (
						<div className="diff-code border-t py-2">
							{item.diff.split("\n").map((line, i) => (
								<div
									className={
										line.startsWith("+") && !line.startsWith("+++")
											? "diff-line-add"
											: line.startsWith("-") && !line.startsWith("---")
												? "diff-line-del"
												: "diff-line-meta"
									}
									key={i}
								>
									{line || " "}
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/** 时间线条目来源分类（过滤用） */
type SourceFilter = "user" | "assistant" | "tool" | "system";

const FILTERS: { id: SourceFilter; label: string }[] = [
	{ id: "user", label: "用户" },
	{ id: "assistant", label: "助手" },
	{ id: "tool", label: "工具" },
	{ id: "system", label: "系统" },
];

function itemSource(item: TimelineItem): SourceFilter {
	switch (item.kind) {
		case "user":
			return "user";
		case "assistant":
			return "assistant";
		case "tool":
			return "tool";
		case "marker":
			return "system";
	}
}

/** F1/F9：用户消息悬浮操作条（§08：opacity 0→1 on hover） */
function UserActions({
	slot,
	seq,
	text,
	idle,
}: {
	slot: PaneSlot;
	seq: number;
	text: string;
	idle: boolean;
}) {
	const { rewind, forkSession, requestEdit } = useSessionStore();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const close = (e: MouseEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [open]);

	const doRewind = async (mode: "code" | "conversation" | "both") => {
		setBusy(true);
		setOpen(false);
		try {
			await rewind(slot, seq, mode);
		} catch (err) {
			alert(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div
			className="relative flex items-center gap-0.5 opacity-0 transition-opacity duration-100 group-hover/msg:opacity-100"
			ref={ref}
		>
			<Button
				aria-label="回滚"
				disabled={!idle || busy}
				onClick={() => setOpen((v) => !v)}
				size="icon-sm"
				title="回滚到这条消息（之后的内容按所选范围撤销）"
				variant="ghost"
			>
				<Undo2Icon />
			</Button>
			<Button
				aria-label="编辑重发"
				disabled={!idle || busy}
				onClick={() => requestEdit(slot, seq, text)}
				size="icon-sm"
				title="编辑这条消息并重发（之后的内容从会话中移除）"
				variant="ghost"
			>
				<PencilIcon />
			</Button>
			<Button
				aria-label="分叉"
				disabled={busy}
				onClick={() => {
					void forkSession(slot, seq)
						.then((s) => {
							if (s) useSessionStore.getState().selectSession(s);
						})
						.catch((err) =>
							alert(err instanceof Error ? err.message : String(err))
						);
				}}
				size="icon-sm"
				title="从此处分叉新会话（复制到此处为止的历史）"
				variant="ghost"
			>
				<GitForkIcon />
			</Button>
			{open && (
				<div className="absolute top-[calc(100%+6px)] right-0 z-30 w-[300px] rounded-lg border bg-popover p-1.5 shadow-(--shadow-pop)">
					{(
						[
							{
								desc: "轨迹截断到此处，并恢复此消息之后的文件改动",
								label: "会话 + 代码",
								mode: "both" as const,
							},
							{
								desc: "轨迹截断到此处，文件保持现状",
								label: "仅会话",
								mode: "conversation" as const,
							},
							{
								desc: "恢复此消息之后的文件改动，会话历史保留",
								label: "仅代码",
								mode: "code" as const,
							},
						] as const
					).map((opt) => (
						<button
							className="flex w-full flex-col items-start gap-0.5 rounded-sm px-2.5 py-2 text-left transition-colors hover:bg-accent"
							key={opt.mode}
							onClick={() => void doRewind(opt.mode)}
							type="button"
						>
							<span className="text-[13px] font-medium">{opt.label}</span>
							<span className="text-[11.5px] text-faint">{opt.desc}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/** F5：计划批准卡片（§09：accent 顶线 + 任务清单 + 朱砂「批准执行」） */
function PlanCard({ slot, planText }: { slot: PaneSlot; planText: string }) {
	const { approvePlan } = useSessionStore();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(planText);
	const [busy, setBusy] = useState(false);
	const approve = async () => {
		setBusy(true);
		try {
			await approvePlan(
				slot,
				editing && draft !== planText ? draft : undefined
			);
		} catch (err) {
			alert(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="surface-lift mt-3 overflow-hidden rounded-md border border-t-2 border-t-primary bg-card">
			<div className="flex items-center gap-2.5 px-4 pt-3.5">
				<span className="label-mono text-primary">plan proposal</span>
				<span className="label-mono text-faint">mode: plan</span>
			</div>
			<div className="px-4 pt-1 pb-3">
				<h3 className="text-[15px] font-semibold">计划待批准</h3>
				{editing ? (
					<Textarea
						className="mt-2 min-h-[180px] font-mono text-[12.5px]"
						onChange={(e) => setDraft(e.target.value)}
						rows={Math.min(18, draft.split("\n").length + 2)}
						value={draft}
					/>
				) : null}
			</div>
			<div className="flex gap-2 border-t bg-panel p-3">
				<Button disabled={busy} onClick={() => void approve()} variant="seal">
					{busy ? "启动中…" : editing ? "批准（含修订）并执行" : "批准执行"}
				</Button>
				<Button
					disabled={busy}
					onClick={() => setEditing((v) => !v)}
					variant="secondary"
				>
					{editing ? "收起编辑" : "编辑计划"}
				</Button>
			</div>
		</div>
	);
}

export function Trajectory({ slot = "primary" }: { slot?: PaneSlot }) {
	const trajectory = useSessionStore((s) =>
		slot === "secondary" ? s.splitTrajectory : s.trajectory
	);
	const current = useSessionStore((s) =>
		slot === "secondary" ? s.split : s.current
	);
	const { rollback } = useSessionStore();
	const bottomRef = useRef<HTMLDivElement>(null);
	const [hidden, setHidden] = useState<Set<SourceFilter>>(new Set());
	const [rollingBack, setRollingBack] = useState(false);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [trajectory.items.length, trajectory.items]);

	if (!current) {
		return (
			<div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
				<div className="flex w-full max-w-md flex-col items-center rounded-md border border-dashed p-10 text-center">
					<div
						className="mb-3.5 grid size-10 rotate-[-4deg] place-items-center rounded-[5px] bg-seal font-serif text-[19px] font-bold text-seal-foreground opacity-90"
						style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,.22)" }}
					>
						书
					</div>
					<div className="mb-1.5 text-sm font-semibold">开始一段新会话</div>
					<div className="mb-4 text-[12.5px] text-faint">
						会话独立于界面存活——关闭标签页，agent 继续运行
					</div>
					<div className="flex flex-wrap justify-center gap-1.5">
						{[
							"/ 斜杠命令",
							"@ 引用文件",
							"⌘K 命令面板",
							"⇄ 双栏并行",
							"⎇ worktree 隔离",
							"↩ 检查点回滚",
						].map((hint) => (
							<span
								className="label-mono rounded-full border bg-card px-2.5 py-1 text-[10px] text-faint"
								key={hint}
							>
								{hint}
							</span>
						))}
					</div>
				</div>
			</div>
		);
	}

	const visible = trajectory.items.filter((i) => !hidden.has(itemSource(i)));
	const idle = trajectory.status === "idle";
	const lastAssistant = [...trajectory.items]
		.reverse()
		.find(
			(i): i is Extract<TimelineItem, { kind: "assistant" }> =>
				i.kind === "assistant" && !i.streaming && i.text.trim().length > 0
		);
	// F5：计划卡片条件——plan 模式、闲置、最近一条可见内容是助手消息
	const showPlanCard =
		current.mode === "plan" &&
		idle &&
		lastAssistant !== undefined &&
		visible.length > 0 &&
		visible[visible.length - 1] === lastAssistant;

	const toggle = (f: SourceFilter) =>
		setHidden((prev) => {
			const next = new Set(prev);
			if (next.has(f)) next.delete(f);
			else next.add(f);
			return next;
		});

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* 过滤条（信息流密度档） */}
			<div className="flex flex-none flex-wrap items-center gap-1 border-b px-3 py-1.5 md:px-5">
				{FILTERS.map((f) => (
					<button
						className={`rounded-xs px-2 py-0.5 text-[11px] transition-colors ${
							hidden.has(f.id)
								? "text-faint line-through"
								: "text-muted-foreground hover:bg-accent hover:text-foreground"
						}`}
						key={f.id}
						onClick={() => toggle(f.id)}
						title={hidden.has(f.id) ? `显示${f.label}` : `隐藏${f.label}`}
						type="button"
					>
						{f.label}
					</button>
				))}
				<span className="flex-1" />
				{trajectory.baselines.length > 0 && idle && (
					<Button
						disabled={rollingBack}
						onClick={() => {
							const base =
								trajectory.baselines[trajectory.baselines.length - 1];
							if (
								!confirm(
									`确定回滚？工作区将恢复到最近一轮开始前的状态（提交 ${base.baseCommit}）。\n当前未提交改动会先自动保存为一个提交。`
								)
							)
								return;
							setRollingBack(true);
							rollback(slot, base.baseCommit)
								.catch((err) =>
									alert(err instanceof Error ? err.message : String(err))
								)
								.finally(() => setRollingBack(false));
						}}
						size="xs"
						title={`回滚工作区到本轮开始前的状态（git reset 到 ${trajectory.baselines[trajectory.baselines.length - 1].baseCommit}）`}
						variant="ghost"
					>
						{rollingBack ? "回滚中…" : "↩ 撤销本轮改动"}
					</Button>
				)}
				<a
					className="rounded-xs px-2 py-0.5 text-[11px] text-faint transition-colors hover:bg-accent hover:text-foreground"
					download
					href={`/api/sessions/${current.session_id}/replay`}
					title="导出会话回放（自包含 HTML，可分享）"
				>
					⬇ 回放
				</a>
			</div>

			{/* 事件流投影 */}
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
				{visible.map((item) => {
					switch (item.kind) {
						case "user":
							return (
								<div
									className="group/msg flex items-start justify-end gap-2 py-2"
									key={item.key}
								>
									<UserActions
										idle={idle}
										seq={item.seq}
										slot={slot}
										text={item.text}
									/>
									<div className="max-w-[72%] rounded-md bg-accent px-3.5 py-2.5 text-[13.5px] leading-relaxed">
										{item.text}
									</div>
								</div>
							);
						case "assistant":
							return (
								<div className="py-2" key={item.key}>
									<div className="mb-1 flex items-center gap-2">
										<span className="label-mono text-faint">assistant</span>
										{item.streaming && (
											<span className="label-mono flex items-center gap-1.5 text-muted-foreground">
												<ToolDot className="size-1.5" status="running" />
												输出中
											</span>
										)}
									</div>
									<div className="text-[13px] leading-[1.65] text-foreground">
										<Markdown text={item.text} />
										{item.streaming && <span className="caret" />}
									</div>
								</div>
							);
						case "tool":
							return <ToolCard item={item} key={item.key} />;
						case "marker":
							return (
								<div className="flex items-center gap-2.5 py-2" key={item.key}>
									<span
										className={`label-mono ${
											item.tone === "error"
												? "text-destructive"
												: item.tone === "warn"
													? "text-warning"
													: "text-faint"
										}`}
									>
										{item.text}
									</span>
									<span className="h-px flex-1 bg-border" />
								</div>
							);
					}
				})}
				{showPlanCard && <PlanCard planText={lastAssistant.text} slot={slot} />}
				<div ref={bottomRef} />
			</div>
		</div>
	);
}
