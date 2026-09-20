/**
 * F2（v0.4）：变更面板——会话内被快照文件的 before/after unified diff 聚合，
 * 逐文件 接受（清快照）/ 撤销（恢复内容）。turn 结束与审查操作后自动刷新。
 */
import { useEffect, useState } from "react";
import type { SessionRecord } from "@shuyi/types";
import { useSessionStore, type PaneSlot } from "../core/store.js";
import { fetchJson } from "../core/api.js";

interface FileChange {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
}

export function ChangesPanel({
  slot = "primary",
  session,
  onClose,
}: {
  slot?: PaneSlot;
  session: SessionRecord;
  onClose: () => void;
}) {
  const trajectory = useSessionStore((s) => (slot === "secondary" ? s.splitTrajectory : s.trajectory));
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const idle = trajectory.status === "idle";

  const refresh = async () => {
    try {
      const data = await fetchJson<{ changes: FileChange[] }>(
        `/api/sessions/${session.session_id}/changes`,
      );
      setChanges(data.changes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // 打开时 + 每轮结束后刷新
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.session_id, idle]);

  const review = async (path: string, action: "accept" | "revert") => {
    try {
      const res = await fetch(`/api/sessions/${session.session_id}/changes/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, action }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `操作失败 ${res.status}`);
      }
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const totalAdd = changes.reduce((a, c) => a + c.additions, 0);
  const totalDel = changes.reduce((a, c) => a + c.deletions, 0);

  return (
    <div className="side-panel changes-panel">
      <div className="side-panel-head">
        <span>变更</span>
        <span className="changes-stat">
          {changes.length} 个文件 <em className="add">+{totalAdd}</em> <em className="del">−{totalDel}</em>
        </span>
        <button className="side-panel-close" onClick={onClose} title="关闭">×</button>
      </div>
      {error && <div className="marker error">— {error} —</div>}
      {!error && changes.length === 0 && (
        <div className="changes-empty">暂无待审变更（agent 修改文件后在此审查）</div>
      )}
      {changes.map((ch) => {
        const open = expanded.has(ch.path);
        return (
          <div key={ch.path} className="change-file">
            <div
              className="change-file-head"
              onClick={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(ch.path)) next.delete(ch.path); else next.add(ch.path);
                  return next;
                })
              }
            >
              <span>{open ? "▾" : "▸"}</span>
              <span className="change-path" title={ch.path}>{ch.path}</span>
              <em className="add">+{ch.additions}</em>
              <em className="del">−{ch.deletions}</em>
              <button
                className="change-accept"
                disabled={!idle}
                title="接受：保留当前内容，清除快照"
                onClick={(e) => {
                  e.stopPropagation();
                  void review(ch.path, "accept");
                }}
              >
                ✓
              </button>
              <button
                className="change-revert"
                disabled={!idle}
                title="撤销：恢复到修改前内容"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`撤销对 ${ch.path} 的修改？`)) void review(ch.path, "revert");
                }}
              >
                ↩
              </button>
            </div>
            {open && (
              <pre className="change-diff">
                {ch.diff.split("\n").map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.startsWith("+") && !line.startsWith("+++")
                        ? "diff-line-add"
                        : line.startsWith("-") && !line.startsWith("---")
                          ? "diff-line-del"
                          : "diff-line-meta"
                    }
                  >
                    {line || " "}
                  </div>
                ))}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
