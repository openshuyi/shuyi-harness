import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ModelInfo } from "@shuyi/types";
import { useSessionStore } from "../core/store.js";
import { fetchJsonArray } from "../core/api.js";

export function Composer() {
  const { current, trajectory, sendMessage, abort, setMode, setModel } = useSessionStore();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const { data: models = [] } = useQuery<ModelInfo[]>({
    queryKey: ["models"],
    queryFn: async () => {
      try {
        return await fetchJsonArray<ModelInfo>("/api/models");
      } catch {
        return [];
      }
    },
  });

  if (!current) return null;
  const busy = trajectory.status === "running" || trajectory.status === "awaiting_approval";

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setSending(true);
    try {
      await sendMessage(t);
      setText("");
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="composer">
      <div className="composer-toolbar">
        <select
          value={current.mode}
          onChange={(e) => void setMode(e.target.value as "plan" | "build")}
        >
          <option value="build">Build 模式</option>
          <option value="plan">Plan 模式</option>
        </select>
        <select value={current.model} onChange={(e) => void setModel(e.target.value)}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="usage">
          tokens: {trajectory.usage.prompt} in / {trajectory.usage.completion} out
        </span>
      </div>
      <div className="composer-row">
        <textarea
          rows={3}
          placeholder={busy ? "Agent 运行中…" : "输入消息，Enter 发送，Shift+Enter 换行"}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {busy ? (
          <button className="danger" onClick={() => void abort()}>
            中断
          </button>
        ) : (
          <button className="primary" onClick={() => void submit()} disabled={sending || !text.trim()}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
