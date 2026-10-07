import type { SessionRecord } from "@shuyi-harness/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { fetchJson, fetchJsonArray } from "../core/api.js";
import { useSessionStore } from "../core/store.js";

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

const CWD_KEY = "shuyi.lastCwd";

export function SessionList() {
	const queryClient = useQueryClient();
	const { current, selectSession } = useSessionStore();
	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const [cwd, setCwd] = useState("");

	// 记住上次使用的工作区路径（本机个人版，localStorage 足够）
	useEffect(() => {
		setCwd(localStorage.getItem(CWD_KEY) ?? "");
	}, []);

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
		mutationFn: async () =>
			fetchJson<SessionRecord>("/api/sessions", {
				body: JSON.stringify({ cwd }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
		onSuccess: (session) => {
			localStorage.setItem(CWD_KEY, cwd);
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

	return (
		<div className="sidebar">
			<div className="sidebar-header">
				<h1>Agent</h1>
				<input
					className="search-box"
					onChange={(e) => setCwd(e.target.value)}
					placeholder="工作区绝对路径，如 /Users/you/project"
					style={{ boxSizing: "border-box", marginBottom: 8, width: "100%" }}
					title="新会话的工作区（agent 的工作目录，写操作限制在内）"
					value={cwd}
				/>
				<button
					className="primary"
					disabled={createMutation.isPending || cwd.trim().length === 0}
					onClick={() => createMutation.mutate()}
					style={{ marginBottom: 8, width: "100%" }}
				>
					+ 新会话
				</button>
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
						{sessions.map((s) => (
							<div
								className={`session-item ${current?.session_id === s.session_id ? "active" : ""}`}
								key={s.session_id}
								onClick={() => selectSession(s)}
							>
								<div>
									<span className={`status-dot ${s.status}`} />
									{s.title}
								</div>
								<div className="meta">
									{s.mode} · {s.model}
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
								</div>
							</div>
						))}
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
