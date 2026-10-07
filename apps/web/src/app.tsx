/**
 * 应用外壳（墨仪 §17 App Shell）：单一外壳承载全部功能——
 * 无顶部导航栏，左侧会话列表是唯一常驻导航，⌘K 命令面板是全局菜单；
 * 主区 = Trajectory + Composer；右面板 Tabs：变更 / 预览 / 待办（可关闭）。
 */

import { Badge } from "@shuyi-harness/ui/components/ui/badge";
import { Button } from "@shuyi-harness/ui/components/ui/button";
import { Kbd } from "@shuyi-harness/ui/components/ui/kbd";
import { StatusDot } from "@shuyi-harness/ui/components/ui/status-dot";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@shuyi-harness/ui/components/ui/tabs";
import { useQueryClient } from "@tanstack/react-query";
import {
	FileDiffIcon,
	ListTodoIcon,
	MonitorIcon,
	MoonIcon,
	SunIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ApprovalDialog } from "./components/approval-dialog.js";
import { ChangesPanel } from "./components/changes-panel.js";
import {
	CommandPalette,
	type PaletteAction,
} from "./components/command-palette.js";
import { Composer } from "./components/composer.js";
import { ErrorBoundary } from "./components/error-boundary.js";
import { PreviewPanel } from "./components/preview-panel.js";
import { SessionList } from "./components/session-list.js";
import { useTheme } from "./components/theme-provider.js";
import { TodoPanel } from "./components/todo-panel.js";
import { Trajectory } from "./components/trajectory.js";
import { type PaneSlot, useSessionStore } from "./core/store.js";

type SidePanel = "changes" | "preview" | "todo";

/** 外壳三态之一（§17）：idle / running（titlebar 徽章 pulse）/ awaiting（审批浮层） */
function StatusBadge({ status }: { status: string }) {
	if (status === "running") {
		return (
			<Badge className="px-1.5 py-0.5 text-[10px]" variant="accent">
				<StatusDot className="size-1.5" pulse tone="accent" />
				running
			</Badge>
		);
	}
	if (status === "awaiting_approval") {
		return (
			<Badge className="px-1.5 py-0.5 text-[10px]" variant="warning">
				<StatusDot className="size-1.5" pulse tone="warning" />
				awaiting approval
			</Badge>
		);
	}
	return null;
}

/** 标题栏主题切换：墨 / 纸 */
function ThemeToggle() {
	const { resolvedTheme, setTheme } = useTheme();
	const dark = resolvedTheme !== "light";
	return (
		<Button
			aria-label="切换主题"
			data-action="theme-toggle"
			onClick={() => setTheme(dark ? "light" : "dark")}
			size="icon"
			title={dark ? "切换到纸（浅色）" : "切换到墨（深色）"}
			variant="ghost"
		>
			{dark ? <MoonIcon /> : <SunIcon />}
		</Button>
	);
}

