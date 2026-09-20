/**
 * Trajectory 视图：按事件流渲染时间线（消息 / 工具卡片 / 标记）。
 * v0.4：助手消息 Markdown 渲染；用户消息悬浮操作（回滚三模式 / 分叉 / 编辑重发）；
 *      plan 模式闲置时展示计划批准卡片。
 */
import { useEffect, useRef, useState } from "react";
import type { TimelineItem } from "../core/reducer.js";
import { useSessionStore, type PaneSlot } from "../core/store.js";
import { Markdown } from "./Markdown.js";

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
          {item.result && <Markdown text={item.result} className="tool-result-md" />}
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

/** F1/F9：用户消息悬浮操作条 */
function UserActions({
  slot,
  seq,
  text,
  idle,
}: {
  slot: PaneSlot;
  seq: number;
  text: string;
  idle: boolean;
}) {
  const { rewind, forkSession, requestEdit } = useSessionStore();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const doRewind = async (mode: "code" | "conversation" | "both") => {
    setBusy(true);
    setOpen(false);
    try {
      await rewind(slot, seq, mode);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="msg-actions" ref={ref}>
      <button
        className="msg-action"
        disabled={!idle || busy}
        title="回滚到这条消息（之后的内容按所选范围撤销）"
        onClick={() => setOpen((v) => !v)}
      >
        ↩
      </button>
      <button
        className="msg-action"
        disabled={!idle || busy}
        title="编辑这条消息并重发（之后的内容从会话中移除）"
        onClick={() => requestEdit(slot, seq, text)}
      >
        ✎
      </button>
      <button
        className="msg-action"
        disabled={busy}
        title="从此处分叉新会话（复制到此处为止的历史）"
        onClick={() => {
          void forkSession(slot, seq)
            .then((s) => {
              if (s) useSessionStore.getState().selectSession(s);
            })
            .catch((err) => alert(err instanceof Error ? err.message : String(err)));
        }}
      >
        ⑂
      </button>
      {open && (
        <div className="rewind-pop">
          <button onClick={() => void doRewind("both")}>
            <b>会话 + 代码</b>
            <span>轨迹截断到此处，并恢复此消息之后的文件改动</span>
          </button>
          <button onClick={() => void doRewind("conversation")}>
            <b>仅会话</b>
            <span>轨迹截断到此处，文件保持现状</span>
          </button>
          <button onClick={() => void doRewind("code")}>
            <b>仅代码</b>
            <span>恢复此消息之后的文件改动，会话历史保留</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** F5：计划批准卡片（plan 模式 + 闲置 + 最后一条为完成的助手消息） */
function PlanCard({ slot, planText }: { slot: PaneSlot; planText: string }) {
  const { approvePlan } = useSessionStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(planText);
  const [busy, setBusy] = useState(false);
  const approve = async () => {
    setBusy(true);
    try {
      await approvePlan(slot, editing && draft !== planText ? draft : undefined);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="plan-card">
      <div className="plan-card-title">📋 计划待批准</div>
      {editing ? (
        <textarea
          className="plan-editor"
          rows={Math.min(18, draft.split("\n").length + 2)}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : null}
      <div className="plan-card-actions">
        <button className="plan-approve" disabled={busy} onClick={() => void approve()}>
          {busy ? "启动中…" : editing ? "批准（含修订）并执行" : "批准并执行"}
        </button>
        <button className="plan-edit" disabled={busy} onClick={() => setEditing((v) => !v)}>
          {editing ? "收起编辑" : "编辑计划"}
        </button>
      </div>
    </div>
  );
}

export function Trajectory({ slot = "primary" }: { slot?: PaneSlot }) {
  const trajectory = useSessionStore((s) => (slot === "secondary" ? s.splitTrajectory : s.trajectory));
  const current = useSessionStore((s) => (slot === "secondary" ? s.split : s.current));
  const { rollback } = useSessionStore();
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
          <div className="empty-brand">Shuyi Agent</div>
          <div>选择左侧会话，或点击「+ 新会话」开始</div>
          <div className="empty-hints">
            <span className="empty-hint"><code>/</code> 斜杠命令</span>
            <span className="empty-hint"><code>@</code> 引用文件</span>
            <span className="empty-hint"><code>Ctrl+K</code> 命令面板</span>
            <span className="empty-hint">⇄ 双栏并行</span>
            <span className="empty-hint">⎇ worktree 隔离</span>
            <span className="empty-hint">↩ 检查点回滚</span>
          </div>
        </div>
      </div>
    );
  }

  const visible = trajectory.items.filter((i) => !hidden.has(itemSource(i)));
  const idle = trajectory.status === "idle";
  const lastAssistant = [...trajectory.items].reverse().find(
    (i): i is Extract<TimelineItem, { kind: "assistant" }> => i.kind === "assistant" && !i.streaming && i.text.trim().length > 0,
  );
  // F5：计划卡片条件——plan 模式、闲置、最近一条可见内容是助手消息
  const showPlanCard =
    current.mode === "plan" &&
    idle &&
    lastAssistant !== undefined &&
    visible.length > 0 &&
    visible[visible.length - 1] === lastAssistant;

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
        {trajectory.baselines.length > 0 && idle && (
          <button
            className="filter-chip"
            disabled={rollingBack}
            title={`回滚工作区到本轮开始前的状态（git reset 到 ${trajectory.baselines[trajectory.baselines.length - 1].baseCommit}）`}
            onClick={() => {
              const base = trajectory.baselines[trajectory.baselines.length - 1];
              if (!confirm(`确定回滚？工作区将恢复到最近一轮开始前的状态（提交 ${base.baseCommit}）。\n当前未提交改动会先自动保存为一个提交。`)) return;
              setRollingBack(true);
              rollback(slot, base.baseCommit)
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
                <div className="msg-user">
                  {item.text}
                  <UserActions slot={slot} seq={item.seq} text={item.text} idle={idle} />
                </div>
              </div>
            );
          case "assistant":
            return (
              <div className="msg" key={item.key}>
                <div className="msg-label">
                  助手{item.streaming ? <span className="shimmer"> · 输出中…</span> : ""}
                </div>
                <div className="msg-assistant">
                  <Markdown text={item.text} />
                </div>
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
      {showPlanCard && <PlanCard slot={slot} planText={lastAssistant.text} />}
      <div ref={bottomRef} />
    </div>
  );
}
