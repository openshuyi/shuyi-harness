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

export function Trajectory() {
  const { trajectory, current } = useSessionStore();
  const bottomRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="trajectory">
      {trajectory.items.map((item) => {
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
