/**
 * 审批弹窗：支持批量审阅。
 * - 多个待审批调用排成队列，可逐个批准/拒绝，也可「全部批准/全部拒绝」
 * - 文件改动类工具（write/edit）展示新内容预览
 * - 支持 [本会话放行此工具]
 */
import { useState } from "react";
import { useSessionStore } from "../core/store.js";
import type { PendingApproval } from "../core/reducer.js";

/** 从工具入参提取「目标文件」描述（用于批量队列的紧凑展示） */
function fileTarget(a: PendingApproval): string | null {
  const path = (a.args.path ?? a.args.file_path ?? a.args.filePath) as string | undefined;
  return path ?? null;
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

export function ApprovalDialog() {
  const { trajectory, resolveApproval } = useSessionStore();
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const approvals = trajectory.pendingApprovals;
  const approval = approvals[0];

  if (!approval) return null;

  const act = async (decision: "approve" | "deny") => {
    setBusy(true);
    try {
      await resolveApproval(approval.approvalId, decision, remember);
      setRemember(false);
    } finally {
      setBusy(false);
    }
  };

  const actAll = async (decision: "approve" | "deny") => {
    setBusy(true);
    try {
      for (const a of approvals) {
        await resolveApproval(a.approvalId, decision, remember);
      }
      setRemember(false);
    } finally {
      setBusy(false);
    }
  };

  const preview = contentPreview(approval);
  const batch = approvals.length > 1;

  return (
    <div className="approval-overlay">
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

        <div className="approval-actions">
          <label>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            本会话内放行 {approval.tool}
          </label>
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
