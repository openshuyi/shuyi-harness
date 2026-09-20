import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentInfo, SessionRecord } from "@shuyi/types";
import { useSessionStore } from "../core/store.js";
import { fetchJson, fetchJsonArray } from "../core/api.js";

interface SearchHit {
  session_id: string;
  session_title: string;
  seq: number;
  type: string;
  snippet: string;
  ts: number;
}

async function fetchSessions(): Promise<SessionRecord[]> {
  return fetchJsonArray<SessionRecord>("/api/sessions");
}

export function SessionList() {
  const queryClient = useQueryClient();
  const { current, split, selectSession, openSplit, closeSplit, approvalAlerts, liveStatus } =
    useSessionStore();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  /** M5：新会话的起始代理（内置 build 为缺省） */
  const [newAgent, setNewAgent] = useState("build");
  /** P1-6：新会话是否在独立 git worktree 中运行（并行写隔离） */
  const [newWorktree, setNewWorktree] = useState(false);

  // M5：新会话代理选项（cwd 取当前会话或缺省项目目录）
  const { data: agents = [] } = useQuery<AgentInfo[]>({
    queryKey: ["agents", current?.cwd],
    queryFn: async () => {
      try {
        return await fetchJsonArray<AgentInfo>(
          `/api/agents${current ? `?cwd=${encodeURIComponent(current.cwd)}` : ""}`,
        );
      } catch {
        return [];
      }
    },
  });

  const {
    data: sessions = [],
    error: sessionsError,
    isError: sessionsFailed,
  } = useQuery({
    queryKey: ["sessions"],
    queryFn: fetchSessions,
    refetchInterval: 5000,
    retry: 1,
  });

  const { data: hits = [] } = useQuery<SearchHit[]>({
    queryKey: ["search", query],
    queryFn: async () => fetchJsonArray<SearchHit>(`/api/search?q=${encodeURIComponent(query)}`),
    enabled: searching && query.trim().length > 0,
    retry: 1,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      return fetchJson<SessionRecord>("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cwd: "/mnt/agents/output",
          // M5：起始代理（build 为缺省，不传递以兼容旧服务端）
          ...(newAgent && newAgent !== "build" ? { agent: newAgent } : {}),
          // P1-6：worktree 隔离
          ...(newWorktree ? { worktree: true } : {}),
        }),
      });
    },
    onSuccess: (session) => {
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
    () => document.documentElement.dataset.theme ?? "dark",
  );
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("shuyi-theme", next);
    setTheme(next);
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
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
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <button
            className="primary"
            style={{ flex: 1 }}
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
          >
            + 新会话
          </button>
          {/* M5：选择起始代理 */}
          <select
            value={newAgent}
            onChange={(e) => setNewAgent(e.target.value)}
            title="新会话的起始代理"
            style={{ maxWidth: 110 }}
          >
            {[...new Set(["build", ...agents.map((a) => a.name)])].map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        {/* P1-6：worktree 隔离开关 */}
        <label className="worktree-toggle" title="在独立 git worktree 中运行会话：并行会话写文件互不干扰，完成后可合并回主分支">
          <input
            type="checkbox"
            checked={newWorktree}
            onChange={(e) => setNewWorktree(e.target.checked)}
          />
          ⎇ worktree 隔离
        </label>
        <input
          className="search-box"
          placeholder="搜索历史消息…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSearching(e.target.value.trim().length > 0);
          }}
        />
      </div>
      <div className="session-list">
        {sessionsFailed && (
          <div style={{ padding: 12, fontSize: 12, color: "#f87171" }}>
            无法连接后端服务（localhost:4291）。
            <br />
            {sessionsError instanceof Error ? sessionsError.message : String(sessionsError)}
            <br />
            请确认 server 已启动；若使用代理/VPN 软件或浏览器扩展，请将 localhost 加入直连白名单。
          </div>
        )}
        {searching && query.trim() ? (
          <>
            <div className="search-hint">{hits.length} 条命中</div>
            {hits.map((h, i) => (
              <div key={i} className="session-item" onClick={() => jumpTo(h.session_id)}>
                <div>{h.session_title}</div>
                <div className="meta">{h.snippet}</div>
              </div>
            ))}
          </>
        ) : (
          <>
            {sessions.map((s) => {
              // M5：聚合流驱动的实时状态叠加（非可见会话），查询结果兜底
              const status = liveStatus[s.session_id] ?? s.status;
              const alerted = s.session_id in approvalAlerts;
              const isSplit = split?.session_id === s.session_id;
              return (
                <div
                  key={s.session_id}
                  className={`session-item ${current?.session_id === s.session_id ? "active" : ""} ${alerted ? "alert-flash" : ""}`}
                  onClick={() => selectSession(s)}
                >
                  <div>
                    <span className={`status-dot ${status}`} />
                    {s.title}
                    {/* M5：分栏按钮（当前主栏会话不显示） */}
                    {current?.session_id !== s.session_id && (
                      <button
                        className={`split-btn ${isSplit ? "on" : ""}`}
                        title={isSplit ? "收起分栏" : "在右栏并行打开"}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isSplit) closeSplit();
                          else openSplit(s);
                        }}
                      >
                        ⇄
                      </button>
                    )}
                  </div>
                  <div className="meta">
                    {s.agent ?? "build"} · {s.mode} · {s.model}
                    {(s.activeCallCount ?? 0) > 0 && <> · ⏸{s.activeCallCount}</>}
                    {s.usage && (s.usage.prompt_tokens > 0 || s.usage.completion_tokens > 0) && (
                      <> · {(s.usage.prompt_tokens + s.usage.completion_tokens).toLocaleString()} tok</>
                    )}
                    {s.usage?.cost_usd != null && <> · ${s.usage.cost_usd.toFixed(4)}</>}
                  </div>
                  {/* P1-6：worktree 徽标 + 合并/放弃（空闲时） */}
                  {s.worktree && (
                    <div className="worktree-row" onClick={(e) => e.stopPropagation()}>
                      <span className="worktree-badge" title={s.worktree.worktree_path}>
                        ⎇ {s.worktree.branch}
                      </span>
                      {status === "idle" && (
                        <>
                          <button
                            className="worktree-action"
                            title="把 worktree 分支合并回主分支并清理"
                            onClick={async () => {
                              const r = await fetchJson<{ ok: boolean; error?: string }>(
                                `/api/sessions/${s.session_id}/worktree/merge`,
                                { method: "POST" },
                              ).catch((e) => ({ ok: false, error: String(e) }));
                              if (!r.ok) alert(`合并失败：${r.error ?? "未知错误"}`);
                              void queryClient.invalidateQueries({ queryKey: ["sessions"] });
                            }}
                          >
                            ⇪ 合并
                          </button>
                          <button
                            className="worktree-action danger-text"
                            title="放弃 worktree（未合并改动将丢失）"
                            onClick={async () => {
                              if (!confirm("放弃此 worktree？未合并的改动将丢失。")) return;
                              await fetch(`/api/sessions/${s.session_id}/worktree/discard`, { method: "POST" });
                              void queryClient.invalidateQueries({ queryKey: ["sessions"] });
                            }}
                          >
                            × 放弃
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {sessions.length === 0 && (
              <div style={{ padding: 12, fontSize: 12, color: "var(--text-dim)" }}>
                暂无会话，点击上方按钮创建
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
