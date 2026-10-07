import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ApprovalDialog } from "./components/approval-dialog.js";
import { Composer } from "./components/composer.js";
import { ErrorBoundary } from "./components/error-boundary.js";
import { SessionList } from "./components/session-list.js";
import { Trajectory } from "./components/trajectory.js";
import { useSessionStore } from "./core/store.js";

export default function App() {
	const queryClient = useQueryClient();
	const { trajectory } = useSessionStore();

	// 轮次结束时让会话列表快照失效（刷新「最后活跃」状态）
	// 后台失效会话列表缓存（fire-and-forget）
	useEffect(() => {
		if (trajectory.status === "idle") {
			void queryClient.invalidateQueries({ queryKey: ["sessions"] });
		}
	}, [trajectory.status, queryClient]);

	return (
		<div className="app">
			<ErrorBoundary name="会话列表">
				<SessionList />
			</ErrorBoundary>
			<div className="main">
				<ErrorBoundary name="对话区">
					<Trajectory />
				</ErrorBoundary>
				<ErrorBoundary name="输入区">
					<Composer />
				</ErrorBoundary>
			</div>
			<ApprovalDialog />
		</div>
	);
}
