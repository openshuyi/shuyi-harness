/**
 * 审批弹窗：支持批量审阅。
 * - 多个待审批调用排成队列，可逐个批准/拒绝，也可「全部批准/全部拒绝」
 * - 文件改动类工具（write/edit）展示新内容预览
 * - M3：「记住」支持四种粒度——不记住 / 放行此工具 / 仅此路径或命令 / 自定义 glob 模式
 */
import { useState } from "react";
import { useSessionStore, type PaneSlot } from "../core/store.js";
import type { PendingApproval } from "../core/reducer.js";

/** 从工具入参提取「目标文件」描述（用于批量队列的紧凑展示） */
function fileTarget(a: PendingApproval): string | null {
  const path = (a.args.path ?? a.args.file_path ?? a.args.filePath) as string | undefined;
  return path ?? null;
}

/** M3：细粒度规则的目标——bash 取完整命令行，文件类工具取路径 */
function ruleTarget(a: PendingApproval): string | null {
  if (typeof a.args.command === "string" && a.args.command) return a.args.command;
  return fileTarget(a);
}

/** 文件改动类工具的新内容预览 */
function contentPreview(a: PendingApproval): string | null {
  if (a.tool === "write") return (a.args.content as string) ?? null;
  if (a.tool === "edit") {
    const newStr = a.args.new_string ?? a.args.newString;
    return typeof newStr === "string" ? newStr : null;
  }
  return null;
}

type RememberMode = "none" | "tool" | "target" | "glob";

