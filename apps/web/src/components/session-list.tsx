/**
 * 会话列表（墨仪 §11）：唯一常驻导航。
 * 分组头 label-mono + 计数；置顶项 2px accent 竖线；选中项 accent-soft 底；
 * meta 行是仪器读数（mono tabular）。状态点 = 系统指示灯。
 */
import type { AgentInfo, SessionRecord } from "@shuyi-harness/types";
import { Button } from "@shuyi-harness/ui/components/ui/button";
import { Kbd } from "@shuyi-harness/ui/components/ui/kbd";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@shuyi-harness/ui/components/ui/select";
import { StatusDot } from "@shuyi-harness/ui/components/ui/status-dot";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	CheckIcon,
	ColumnsIcon,
	GitBranchIcon,
	PinIcon,
	PlusIcon,
	SearchIcon,
	XIcon,
} from "lucide-react";
import { useState } from "react";
import { fetchJson, fetchJsonArray } from "../core/api.js";
import { useSessionStore } from "../core/store.js";

const CWD_KEY = "shuyi.lastCwd";

interface SearchHit {
	seq: number;
	session_id: string;
	session_title: string;
	snippet: string;
	ts: number;
	type: string;
}

async function fetchSessions(): Promise<SessionRecord[]> {
	return fetchJsonArray<SessionRecord>("/api/sessions");
}

/** 会话四态 → 指示灯（§04：进行中 pulse / 等待审批 pulse / 空闲 / 错误） */
function sessionTone(status: string): {
	pulse: boolean;
	tone: "accent" | "danger" | "idle" | "warning";
} {
	switch (status) {
		case "running":
			return { pulse: true, tone: "accent" };
		case "awaiting_approval":
			return { pulse: true, tone: "warning" };
		case "error":
			return { pulse: false, tone: "danger" };
		default:
			return { pulse: false, tone: "idle" };
	}
}

