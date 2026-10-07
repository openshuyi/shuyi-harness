/**
 * F2（v0.4）：变更面板——会话内被快照文件的 before/after unified diff 聚合，
 * 逐文件 接受（清快照）/ 撤销（恢复内容）。turn 结束与审查操作后自动刷新。
 * 墨仪 §07：inset 底 mono diff，accept / retract 就在文件头；外壳由右栏 Tabs 提供。
 */

import type { SessionRecord } from "@shuyi-harness/types";
import { Button } from "@shuyi-harness/ui/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@shuyi-harness/ui/components/ui/empty";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@shuyi-harness/ui/components/ui/tooltip";
import { CheckIcon, ChevronRightIcon, Undo2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchJson } from "../core/api.js";
import { type PaneSlot, useSessionStore } from "../core/store.js";

interface FileChange {
	additions: number;
	deletions: number;
	diff: string;
	path: string;
}

export function ChangesPanel({
	slot = "primary",
	session,
}: {
	slot?: PaneSlot;
	session: SessionRecord;
}) {
	const trajectory = useSessionStore((s) =>
		slot === "secondary" ? s.splitTrajectory : s.trajectory
	);
	const [changes, setChanges] = useState<FileChange[]>([]);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const idle = trajectory.status === "idle";

	const refresh = async () => {
		try {
			const data = await fetchJson<{
				changes: FileChange[] | Record<string, never>;
			}>(`/api/sessions/${session.session_id}/changes`);
			setChanges(Array.isArray(data.changes) ? data.changes : []);
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
			const res = await fetch(
				`/api/sessions/${session.session_id}/changes/review`,
				{
					body: JSON.stringify({ action, path }),
					headers: { "content-type": "application/json" },
					method: "POST",
				}
			);
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
		<TooltipProvider>
			<div className="h-full overflow-y-auto">
				<div className="flex items-center justify-between px-3 py-2">
					<span className="label-mono text-faint">{changes.length} 个文件</span>
					<span className="font-mono text-[11px] tnum">
						<span className="text-success">+{totalAdd}</span>{" "}
						<span className="text-destructive">−{totalDel}</span>
					</span>
				</div>
				{error && (
					<div className="mx-3 mb-2 rounded-sm border border-destructive/35 bg-destructive-soft px-3 py-2 font-mono text-[11.5px] text-destructive">
						{error}
					</div>
				)}
				{!error && changes.length === 0 && (
					<div className="px-3 pb-3">
						<Empty className="rounded-md">
							<EmptyHeader>
								<EmptyMedia>
									<span className="grid size-[38px] rotate-[-4deg] place-items-center rounded-[5px] bg-seal font-serif text-[19px] font-bold text-seal-foreground">
										审
									</span>
								</EmptyMedia>
								<EmptyTitle>暂无待审变更</EmptyTitle>
								<EmptyDescription>
									agent 修改文件后在此逐文件审查
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					</div>
				)}
				<div className="flex flex-col gap-2 px-3 pb-3">
					{changes.map((ch) => {
						const open = expanded.has(ch.path);
						return (
							<div
								className="overflow-hidden rounded-md border border-border bg-card"
								key={ch.path}
							>
								<div className="flex items-center gap-1 px-1.5 py-1">
									<button
										className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-xs px-1 py-1 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring"
										onClick={() =>
											setExpanded((prev) => {
												const next = new Set(prev);
												if (next.has(ch.path)) next.delete(ch.path);
												else next.add(ch.path);
												return next;
											})
										}
										title={ch.path}
										type="button"
									>
										<ChevronRightIcon
											className={`size-3.5 shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`}
										/>
										<span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
											{ch.path}
										</span>
										<span className="font-mono text-[11px] tnum text-success">
											+{ch.additions}
										</span>
										<span className="font-mono text-[11px] tnum text-destructive">
											−{ch.deletions}
										</span>
									</button>
									<Tooltip>
										<TooltipTrigger
											render={
												<Button
													aria-label="接受"
													disabled={!idle}
													onClick={() => void review(ch.path, "accept")}
													size="icon-xs"
													variant="secondary"
												/>
											}
										>
											<CheckIcon className="text-success" />
										</TooltipTrigger>
										<TooltipContent>
											接受：保留当前内容，清除快照
										</TooltipContent>
									</Tooltip>
									<Tooltip>
										<TooltipTrigger
											render={
												<Button
													aria-label="撤销"
													className="text-destructive hover:bg-destructive-soft hover:text-destructive"
													disabled={!idle}
													onClick={() => {
														if (confirm(`撤销对 ${ch.path} 的修改？`))
															void review(ch.path, "revert");
													}}
													size="icon-xs"
													variant="ghost"
												/>
											}
										>
											<Undo2Icon />
										</TooltipTrigger>
										<TooltipContent>撤销：恢复到修改前内容</TooltipContent>
									</Tooltip>
								</div>
								{open && (
									<div className="border-t border-border bg-inset">
										<pre className="diff-code">
											{ch.diff.split("\n").map((line, i) => (
												<div
													className={
														line.startsWith("+") && !line.startsWith("+++")
															? "diff-line-add"
															: line.startsWith("-") && !line.startsWith("---")
																? "diff-line-del"
																: "diff-line-meta"
													}
													key={i}
												>
													{line || " "}
												</div>
											))}
										</pre>
									</div>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</TooltipProvider>
	);
}
