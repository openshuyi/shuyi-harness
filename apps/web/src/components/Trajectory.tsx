/**
 * Trajectory 视图：按事件流渲染时间线（消息 / 工具卡片 / 标记）。
 */
import { useEffect, useRef, useState } from "react";
import type { TimelineItem } from "../core/reducer.js";
import { useSessionStore } from "../core/store.js";

const STATUS_LABEL: Record<string, string> = {
  proposed: "已提议",
  awaiting: "待审批",
  running: "执行中",
  done: "完成",
  failed: "失败",
  denied: "已拒绝",
};

function ToolCard({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  const [expanded, setExpanded] = useState(item.status === "failed" || item.status === "denied");
  return (
    <div className="tool-card">
      <div className="tool-card-header" onClick={() => setExpanded(!expanded)}>
        <span>{expanded ? "▾" : "▸"}</span>
        <span className="tool-name">{item.tool}</span>
        <span className={`tool-badge ${item.status}`}>{STATUS_LABEL[item.status]}</span>
        {item.durationMs !== undefined && (
          <span className="tool-duration">{item.durationMs}ms</span>
        )}
      </div>
      {expanded && (
        <div className="tool-card-body">
          <pre>{JSON.stringify(item.args, null, 2)}</pre>
          {item.output && <pre style={{ marginTop: 8 }}>{item.output}</pre>}
          {item.result && <pre style={{ marginTop: 8 }}>{item.result}</pre>}
          {item.error && <pre style={{ marginTop: 8, color: "var(--red)" }}>{item.error}</pre>}
          {item.diff && (
            <pre style={{ marginTop: 8 }}>
              {item.diff.split("\n").map((line, i) => (
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
                  {line}
                </div>
              ))}
            </pre>
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
    case "user": return "user";
    case "assistant": return "assistant";
    case "tool": return "tool";
    case "marker": return "system";
  }
}

export function Trajectory() {
  const { trajectory, current, rollback } = useSessionStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Set<SourceFilter>>(new Set());
  const [rollingBack, setRollingBack] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [trajectory.items.length, trajectory.items]);

  if (!current) {
    return (
      <div className="trajectory">
        <div className="empty-state">
          选择或创建一个会话开始
          <br />
          <small>Mock 模型下可用 !write / !read / !bash 指令体验工具调用与审批流</small>
        </div>
      </div>
    );
  }

  const visible = trajectory.items.filter((i) => !hidden.has(itemSource(i)));
  const toggle = (f: SourceFilter) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });

  return (
    <div className="trajectory">
      <div className="trajectory-filter">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`filter-chip ${hidden.has(f.id) ? "off" : "on"} source-${f.id}`}
            onClick={() => toggle(f.id)}
            title={hidden.has(f.id) ? `显示${f.label}` : `隐藏${f.label}`}
          >
            {f.label}
          </button>
        ))}
        {trajectory.baselines.length > 0 && trajectory.status === "idle" && (
          <button
            className="filter-chip"
            disabled={rollingBack}
            title={`回滚工作区到本轮开始前的状态（git reset 到 ${trajectory.baselines[trajectory.baselines.length - 1].baseCommit}）`}
            onClick={() => {
              const base = trajectory.baselines[trajectory.baselines.length - 1];
              if (!confirm(`确定回滚？工作区将恢复到最近一轮开始前的状态（提交 ${base.baseCommit}）。\n当前未提交改动会先自动保存为一个提交。`)) return;
              setRollingBack(true);
              rollback(base.baseCommit)
                .catch((err) => alert(err instanceof Error ? err.message : String(err)))
                .finally(() => setRollingBack(false));
            }}
          >
            {rollingBack ? "回滚中…" : "↩ 撤销本轮改动"}
          </button>
        )}
        <a
          className="filter-chip replay-link"
          href={`/api/sessions/${current.session_id}/replay`}
          download
          title="导出会话回放（自包含 HTML，可分享）"
        >
          ⬇ 回放
        </a>
      </div>
      {visible.map((item) => {
        switch (item.kind) {
          case "user":
            return (
              <div className="msg" key={item.key}>
                <div className="msg-user">{item.text}</div>
              </div>
            );
          case "assistant":
            return (
              <div className="msg" key={item.key}>
                <div className="msg-label">助手{item.streaming ? "（输出中…）" : ""}</div>
                <div className="msg-assistant">{item.text}</div>
              </div>
            );
          case "tool":
            return <ToolCard key={item.key} item={item} />;
          case "marker":
            return (
              <div className={`marker ${item.tone}`} key={item.key}>
                — {item.text} —
              </div>
            );
        }
      })}
      <div ref={bottomRef} />
    </div>
  );
}
