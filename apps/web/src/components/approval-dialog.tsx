/**
 * 审批弹窗（墨仪 §09）：支持批量审阅。
 * - 浮层卡：r-lg + shadow-pop + 遮罩；命令区 inset mono 可滚动不截断（fail-closed 可视化承诺）
 * - 多个待审批调用排成队列，可逐个批准/拒绝，也可「全部批准/全部拒绝」
 * - 文件改动类工具（write/edit）展示新内容预览
 * - M3：「记住」支持四种粒度——不记住 / 放行此工具 / 仅此路径或命令 / 自定义 glob 模式
 */
import { Badge } from "@shuyi-harness/ui/components/ui/badge";
import { Button } from "@shuyi-harness/ui/components/ui/button";
import { Input } from "@shuyi-harness/ui/components/ui/input";
import { StatusDot } from "@shuyi-harness/ui/components/ui/status-dot";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import type { PendingApproval } from "../core/reducer.js";
import { type PaneSlot, useSessionStore } from "../core/store.js";

/** 从工具入参提取「目标文件」描述（用于批量队列的紧凑展示） */
function fileTarget(a: PendingApproval): string | null {
	const path = (a.args.path ?? a.args.file_path ?? a.args.filePath) as
		| string
		| undefined;
	return path ?? null;
}