export function SessionList() {
	const queryClient = useQueryClient();
	const {
		current,
		split,
		selectSession,
		openSplit,
		closeSplit,
		approvalAlerts,
		liveStatus,
	} = useSessionStore();
	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	/** M5：新会话的起始代理（内置 build 为缺省） */
	const [newAgent, setNewAgent] = useState("build");
	/** P1-6：新会话是否在独立 git worktree 中运行（并行写隔离） */
	const [newWorktree, setNewWorktree] = useState(false);
	/** 工作区路径（localStorage 记忆上次使用；服务端支持 ~ 前缀展开） */
	const [newCwd, setNewCwd] = useState(
		() => localStorage.getItem(CWD_KEY) ?? ""
	);

	// M5：新会话代理选项（cwd 取当前会话或缺省项目目录）
	const { data: agents = [] } = useQuery<AgentInfo[]>({
		queryFn: async () => {
			try {
				return await fetchJsonArray<AgentInfo>(
					`/api/agents${current ? `?cwd=${encodeURIComponent(current.cwd)}` : ""}`
				);
			} catch {
				return [];
			}
		},
		queryKey: ["agents", current?.cwd],
	});

	const {
		data: sessions = [],
		error: sessionsError,
		isError: sessionsFailed,
	} = useQuery({
		queryFn: fetchSessions,
		queryKey: ["sessions"],
		refetchInterval: 5000,
		retry: 1,
	});

	const { data: hits = [] } = useQuery<SearchHit[]>({
		enabled: searching && query.trim().length > 0,
		queryFn: async () =>
			fetchJsonArray<SearchHit>(`/api/search?q=${encodeURIComponent(query)}`),
		queryKey: ["search", query],
		retry: 1,
	});

	const createMutation = useMutation({
		mutationFn: async () => {
			return fetchJson<SessionRecord>("/api/sessions", {
				body: JSON.stringify({
					cwd: newCwd,
					// M5：起始代理（build 为缺省，不传递以兼容旧服务端）
					...(newAgent && newAgent !== "build" ? { agent: newAgent } : {}),
					// P1-6：worktree 隔离
					...(newWorktree ? { worktree: true } : {}),
				}),
				headers: { "content-type": "application/json" },
				method: "POST",
			});
		},
		onSuccess: (session) => {
			localStorage.setItem(CWD_KEY, newCwd);
			void queryClient.invalidateQueries({ queryKey: ["sessions"] });
			selectSession(session);
		},
	});

	const jumpTo = (sessionId: string) => {
		const target = sessions.find((s) => s.session_id === sessionId);
		if (target) {
			selectSession(target);
		} else {
			// 会话可能不在当前列表（如已归档），直接拉取
			void fetch(`/api/sessions/${sessionId}`)
				.then((r) => (r.ok ? r.json() : null))
				.then((s) => s && selectSession(s as SessionRecord));
		}
	};

	/** F8（v0.4）：置顶会话（localStorage 持久） */
	const [pins, setPins] = useState<string[]>(
		() => JSON.parse(localStorage.getItem("shuyi-pins") ?? "[]") as string[]
	);
	const togglePin = (sessionId: string) => {
		setPins((prev) => {
			const next = prev.includes(sessionId)
				? prev.filter((id) => id !== sessionId)
				: [sessionId, ...prev];
			localStorage.setItem("shuyi-pins", JSON.stringify(next));
			return next;
		});
	};

	const renderItem = (s: SessionRecord) => {
		// M5：聚合流驱动的实时状态叠加（非可见会话），查询结果兜底
		const status = liveStatus[s.session_id] ?? s.status;
		const tone = sessionTone(status);
		const alerted = s.session_id in approvalAlerts;
		const isSplit = split?.session_id === s.session_id;
		const active = current?.session_id === s.session_id;
		const pinned = pins.includes(s.session_id);
		return (
			<div
				className={`group relative flex cursor-pointer items-start gap-2.5 rounded-sm px-2.5 py-2 transition-colors hover:bg-card ${
					active ? "bg-accent" : ""
				} ${alerted ? "ring-1 ring-warning" : ""}`}
				key={s.session_id}
				onClick={() => selectSession(s)}
			>
				{/* 置顶项 2px accent 竖线 */}
				{pinned && (
					<span className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-primary" />
				)}
				<StatusDot className="mt-[5px]" pulse={tone.pulse} tone={tone.tone} />
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1">
						<span
							className={`truncate text-[13px] ${active ? "text-primary" : "text-foreground"}`}
						>
							{s.title}
						</span>
						<span className="flex-1" />
						{/* F8：置顶 + M5：分栏（悬浮显形） */}
						<span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
							<button
								className={`grid size-5 place-items-center rounded-xs text-faint hover:bg-accent hover:text-foreground ${pinned ? "text-primary opacity-100!" : ""}`}
								onClick={(e) => {
									e.stopPropagation();
									togglePin(s.session_id);
								}}
								title={pinned ? "取消置顶" : "置顶"}
								type="button"
							>
								<PinIcon className="size-3" />
							</button>
							{!active && (
								<button
									className={`grid size-5 place-items-center rounded-xs text-faint hover:bg-accent hover:text-foreground ${isSplit ? "text-primary opacity-100!" : ""}`}
									onClick={(e) => {
										e.stopPropagation();
										if (isSplit) closeSplit();
										else openSplit(s);
									}}
									title={isSplit ? "收起分栏" : "在右栏并行打开"}
									type="button"
								>
									<ColumnsIcon className="size-3" />
								</button>
							)}
						</span>
					</div>
					<div className="label-mono tnum mt-0.5 truncate text-[10.5px] text-faint">
						{s.agent ?? "build"} · {s.model}
						{(s.activeCallCount ?? 0) > 0 && <> · ⏸{s.activeCallCount}</>}
						{s.usage &&
							(s.usage.prompt_tokens > 0 || s.usage.completion_tokens > 0) && (
								<>
									{" "}
									·{" "}
									{(
										s.usage.prompt_tokens + s.usage.completion_tokens
									).toLocaleString()}{" "}
									tok
								</>
							)}
						{s.usage?.cost_usd != null && (
							<> · ${s.usage.cost_usd.toFixed(3)}</>
						)}
					</div>
					{/* P1-6：worktree 徽标 + 合并/放弃（空闲时） */}
					{s.worktree && (
						<div
							className="mt-1 flex items-center gap-1.5"
							onClick={(e) => e.stopPropagation()}
						>
							<span
								className="inline-flex items-center gap-1 rounded-xs bg-inset px-1.5 py-0.5 font-mono text-[10.5px] text-info"
								title={s.worktree.worktree_path}
							>
								<GitBranchIcon className="size-2.5" />
								{s.worktree.branch}
							</span>
							{status === "idle" && (
								<>
									<button
										className="inline-flex items-center gap-0.5 rounded-xs px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
										onClick={async () => {
											const r = await fetchJson<{
												ok: boolean;
												error?: string;
											}>(`/api/sessions/${s.session_id}/worktree/merge`, {
												method: "POST",
											}).catch((e) => ({
												error: String(e),
												ok: false,
											}));
											if (!r.ok) alert(`合并失败：${r.error ?? "未知错误"}`);
											void queryClient.invalidateQueries({
												queryKey: ["sessions"],
											});
										}}
										title="把 worktree 分支合并回主分支并清理"
										type="button"
									>
										<CheckIcon className="size-2.5" />
										合并
									</button>
									<button
										className="inline-flex items-center gap-0.5 rounded-xs px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground transition-colors hover:bg-destructive-soft hover:text-destructive"
										onClick={async () => {
											if (!confirm("放弃此 worktree？未合并的改动将丢失。"))
												return;
											await fetch(
												`/api/sessions/${s.session_id}/worktree/discard`,
												{ method: "POST" }
											);
											void queryClient.invalidateQueries({
												queryKey: ["sessions"],
											});
										}}
										title="放弃 worktree（未合并改动将丢失）"
										type="button"
									>
										<XIcon className="size-2.5" />
										放弃
									</button>
								</>
							)}
						</div>
					)}
				</div>
			</div>
		);
	};

	return (
		<aside className="flex w-[236px] flex-none flex-col overflow-hidden border-r bg-panel">
			<div className="flex flex-none flex-col gap-1.5 p-2">
				{/* 新会话：cwd + 代理 + worktree + 按钮 */}
				<input
					className="h-[30px] w-full rounded-sm border border-input bg-inset px-2.5 text-xs text-foreground outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-line-strong focus:ring-[3px] focus:ring-ring"
					onChange={(e) => setNewCwd(e.target.value)}
					placeholder="工作区绝对路径，如 ~/project"
					title="新会话的工作区（agent 的工作目录，写操作限制在内；支持 ~ 前缀）"
					value={newCwd}
				/>
				<div className="flex items-center gap-1.5">
					<Button
						className="h-[30px] flex-1"
						data-action="new-session"
						disabled={createMutation.isPending || newCwd.trim().length === 0}
						onClick={() => createMutation.mutate()}
						size="sm"
					>
						<PlusIcon />
						新会话
					</Button>
					<Select
						onValueChange={(v) => {
							if (v) setNewAgent(v);
						}}
						value={newAgent}
					>
						<SelectTrigger
							className="h-[30px] min-w-0 rounded-sm px-2 font-mono text-[11px]"
							size="sm"
							title="新会话的起始代理"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent alignItemWithTrigger={false} className="min-w-32">
							{[...new Set(["build", ...agents.map((a) => a.name)])].map(
								(name) => (
									<SelectItem key={name} value={name}>
										{name}
									</SelectItem>
								)
							)}
						</SelectContent>
					</Select>
				</div>
				{/* P1-6：worktree 隔离开关 */}
				<label
					className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
					title="在独立 git worktree 中运行会话：并行会话写文件互不干扰，完成后可合并回主分支"
				>
					<input
						checked={newWorktree}
						className="size-3 accent-[var(--primary)]"
						onChange={(e) => setNewWorktree(e.target.checked)}
						type="checkbox"
					/>
					<GitBranchIcon className="size-3" />
					worktree 隔离
				</label>
				{/* §11 search：搜索历史消息 */}
				<div className="flex h-[30px] items-center gap-2 rounded-sm border border-input bg-inset px-2.5 text-faint">
					<SearchIcon className="size-3.5 shrink-0" />
					<input
						className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-faint"
						onChange={(e) => {
							setQuery(e.target.value);
							setSearching(e.target.value.trim().length > 0);
						}}
						placeholder="搜索历史消息…"
						value={query}
					/>
					<Kbd className="text-[10px]">⌘K</Kbd>
				</div>
			</div>

			{/* 列表主体 */}
			<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
				{sessionsFailed && (
					<div className="m-2 rounded-sm border-l-2 border-l-destructive bg-destructive-soft p-3 text-[11.5px] leading-relaxed text-muted-foreground">
						无法连接后端服务（localhost:4351）。
						<br />
						{sessionsError instanceof Error
							? sessionsError.message
							: String(sessionsError)}
						<br />
						请确认 server 已启动；若使用代理/VPN 软件或浏览器扩展，请将
						localhost 加入直连白名单。
					</div>
				)}
				{searching && query.trim() ? (
					<>
						<div className="label-mono px-2.5 pt-2 pb-1 text-faint">
							{hits.length} hits
						</div>
						{hits.map((h, i) => (
							<div
								className="cursor-pointer rounded-sm px-2.5 py-2 transition-colors hover:bg-card"
								key={i}
								onClick={() => jumpTo(h.session_id)}
							>
								<div className="truncate text-[13px]">{h.session_title}</div>
								<div className="mt-0.5 truncate text-[11px] text-faint">
									{h.snippet}
								</div>
							</div>
						))}
					</>
				) : (
					<>
						{(() => {
							// F8：分组渲染——置顶 / 进行中 / 空闲
							const pinned = sessions.filter((s) =>
								pins.includes(s.session_id)
							);
							const running = sessions.filter(
								(s) =>
									!pins.includes(s.session_id) &&
									((liveStatus[s.session_id] ?? s.status) === "running" ||
										(liveStatus[s.session_id] ?? s.status) ===
											"awaiting_approval")
							);
							const idleList = sessions.filter(
								(s) =>
									!pins.includes(s.session_id) &&
									(liveStatus[s.session_id] ?? s.status) !== "running" &&
									(liveStatus[s.session_id] ?? s.status) !== "awaiting_approval"
							);
							const groups = [
								{ items: pinned, label: "pinned" },
								{ items: running, label: "running" },
								{ items: idleList, label: "idle" },
							].filter((g) => g.items.length > 0);
							return groups.map((g) => (
								<div key={g.label}>
									<div className="label-mono flex items-center justify-between px-2.5 pt-2.5 pb-1">
										<span
											className={g.label === "pinned" ? "text-primary" : ""}
										>
											{g.label}
										</span>
										<span className="tnum text-faint">{g.items.length}</span>
									</div>
									{g.items.map(renderItem)}
								</div>
							));
						})()}
						{sessions.length === 0 && !sessionsFailed && (
							<div className="p-3 text-xs text-faint">
								暂无会话，点击上方按钮创建
							</div>
						)}
					</>
				)}
			</div>
		</aside>
	);
}
