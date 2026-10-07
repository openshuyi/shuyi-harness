/**
 * 审批弹窗：展示工具名 + 完整入参（安全体验的核心），
 * 支持 [批准] [拒绝] [本会话放行此工具]。
 */
import { useState } from "react";
import { useSessionStore } from "../core/store.js";

export function ApprovalDialog() {
  const { trajectory, resolveApproval } = useSessionStore();
  const [remember, setRemember] = useState(false);
  const approval = trajectory.pendingApprovals[0];

  if (!approval) return null;

  const act = async (decision: "approve" | "deny") => {
    await resolveApproval(approval.approvalId, decision, remember);
    setRemember(false);
  };

  return (
    <div className="approval-overlay">
      <div className="approval-dialog">
        <h3>工具调用审批：{approval.tool}</h3>
        <div className="risk">⚠ {approval.riskSummary}</div>
        <pre>{JSON.stringify(approval.args, null, 2)}</pre>
        <div className="approval-actions">
          <label>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            本会话内放行 {approval.tool}
          </label>
          <button className="danger" onClick={() => void act("deny")}>
            拒绝
          </button>
          <button className="primary" onClick={() => void act("approve")}>
            批准
          </button>
        </div>
      </div>
    </div>
  );
}