export function ApprovalDialog({ slot = "primary" }: { slot?: PaneSlot }) {
  const trajectory = useSessionStore((s) => (slot === "secondary" ? s.splitTrajectory : s.trajectory));
  const { resolveApproval } = useSessionStore();
  const [rememberMode, setRememberMode] = useState<RememberMode>("none");
  const [customGlob, setCustomGlob] = useState("");
  const [answerText, setAnswerText] = useState("");
  const [busy, setBusy] = useState(false);
  const approvals = trajectory.pendingApprovals;
  const approval = approvals[0];

  if (!approval) return null;

  // P0：question 工具——模型主动提问，走独立的问答界面（选项按钮 + 自由作答）
  if (approval.tool === "question") {
    const q = (approval.args.question as string) ?? "";
    const options = (approval.args.options as string[] | undefined) ?? [];
    const answer = async (text: string) => {
      setBusy(true);
      try {
        await resolveApproval(slot, approval.approvalId, "approve", false, undefined, text);
        setAnswerText("");
      } finally {
        setBusy(false);
      }
    };
    const decline = async () => {
      setBusy(true);
      try {
        await resolveApproval(slot, approval.approvalId, "deny", false, undefined);
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="approval-overlay in-pane">
        <div className="approval-dialog question-dialog">
          <h3>💬 模型向你提问</h3>
          <div className="question-text">{q}</div>
          {options.length > 0 && (
            <div className="question-options">
              {options.map((opt) => (
                <button key={opt} className="question-option" disabled={busy} onClick={() => void answer(opt)}>
                  {opt}
                </button>
              ))}
            </div>
          )}
          <div className="question-freeform">
            <input
              type="text"
              placeholder="自由作答…"
              value={answerText}
              disabled={busy}
              onChange={(e) => setAnswerText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && answerText.trim()) void answer(answerText.trim());
              }}
            />
            <button
              className="primary"
              disabled={busy || !answerText.trim()}
              onClick={() => void answer(answerText.trim())}
            >
              回答
            </button>
          </div>
          <div className="approval-actions">
            <button className="danger" disabled={busy} onClick={() => void decline()}>
              拒绝回答
            </button>
          </div>
        </div>
      </div>
    );
  }

  const target = ruleTarget(approval);

  /** 把当前「记住」选项换算为请求参数 */
  const rememberArgs = (): { rememberRule: boolean; rememberPattern?: string } => {
    if (rememberMode === "tool") return { rememberRule: true };
    if (rememberMode === "target" && target) return { rememberRule: false, rememberPattern: target };
    if (rememberMode === "glob" && customGlob.trim()) {
      return { rememberRule: false, rememberPattern: customGlob.trim() };
    }
    return { rememberRule: false };
  };

  const act = async (decision: "approve" | "deny") => {
    setBusy(true);
    try {
      const { rememberRule, rememberPattern } = rememberArgs();
      await resolveApproval(slot, approval.approvalId, decision, rememberRule, rememberPattern);
      setRememberMode("none");
      setCustomGlob("");
    } finally {
      setBusy(false);
    }
  };

  const actAll = async (decision: "approve" | "deny") => {
    setBusy(true);
    try {
      const { rememberRule, rememberPattern } = rememberArgs();
      for (const a of approvals) {
        await resolveApproval(slot, a.approvalId, decision, rememberRule, rememberPattern);
      }
      setRememberMode("none");
      setCustomGlob("");
    } finally {
      setBusy(false);
    }
  };

  const preview = contentPreview(approval);
  const batch = approvals.length > 1;

  return (
    <div className="approval-overlay in-pane">
      <div className="approval-dialog" style={{ width: batch ? 640 : undefined }}>
        <h3>
          工具调用审批：{approval.tool}
          {batch && <span className="model-badge">{approvals.length} 个待审批</span>}
        </h3>
        <div className="risk">⚠ {approval.riskSummary}</div>

        {/* 批量队列：点击切换当前查看的审批 */}
        {batch && (
          <div className="approval-queue">
            {approvals.map((a, i) => (
              <div key={a.approvalId} className={`approval-queue-item ${i === 0 ? "current" : ""}`}>
                <span className="tool-name">{a.tool}</span>
                <span className="approval-queue-target">{fileTarget(a) ?? ""}</span>
              </div>
            ))}
          </div>
        )}

        <pre>{JSON.stringify(approval.args, null, 2)}</pre>

        {preview !== null && (
          <>
            <div className="msg-label" style={{ marginBottom: 4 }}>
              {approval.tool === "write" ? "将写入的内容" : "替换后的内容"}
            </div>
            <pre style={{ maxHeight: 200, overflowY: "auto" }}>{preview}</pre>
          </>
        )}

        {/* M3：「记住」粒度选择 */}
        <div className="approval-remember">
          <label>
            <input
              type="radio"
              name="remember"
              checked={rememberMode === "none"}
              onChange={() => setRememberMode("none")}
            />
            仅本次
          </label>
          <label>
            <input
              type="radio"
              name="remember"
              checked={rememberMode === "tool"}
              onChange={() => setRememberMode("tool")}
            />
            本会话内放行 {approval.tool}
          </label>
          <label title={target ?? "此调用无路径/命令目标"}>
            <input
              type="radio"
              name="remember"
              disabled={!target}
              checked={rememberMode === "target"}
              onChange={() => setRememberMode("target")}
            />
            仅此{typeof approval.args.command === "string" ? "命令" : "路径"}
            {target && <code className="remember-pattern">{target}</code>}
          </label>
          <label>
            <input
              type="radio"
              name="remember"
              checked={rememberMode === "glob"}
              onChange={() => setRememberMode("glob")}
            />
            自定义 glob
          </label>
          {rememberMode === "glob" && (
            <input
              className="remember-glob-input"
              type="text"
              placeholder="如 tests/** 或 git status*"
              value={customGlob}
              onChange={(e) => setCustomGlob(e.target.value)}
            />
          )}
        </div>

        <div className="approval-actions">
          <button className="danger" disabled={busy} onClick={() => void act("deny")}>
            拒绝
          </button>
          <button className="primary" disabled={busy} onClick={() => void act("approve")}>
            批准
          </button>
          {batch && (
            <>
              <button className="danger" disabled={busy} onClick={() => void actAll("deny")}>
                全部拒绝
              </button>
              <button className="primary" disabled={busy} onClick={() => void actAll("approve")}>
                全部批准（{approvals.length}）
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
