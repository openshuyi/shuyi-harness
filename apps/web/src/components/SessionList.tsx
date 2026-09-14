import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionRecord } from "@shuyi/types";
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
  const { current, selectSession } = useSessionStore();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

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
        body: JSON.stringify({ cwd: "/mnt/agents/output" }),
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

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h1>Agent</h1>
        <button
          className="primary"
          style={{ width: "100%", marginBottom: 8 }}
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
        >
          + 新会话
        </button>
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
            {sessions.map((s) => (
              <div
                key={s.session_id}
                className={`session-item ${current?.session_id === s.session_id ? "active" : ""}`}
                onClick={() => selectSession(s)}
              >
                <div>
                  <span className={`status-dot ${s.status}`} />
                  {s.title}
                </div>
                <div className="meta">
                  {s.mode} · {s.model}
                  {s.usage && (s.usage.prompt_tokens > 0 || s.usage.completion_tokens > 0) && (
                    <> · {(s.usage.prompt_tokens + s.usage.completion_tokens).toLocaleString()} tok</>
                  )}
                </div>
              </div>
            ))}
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
