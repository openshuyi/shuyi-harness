import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SessionList } from "./components/SessionList.js";
import { Trajectory } from "./components/Trajectory.js";
import { Composer } from "./components/Composer.js";
import { ApprovalDialog } from "./components/ApprovalDialog.js";
import { useSessionStore } from "./core/store.js";

export default function App() {
  const queryClient = useQueryClient();
  const { trajectory } = useSessionStore();

  // 轮次结束时让会话列表快照失效（刷新「最后活跃」状态）
  useEffect(() => {
    if (trajectory.status === "idle") {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    }
  }, [trajectory.status, queryClient]);

  return (
    <div className="app">
      <SessionList />
      <div className="main">
        <Trajectory />
        <Composer />
      </div>
      <ApprovalDialog />
    </div>
  );
}
