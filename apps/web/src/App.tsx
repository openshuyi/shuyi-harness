import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SessionList } from "./components/SessionList.js";
import { Trajectory } from "./components/Trajectory.js";
import { Composer } from "./components/Composer.js";
import { ApprovalDialog } from "./components/ApprovalDialog.js";
import { TodoPanel } from "./components/TodoPanel.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { useSessionStore, type PaneSlot } from "./core/store.js";

export default function App() {
  const queryClient = useQueryClient();
  const { trajectory, current, split, closeSplit } = useSessionStore();

  // 轮次结束时让会话列表快照失效（刷新「最后活跃」状态）
  useEffect(() => {
    if (trajectory.status === "idle") {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    }
  }, [trajectory.status, queryClient]);

  // 自动标题（session.titled）落地后刷新会话列表，侧栏立即显示新标题
  const titledCount = trajectory.items.filter(
    (i) => i.kind === "marker" && i.text.startsWith("会话已命名为"),
  ).length;
  useEffect(() => {
    if (titledCount > 0) {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    }
  }, [titledCount, queryClient]);

  return (
    <div className="app">
      <ErrorBoundary name="会话列表">
        <SessionList />
      </ErrorBoundary>
      {/* M5：分栏模式——主栏 + 可选右栏，各自独立 Trajectory/Composer/审批弹窗 */}
      <div className={`main ${split ? "split" : ""}`}>
        <Pane slot="primary" title={current?.title} />
        {split && <Pane slot="secondary" title={split.title} onClose={closeSplit} />}
      </div>
    </div>
  );
}

/** M5：单个会话栏（主/右栏复用） */
function Pane({
  slot,
  title,
  onClose,
}: {
  slot: PaneSlot;
  title?: string;
  onClose?: () => void;
}) {
  return (
    <div className="pane">
      {onClose ? (
        <div className="pane-header">
          <span className="pane-title">{title ?? "分栏会话"}</span>
          <button className="pane-close" onClick={onClose} title="收起分栏">
            ×
          </button>
        </div>
      ) : null}
      <ErrorBoundary name="任务面板">
        <TodoPanel slot={slot} />
      </ErrorBoundary>
      <ErrorBoundary name="对话区">
        <Trajectory slot={slot} />
      </ErrorBoundary>
      <ErrorBoundary name="输入区">
        <Composer slot={slot} />
      </ErrorBoundary>
      <ApprovalDialog slot={slot} />
    </div>
  );
}