/** M3：细粒度规则的目标——bash 取完整命令行，文件类工具取路径 */
function ruleTarget(a: PendingApproval): string | null {
	if (typeof a.args.command === "string" && a.args.command)
		return a.args.command;
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

/** 浮层遮罩内的审批卡（§09 .appr） */
function ApprovalShell({
	children,
	wide,
}: {
	children: React.ReactNode;
	wide?: boolean;
}) {
	return (
		<div className="absolute inset-0 z-40 grid animate-in fade-in-200 place-items-center overflow-y-auto bg-overlay p-4 backdrop-blur-[3px]">
			<div
				className={`surface-lift w-full overflow-hidden rounded-lg border border-line-strong bg-popover shadow-(--shadow-pop) ${wide ? "max-w-[640px]" : "max-w-[560px]"}`}
			>
				{children}
			</div>
		</div>
	);
}

export function ApprovalDialog({ slot = "primary" }: { slot?: PaneSlot }) {
	const trajectory = useSessionStore((s) =>
		slot === "secondary" ? s.splitTrajectory : s.trajectory
	);
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
				await resolveApproval(
					slot,
					approval.approvalId,
					"approve",
					false,
					undefined,
					text
				);
				setAnswerText("");
			} catch (err) {
				alert(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		};
		const decline = async () => {
			setBusy(true);
			try {
				await resolveApproval(
					slot,
					approval.approvalId,
					"deny",
					false,
					undefined
				);
			} catch (err) {
				alert(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		};
		return (
			<ApprovalShell>
				<div className="flex items-center gap-3 px-5 pt-4.5">
					<h3 className="flex-1 text-base font-semibold">模型向你提问</h3>
					<Badge variant="info">question</Badge>
				</div>
				<div className="px-5 py-4 text-sm leading-relaxed">{q}</div>
				{options.length > 0 && (
					<div className="flex flex-col gap-1.5 px-5 pb-3">
						{options.map((opt) => (
							<Button
								className="justify-start"
								disabled={busy}
								key={opt}
								onClick={() => void answer(opt)}
								variant="secondary"
							>
								{opt}
							</Button>
						))}
					</div>
				)}
				<div className="flex gap-2 px-5 pb-3">
					<Input
						disabled={busy}
						onChange={(e) => setAnswerText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && answerText.trim())
								void answer(answerText.trim());
						}}
						placeholder="自由作答…"
						value={answerText}
					/>
					<Button
						disabled={busy || !answerText.trim()}
						onClick={() => void answer(answerText.trim())}
					>
						回答
					</Button>
				</div>
				<div className="flex justify-end border-t bg-panel px-5 py-3">
					<Button
						disabled={busy}
						onClick={() => void decline()}
						variant="destructive"
					>
						拒绝回答
					</Button>
				</div>
			</ApprovalShell>
		);
	}

	const target = ruleTarget(approval);

	/** 把当前「记住」选项换算为请求参数 */
	const rememberArgs = (): {
		rememberRule: boolean;
		rememberPattern?: string;
	} => {
		if (rememberMode === "tool") return { rememberRule: true };
		if (rememberMode === "target" && target)
			return { rememberPattern: target, rememberRule: false };
		if (rememberMode === "glob" && customGlob.trim()) {
			return { rememberPattern: customGlob.trim(), rememberRule: false };
		}
		return { rememberRule: false };
	};

	const act = async (decision: "approve" | "deny") => {
		setBusy(true);
		try {
			const { rememberRule, rememberPattern } = rememberArgs();
			await resolveApproval(
				slot,
				approval.approvalId,
				decision,
				rememberRule,
				rememberPattern
			);
			setRememberMode("none");
			setCustomGlob("");
		} catch (err) {
			alert(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const actAll = async (decision: "approve" | "deny") => {
		setBusy(true);
		try {
			const { rememberRule, rememberPattern } = rememberArgs();
			for (const a of approvals) {
				await resolveApproval(
					slot,
					a.approvalId,
					decision,
					rememberRule,
					rememberPattern
				);
			}
			setRememberMode("none");
			setCustomGlob("");
		} catch (err) {
			alert(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const preview = contentPreview(approval);
	const batch = approvals.length > 1;

	const REMEMBER_OPTIONS: {
		disabled?: boolean;
		id: RememberMode;
		label: React.ReactNode;
		title?: string;
	}[] = [
		{ id: "none", label: "仅本次" },
		{ id: "tool", label: <>本会话内放行 {approval.tool}</> },
		{
			disabled: !target,
			id: "target",
			label: (
				<>
					仅此{typeof approval.args.command === "string" ? "命令" : "路径"}
					{target && (
						<code className="ml-1 rounded-xs bg-inset px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
							{target}
						</code>
					)}
				</>
			),
			title: target ?? "此调用无路径/命令目标",
		},
		{ id: "glob", label: "自定义 glob" },
	];

	return (
		<ApprovalShell wide={batch}>
			{/* 头部：指示灯 + 工具名 + awaiting 读数 */}
			<div className="flex items-center gap-3 px-5 pt-4.5">
				<StatusDot pulse tone="warning" />
				<h3 className="flex-1 text-base font-semibold">
					审批请求 · {approval.tool}
				</h3>
				<span className="label-mono text-warning">awaiting approval</span>
				{batch && <Badge variant="warning">{approvals.length} 个待审批</Badge>}
			</div>

			<div className="mx-5 mt-3 flex items-start gap-2 rounded-sm border-l-2 border-l-warning bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
				<TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
				<span>{approval.riskSummary}</span>
			</div>

			{/* 批量队列：点击切换当前查看的审批 */}
			{batch && (
				<div className="mx-5 mt-3 overflow-hidden rounded-sm border">
					{approvals.map((a, i) => (
						<div
							className={`flex items-center gap-2.5 px-3 py-1.5 font-mono text-[11.5px] ${
								i === 0
									? "bg-accent text-foreground"
									: "bg-card text-muted-foreground"
							}`}
							key={a.approvalId}
						>
							<span className="font-semibold text-primary">{a.tool}</span>
							<span className="truncate">{fileTarget(a) ?? ""}</span>
						</div>
					))}
				</div>
			)}

			{/* 命令区：inset mono 可滚动不截断 */}
			<pre className="mx-5 mt-3.5 max-h-[180px] overflow-auto rounded-sm border bg-inset px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] text-muted-foreground">
				{JSON.stringify(approval.args, null, 2)}
			</pre>

			{preview !== null && (
				<>
					<div className="label-mono mx-5 mt-3.5 mb-1.5 text-faint">
						{approval.tool === "write" ? "将写入的内容" : "替换后的内容"}
					</div>
					<pre className="mx-5 max-h-[200px] overflow-auto rounded-sm border bg-inset px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] text-muted-foreground">
						{preview}
					</pre>
				</>
			)}

			{/* M3：「记住」粒度选择（§19 radio 行） */}
			<div className="mx-5 mt-4 flex flex-col gap-2">
				<span className="label-mono text-faint">记住规则</span>
				{REMEMBER_OPTIONS.map((opt) => (
					<label
						className={`flex items-center gap-2.5 text-[13px] ${opt.disabled ? "opacity-45" : "cursor-pointer"}`}
						key={opt.id}
						title={opt.title}
					>
						<input
							checked={rememberMode === opt.id}
							className="size-3.5 accent-[var(--primary)]"
							disabled={opt.disabled}
							name="remember"
							onChange={() => setRememberMode(opt.id)}
							type="radio"
						/>
						{opt.label}
					</label>
				))}
				{rememberMode === "glob" && (
					<Input
						className="mt-1 h-8 font-mono text-xs"
						onChange={(e) => setCustomGlob(e.target.value)}
						placeholder="如 tests/** 或 git status*"
						value={customGlob}
					/>
				)}
			</div>

			{/* 操作区：朱砂「批准」是印章仪式；拒绝不盖章——留白即否 */}
			<div className="mt-4 flex flex-wrap items-center gap-2 border-t bg-panel px-5 py-3.5">
				<Button
					className="min-w-20"
					disabled={busy}
					onClick={() => void act("approve")}
					variant="seal"
				>
					批准
				</Button>
				<Button
					className="min-w-20"
					disabled={busy}
					onClick={() => void act("deny")}
					variant="destructive"
				>
					拒绝
				</Button>
				{batch && (
					<>
						<Button
							disabled={busy}
							onClick={() => void actAll("approve")}
							variant="outline"
						>
							全部批准（{approvals.length}）
						</Button>
						<Button
							disabled={busy}
							onClick={() => void actAll("deny")}
							variant="destructive-soft"
						>
							全部拒绝
						</Button>
					</>
				)}
			</div>
		</ApprovalShell>
	);
}
