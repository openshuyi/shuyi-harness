import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionRecord } from "@shuyi/types";
import { useSessionStore } from "../core/store.js";

interface SearchHit {
  session_id: string;
  session_title: string;
  seq: number;
  type: string;
  snippet: string;
  ts: number;
}

async function fetchSessions(): Promise<SessionRecord[]> {
  const res = await fetch("/api/sessions");
  return res.json();
}

export function SessionList() {
  const queryClient = useQueryClient();
  const { current, selectSession } = useSessionStore();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions"],
    queryFn: fetchSessions,
    refetchInterval: 5000,
  });

  const { data: hits = [] } = useQuery<SearchHit[]>({
    queryKey: ["search", query],
    queryFn: async () => (await fetch(`/api/search?q=${encodeURIComponent(query)}`)).json(),
    enabled: searching && query.trim().length > 0,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: "/mnt/agents/output" }),
      });
      return res.json() as Promise<SessionRecord>;
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
