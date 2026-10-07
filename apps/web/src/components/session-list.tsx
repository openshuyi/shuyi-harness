import type { AgentInfo, SessionRecord } from "@shuyi-harness/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

	const [theme, setTheme] = useState<string>(
		() => document.documentElement.dataset.theme ?? "dark"
	);
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
	const toggleTheme = () => {
		const next = theme === "dark" ? "light" : "dark";
		document.documentElement.dataset.theme = next;
		localStorage.setItem("shuyi-theme", next);
		setTheme(next);
	};

	return (
		<div className="sidebar">
			<div className="sidebar-header">
				<div
					style={{
						alignItems: "center",
						display: "flex",
						justifyContent: "space-between",
					}}
				>
					<h1>
						<span className="brand-dot">◆</span>Shuyi Agent
					</h1>
					<button
						className="theme-toggle"
						onClick={toggleTheme}
						title={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
					>
						{theme === "dark" ? "☀" : "☾"}
					</button>
				</div>
				<input
					className="search-box"
					onChange={(e) => setNewCwd(e.target.value)}
					placeholder="工作区绝对路径，如 /Users/you/project"
					style={{ boxSizing: "border-box", marginBottom: 6, width: "100%" }}
					title="新会话的工作区（agent 的工作目录，写操作限制在内；支持 ~ 前缀）"
					value={newCwd}
				/>
				<div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
					<button
						className="primary"
						disabled={createMutation.isPending || newCwd.trim().length === 0}
						onClick={() => createMutation.mutate()}
						style={{ flex: 1 }}
					>
						+ 新会话
					</button>
					{/* M5：选择起始代理 */}
					<select
						onChange={(e) => setNewAgent(e.target.value)}
						style={{ maxWidth: 110 }}
						title="新会话的起始代理"
						value={newAgent}
					>
						{[...new Set(["build", ...agents.map((a) => a.name)])].map(
							(name) => (
								<option key={name} value={name}>
									{name}
								</option>
							)
						)}
					</select>
				</div>
				{/* P1-6：worktree 隔离开关 */}
				<label
					className="worktree-toggle"
					title="在独立 git worktree 中运行会话：并行会话写文件互不干扰，完成后可合并回主分支"
				>
					<input
						checked={newWorktree}
						onChange={(e) => setNewWorktree(e.target.checked)}
						type="checkbox"
					/>
					⎇ worktree 隔离
				</label>
				<input
					className="search-box"
					onChange={(e) => {
						setQuery(e.target.value);
						setSearching(e.target.value.trim().length > 0);
					}}
					placeholder="搜索历史消息…"
					value={query}
				/>
			</div>
			<div className="session-list">
				{sessionsFailed && (
					<div style={{ color: "#f87171", fontSize: 12, padding: 12 }}>
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
						<div className="search-hint">{hits.length} 条命中</div>
						{hits.map((h, i) => (
							<div
								className="session-item"
								key={i}
								onClick={() => jumpTo(h.session_id)}
							>
								<div>{h.session_title}</div>
								<div className="meta">{h.snippet}</div>
							</div>
						))}
					</>
				) : (
					<>
						{(() => {
							// F8：分组渲染——置顶 / 进行中 / 空闲
							const renderItem = (s: SessionRecord) => {
								// M5：聚合流驱动的实时状态叠加（非可见会话），查询结果兜底
								const status = liveStatus[s.session_id] ?? s.status;
								const alerted = s.session_id in approvalAlerts;
								const isSplit = split?.session_id === s.session_id;
								return (
									<div
										className={`session-item ${current?.session_id === s.session_id ? "active" : ""} ${alerted ? "alert-flash" : ""}`}
										key={s.session_id}
										onClick={() => selectSession(s)}
									>
										<div>
											<span className={`status-dot ${status}`} />
											{s.title}
											{/* F8：置顶按钮 */}
											<button
												className={`pin-btn ${pins.includes(s.session_id) ? "on" : ""}`}
												onClick={(e) => {
													e.stopPropagation();
													togglePin(s.session_id);
												}}
												title={
													pins.includes(s.session_id) ? "取消置顶" : "置顶"
												}
											>
												📌
											</button>
											{/* M5：分栏按钮（当前主栏会话不显示） */}
											{current?.session_id !== s.session_id && (
												<button
													className={`split-btn ${isSplit ? "on" : ""}`}
													onClick={(e) => {
														e.stopPropagation();
														if (isSplit) closeSplit();
														else openSplit(s);
													}}
													title={isSplit ? "收起分栏" : "在右栏并行打开"}
												>
													⇄
												</button>
											)}
										</div>
										<div className="meta">
											{s.agent ?? "build"} · {s.mode} · {s.model}
											{(s.activeCallCount ?? 0) > 0 && (
												<> · ⏸{s.activeCallCount}</>
											)}
											{s.usage &&
												(s.usage.prompt_tokens > 0 ||
													s.usage.completion_tokens > 0) && (
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
												<> · ${s.usage.cost_usd.toFixed(4)}</>
											)}
										</div>
										{/* P1-6：worktree 徽标 + 合并/放弃（空闲时） */}
										{s.worktree && (
											<div
												className="worktree-row"
												onClick={(e) => e.stopPropagation()}
											>
												<span
													className="worktree-badge"
													title={s.worktree.worktree_path}
												>
													⎇ {s.worktree.branch}
												</span>
												{status === "idle" && (
													<>
														<button
															className="worktree-action"
															onClick={async () => {
																const r = await fetchJson<{
																	ok: boolean;
																	error?: string;
																}>(
																	`/api/sessions/${s.session_id}/worktree/merge`,
																	{ method: "POST" }
																).catch((e) => ({
																	error: String(e),
																	ok: false,
																}));
																if (!r.ok)
																	alert(`合并失败：${r.error ?? "未知错误"}`);
																void queryClient.invalidateQueries({
																	queryKey: ["sessions"],
																});
															}}
															title="把 worktree 分支合并回主分支并清理"
														>
															⇪ 合并
														</button>
														<button
															className="worktree-action danger-text"
															onClick={async () => {
																if (
																	!confirm(
																		"放弃此 worktree？未合并的改动将丢失。"
																	)
																)
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
														>
															× 放弃
														</button>
													</>
												)}
											</div>
										)}
									</div>
								);
							};
							const byId = (list: SessionRecord[]) => list;
							const pinned = byId(
								sessions.filter((s) => pins.includes(s.session_id))
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
								{ items: pinned, label: "📌 置顶" },
								{ items: running, label: "● 进行中" },
								{ items: idleList, label: "○ 空闲" },
							].filter((g) => g.items.length > 0);
							const showHeaders = pinned.length > 0 || running.length > 0;
							return groups.map((g) => (
								<div key={g.label}>
									{showHeaders && (
										<div className="session-group-label">{g.label}</div>
									)}
									{g.items.map(renderItem)}
								</div>
							));
						})()}
						{sessions.length === 0 && (
							<div
								style={{ color: "var(--text-dim)", fontSize: 12, padding: 12 }}
							>
								暂无会话，点击上方按钮创建
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}