export default function App() {
	const queryClient = useQueryClient();
	const { trajectory, current, split, closeSplit, setMode } = useSessionStore();
	const [paletteOpen, setPaletteOpen] = useState(false);
	/** 右侧工具面板（§17：可关闭可替换——变更 / 预览 / 待办） */
	const [sidePanel, setSidePanel] = useState<SidePanel | null>(null);

	// 轮次结束时让会话列表快照失效（刷新「最后活跃」状态）
	useEffect(() => {
		if (trajectory.status === "idle") {
			void queryClient.invalidateQueries({ queryKey: ["sessions"] });
		}
	}, [trajectory.status, queryClient]);

	// 自动标题（session.titled）落地后刷新会话列表，侧栏立即显示新标题
	const titledCount = trajectory.items.filter(
		(i) => i.kind === "marker" && i.text.startsWith("会话已命名为")
	).length;
	useEffect(() => {
		if (titledCount > 0) {
			void queryClient.invalidateQueries({ queryKey: ["sessions"] });
		}
	}, [titledCount, queryClient]);

	// F7：轮次完成提醒——页面不可见时系统通知 + 提示音
	useEffect(() => {
		if (trajectory.status !== "idle" || trajectory.items.length === 0) return;
		const last = trajectory.items[trajectory.items.length - 1];
		if (!document.hidden || !current) return;
		void last;
		const title = `Shuyi Agent：${current.title} 已完成`;
		if ("Notification" in window) {
			if (Notification.permission === "granted") {
				new Notification(title, { body: "点击返回查看结果", silent: true });
			} else if (Notification.permission === "default") {
				void Notification.requestPermission();
			}
		}
		try {
			const ctx = new AudioContext();
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.frequency.value = 880;
			gain.gain.setValueAtTime(0.08, ctx.currentTime);
			gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
			osc.connect(gain).connect(ctx.destination);
			osc.start();
			osc.stop(ctx.currentTime + 0.4);
		} catch {
			/* 音频不可用时静默 */
		}
		// 仅在 running→idle 跳变时触发（items 变长但 status 不变的中间态不提醒）
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [trajectory.status]);

	// F6：全局快捷键——Ctrl+K 命令面板；Ctrl+N 新会话（聚焦侧栏按钮）
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setPaletteOpen((v) => !v);
			}
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
				e.preventDefault();
				document
					.querySelector<HTMLButtonElement>("[data-action=new-session]")
					?.click();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const togglePanel = (p: SidePanel) =>
		setSidePanel((cur) => (cur === p ? null : p));

	const paletteActions: PaletteAction[] = [
		...(current
			? [
					{
						hint: "审查 agent 的文件改动（F2）",
						id: "changes",
						label: "打开变更面板",
						run: () => setSidePanel("changes"),
					},
					{
						hint: "内嵌浏览器（F10）",
						id: "preview",
						label: "打开预览面板",
						run: () => setSidePanel("preview"),
					},
					{
						hint: "会话任务清单",
						id: "todo",
						label: "打开待办面板",
						run: () => setSidePanel("todo"),
					},
					{
						hint: "plan 模式只规划不改文件",
						id: "mode-toggle",
						label:
							current.mode === "plan"
								? "切换到 Build 模式"
								: "切换到 Plan 模式",
						run: () =>
							void setMode(
								"primary",
								current.mode === "plan" ? "build" : "plan"
							),
					},
					{
						hint: "rewind 到最近的用户消息",
						id: "rewind-latest",
						label: "回滚最近一轮（会话 + 代码）",
						run: () => {
							const lastUser = [...trajectory.items]
								.reverse()
								.find((i) => i.kind === "user");
							if (lastUser) {
								void useSessionStore
									.getState()
									.rewind("primary", lastUser.seq, "both");
							}
						},
					},
				]
			: []),
		{
			hint: "墨 / 纸",
			id: "theme",
			label: "切换主题",
			run: () =>
				document
					.querySelector<HTMLButtonElement>("[data-action=theme-toggle]")
					?.click(),
		},
		{
			hint: "Ctrl+N",
			id: "new-session",
			label: "新会话",
			run: () =>
				document
					.querySelector<HTMLButtonElement>("[data-action=new-session]")
					?.click(),
		},
	];

	return (
		<div className="flex h-dvh flex-col overflow-hidden">
			{/* titlebar · 40px（§17）：logo / 会话标题 / 状态徽章 / seq 读数 / ⌘K */}
			<header className="flex h-10 flex-none items-center gap-2.5 border-b bg-panel px-3.5">
				<div
					className="grid size-5 shrink-0 place-items-center rounded-xs bg-seal font-serif text-[11px] font-bold text-seal-foreground"
					style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,.22)" }}
				>
					书
				</div>
				<span className="max-w-[320px] truncate text-[12.5px] font-semibold">
					{current?.title ?? "Shuyi Agent"}
				</span>
				<StatusBadge status={trajectory.status} />
				<span className="flex-1" />
				{current && trajectory.lastSeq >= 0 && (
					<span className="label-mono tnum hidden text-[10px] text-faint sm:inline">
						seq {String(trajectory.lastSeq).padStart(4, "0")}
					</span>
				)}
				<Kbd className="hidden text-[10px] sm:inline-flex">⌘K</Kbd>
				{current && (
					<>
						<Button
							aria-label="变更面板"
							className={sidePanel === "changes" ? "text-primary" : ""}
							onClick={() => togglePanel("changes")}
							size="icon-sm"
							title="变更面板：审查 agent 的文件改动（F2）"
							variant="ghost"
						>
							<FileDiffIcon />
						</Button>
						<Button
							aria-label="预览面板"
							className={sidePanel === "preview" ? "text-primary" : ""}
							onClick={() => togglePanel("preview")}
							size="icon-sm"
							title="预览面板：内嵌浏览器（F10）"
							variant="ghost"
						>
							<MonitorIcon />
						</Button>
						{trajectory.todos.length > 0 && (
							<Button
								aria-label="待办面板"
								className={sidePanel === "todo" ? "text-primary" : ""}
								onClick={() => togglePanel("todo")}
								size="icon-sm"
								title="待办面板：会话任务清单"
								variant="ghost"
							>
								<ListTodoIcon />
							</Button>
						)}
					</>
				)}
				<ThemeToggle />
			</header>

			<div className="flex min-h-0 flex-1">
				{/* sidebar · 236–280px（§17）：会话列表是唯一常驻导航 */}
				<ErrorBoundary name="会话列表">
					<SessionList />
				</ErrorBoundary>

				{/* main · trajectory（§17）：事件流投影，composer 底部常驻 */}
				<div className="flex min-h-full min-w-0 flex-1">
					<Pane slot="primary" />
					{split && (
						<Pane
							className="border-l"
							onClose={closeSplit}
							slot="secondary"
							title={split.title}
						/>
					)}
				</div>

				{/* right panel · 296–420px（§17）：Tabs 变更 / 预览 / 待办，可关闭 */}
				{current && sidePanel && (
					<aside className="flex w-[296px] flex-none flex-col overflow-hidden border-l bg-panel">
						<Tabs
							className="flex min-h-0 flex-1 flex-col"
							onValueChange={(v) => {
								if (v) setSidePanel(v as SidePanel);
							}}
							value={sidePanel}
						>
							<div className="flex flex-none items-center border-b px-1.5">
								<TabsList className="h-10 flex-1" variant="line">
									<TabsTrigger value="changes">变更</TabsTrigger>
									<TabsTrigger value="preview">预览</TabsTrigger>
									<TabsTrigger value="todo">
										待办
										{trajectory.todos.length > 0 && (
											<span className="font-mono text-[10.5px] text-primary">
												{trajectory.todos.length}
											</span>
										)}
									</TabsTrigger>
								</TabsList>
								<Button
									aria-label="关闭面板"
									onClick={() => setSidePanel(null)}
									size="icon-sm"
									variant="ghost"
								>
									✕
								</Button>
							</div>
							<TabsContent
								className="min-h-0 flex-1 overflow-hidden"
								value="changes"
							>
								<ErrorBoundary name="变更面板">
									<ChangesPanel session={current} slot="primary" />
								</ErrorBoundary>
							</TabsContent>
							<TabsContent
								className="min-h-0 flex-1 overflow-hidden"
								value="preview"
							>
								<ErrorBoundary name="预览面板">
									<PreviewPanel session={current} slot="primary" />
								</ErrorBoundary>
							</TabsContent>
							<TabsContent
								className="min-h-0 flex-1 overflow-hidden"
								value="todo"
							>
								<ErrorBoundary name="任务面板">
									<TodoPanel slot="primary" />
								</ErrorBoundary>
							</TabsContent>
						</Tabs>
					</aside>
				)}
			</div>

			<CommandPalette
				actions={paletteActions}
				onClose={() => setPaletteOpen(false)}
				open={paletteOpen}
			/>
		</div>
	);
}

/** M5：单个会话栏（主/右栏复用）——Trajectory + Composer + 审批浮层 */
function Pane({
	slot,
	title,
	onClose,
	className,
}: {
	slot: PaneSlot;
	title?: string;
	onClose?: () => void;
	className?: string;
}) {
	return (
		<section
			className={`relative flex min-h-full min-w-0 flex-1 flex-col bg-background ${className ?? ""}`}
		>
			{onClose && (
				<div className="flex h-9 flex-none items-center gap-2 border-b bg-panel px-3">
					<span className="truncate text-xs font-semibold">{title}</span>
					<span className="flex-1" />
					<Button
						aria-label="收起分栏"
						onClick={onClose}
						size="icon-sm"
						title="收起分栏"
						variant="ghost"
					>
						✕
					</Button>
				</div>
			)}
			<ErrorBoundary name="对话区">
				<Trajectory slot={slot} />
			</ErrorBoundary>
			<ErrorBoundary name="输入区">
				<Composer slot={slot} />
			</ErrorBoundary>
			<ApprovalDialog slot={slot} />
		</section>
	);
}
