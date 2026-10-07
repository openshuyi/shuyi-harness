/**
 * Composer（墨仪 §10 输入区）：
 * - 聚焦时 line-3 + accent-ring；模式分段控件 + mono 模型选择 + @ 引用与排队 chips
 * - / 斜杠命令补全 + @ 文件引用补全（同一套 palette 交互，浮于输入区上方）
 * - busy 时可继续发送（服务端排队），排队 chips 可撤回；「打断并发送」= abort + 排队
 * - Esc：补全打开→关闭；busy→中断；否则清空输入；空输入 ↑ 召回历史
 * - 消息编辑重发：requestEdit 载入文本，提交前先 conversation-rewind 再发送
 * - 常驻用量条（tokens / 成本 / 上下文估算占比，ctx>70% 转暖色警告）
 */

import type { AgentInfo, ModelInfo } from "@shuyi-harness/types";
import { Button } from "@shuyi-harness/ui/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@shuyi-harness/ui/components/ui/select";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@shuyi-harness/ui/components/ui/toggle-group";
import { useQuery } from "@tanstack/react-query";
import {
	ArrowUpIcon,
	BotIcon,
	CogIcon,
	PaperclipIcon,
	ShieldCheckIcon,
	SquareIcon,
	ZapIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fetchJson, fetchJsonArray } from "../core/api.js";
import { type PaneSlot, useSessionStore } from "../core/store.js";
import { AgentManager } from "./agent-manager.js";
import { ModelManager } from "./model-manager.js";
import { PermissionManager } from "./permission-manager.js";

/** P0-4a：斜杠命令定义（/api/sessions/:id/commands） */
interface CommandInfo {
	description: string;
	name: string;
	source: "global" | "project";
}

export function Composer({ slot = "primary" }: { slot?: PaneSlot }) {
	const current = useSessionStore((s) =>
		slot === "secondary" ? s.split : s.current
	);
	const trajectory = useSessionStore((s) =>
		slot === "secondary" ? s.splitTrajectory : s.trajectory
	);
	const editRequest = useSessionStore((s) => s.editRequest);
	const {
		sendMessage,
		abort,
		setMode,
		setModel,
		setAgent,
		cancelQueued,
		rewind,
		clearEditRequest,
		inputHistory,
	} = useSessionStore();
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [managerOpen, setManagerOpen] = useState(false);
	const [agentManagerOpen, setAgentManagerOpen] = useState(false);
	const [permManagerOpen, setPermManagerOpen] = useState(false);
	const [files, setFiles] = useState<File[]>([]);
	const [slashIdx, setSlashIdx] = useState(0);
	const [atIdx, setAtIdx] = useState(0);
	const [atQuery, setAtQuery] = useState<string | null>(null);
	const [histIdx, setHistIdx] = useState(-1);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// F6：编辑重发——载入文本并聚焦（提交时先截断再发）
	const editingSeq = editRequest?.slot === slot ? editRequest.seq : null;
	useEffect(() => {
		if (editRequest?.slot === slot) {
			setText(editRequest.text);
			textareaRef.current?.focus();
		}
	}, [editRequest, slot]);

	const { data: models = [] } = useQuery<ModelInfo[]>({
		queryFn: async () => {
			try {
				return await fetchJsonArray<ModelInfo>("/api/models");
			} catch {
				return [];
			}
		},
		queryKey: ["models"],
	});

	// M2：代理选择器（按当前会话 cwd 加载，含项目级定义）
	const { data: agents = [] } = useQuery<AgentInfo[]>({
		enabled: !!current,
		queryFn: async () => {
			try {
				return await fetchJsonArray<AgentInfo>(
					`/api/agents${current ? `?cwd=${encodeURIComponent(current.cwd)}` : ""}`
				);
			} catch {
				return [];
			}
		},
		queryKey: ["agents", current?.cwd],
	});

	// P0-4a：斜杠命令清单（输入 "/" 开头时自动补全）
	const { data: commands = [] } = useQuery<CommandInfo[]>({
		enabled: !!current,
		queryFn: async () => {
			try {
				const data = await fetchJson<{
					commands: CommandInfo[] | Record<string, never>;
				}>(`/api/sessions/${current!.session_id}/commands`);
				return Array.isArray(data.commands) ? data.commands : [];
			} catch {
				return [];
			}
		},
		queryKey: ["commands", current?.session_id],
	});

	// F3：@ 文件补全（输入尾部 @xxx 时查询；防抖由 React Query 的 queryKey 天然合并）
	const { data: atFiles = [] } = useQuery<string[]>({
		enabled: !!current && atQuery !== null,
		queryFn: async () => {
			try {
				const data = await fetchJson<{
					files: string[] | Record<string, never>;
				}>(
					`/api/sessions/${current!.session_id}/files?q=${encodeURIComponent(atQuery ?? "")}`
				);
				return Array.isArray(data.files) ? data.files : [];
			} catch {
				return [];
			}
		},
		queryKey: ["files", current?.session_id, atQuery],
		staleTime: 5_000,
	});

	if (!current) return null;
	const busy =
		trajectory.status === "running" ||
		trajectory.status === "awaiting_approval";
	// M2：当前会话代理（缺省内置 build）
	const currentAgent = current.agent ?? "build";
	const currentAgentDesc = agents.find(
		(a) => a.name === currentAgent
	)?.description;

	// / 补全候选
	const slashPrefix = text.match(/^\/([\w-]*)$/)?.[1];
	const slashCandidates =
		slashPrefix !== undefined
			? commands.filter((c) => c.name.startsWith(slashPrefix))
			: [];
	const slashOpen = slashCandidates.length > 0;
	const pickCommand = (name: string) => {
		setText(`/${name} `);
		setSlashIdx(0);
	};

	// @ 补全候选（尾部 @xxx）
	const atMatch = text.match(/(?:^|\s)@([\w./-]*)$/);
	const atOpen = atQuery !== null && atMatch !== null && atFiles.length > 0;
	const pickFile = (rel: string) => {
		setText(
			text.replace(/(?:^|\s)@([\w./-]*)$/, (m) =>
				m.startsWith(" ") ? ` @${rel} ` : `@${rel} `
			)
		);
		setAtQuery(null);
		setAtIdx(0);
		textareaRef.current?.focus();
	};

	const history = inputHistory(slot);

	const submit = async () => {
		const t = text.trim();
		if (!t) return;
		setSending(true);
		try {
			// F6：编辑重发——先把会话截断到原消息之前，再发送修订文本
			if (editingSeq !== null) {
				await rewind(slot, editingSeq - 1, "conversation");
				clearEditRequest();
			}
			await sendMessage(slot, t, files.length ? files : undefined);
			setText("");
			setFiles([]);
			setHistIdx(-1);
		} catch (err) {
			alert(err instanceof Error ? err.message : String(err));
		} finally {
			setSending(false);
		}
	};

	/** F4：打断并发送——中断当前轮次，消息进入队列，turn 收尾后自动执行 */
	const interruptAndSend = async () => {
		const t = text.trim();
		if (!t) return;
		setSending(true);
		try {
			await sendMessage(slot, t); // busy → 服务端入队
			setText("");
			setHistIdx(-1);
			await abort(slot);
		} catch (err) {
			alert(err instanceof Error ? err.message : String(err));
		} finally {
			setSending(false);
		}
	};

	const modelInfo = models.find((m) => m.id === current.model);
	const ctxWindow = (modelInfo as { contextWindow?: number } | undefined)
		?.contextWindow;
	const ctxPct =
		ctxWindow && trajectory.usage.prompt > 0
			? Math.min(99, Math.round((trajectory.usage.prompt / ctxWindow) * 100))
			: null;
	const usageHot = ctxPct !== null && ctxPct > 70;

	return (
		<div className="relative flex-none border-t bg-background px-4 pt-0 pb-3 md:px-6">
			<div className="relative">
				{/* / 与 @ 补全面板 —— 浮于输入区上方 */}
				{(slashOpen || atOpen) && (
					<div className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-md border bg-popover p-1.5 shadow-(--shadow-pop)">
						{slashOpen &&
							slashCandidates.map((c, i) => (
								<button
									className={`flex w-full items-center gap-3 rounded-sm px-2.5 py-1.5 text-left ${
										i === slashIdx
											? "bg-accent text-foreground"
											: "text-muted-foreground"
									}`}
									key={c.name}
									onClick={() => pickCommand(c.name)}
									onMouseEnter={() => setSlashIdx(i)}
									type="button"
								>
									<span className="font-mono text-xs font-semibold text-primary">
										/{c.name}
									</span>
									<span className="flex-1 truncate text-xs">
										{c.description || "自定义命令"}
									</span>
									<span className="label-mono text-[10px] text-faint">
										{c.source === "project" ? "项目" : "全局"}
									</span>
								</button>
							))}
						{atOpen &&
							atFiles.map((f, i) => (
								<button
									className={`flex w-full items-center gap-3 rounded-sm px-2.5 py-1.5 text-left ${
										i === atIdx
											? "bg-accent text-foreground"
											: "text-muted-foreground"
									}`}
									key={f}
									onClick={() => pickFile(f)}
									onMouseEnter={() => setAtIdx(i)}
									type="button"
								>
									<span className="truncate font-mono text-xs text-info">
										@{f}
									</span>
									<span className="flex-1" />
									<span className="label-mono text-[10px] text-faint">
										引用文件
									</span>
								</button>
							))}
					</div>
				)}

				{/* 输入区外壳（§10）：聚焦 line-3 + accent-ring */}
				<div className="surface-lift rounded-md border bg-card transition-[border-color,box-shadow] focus-within:border-line-strong focus-within:ring-[3px] focus-within:ring-ring">
					<textarea
						className="w-full resize-none bg-transparent px-3.5 pt-3 pb-1.5 text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-faint"
						onChange={(e) => {
							setText(e.target.value);
							setHistIdx(-1);
							// F3：@ 触发——尾部出现 @xxx 时启动补全查询
							const m = e.target.value.match(/(?:^|\s)@([\w./-]*)$/);
							setAtQuery(m ? m[1] : null);
						}}
						onKeyDown={(e) => {
							// 补全面板（/ 与 @ 共用键盘交互）
							const palette = slashOpen
								? {
										idx: slashIdx,
										len: slashCandidates.length,
										pick: () =>
											pickCommand(
												slashCandidates[
													Math.min(slashIdx, slashCandidates.length - 1)
												].name
											),
										setIdx: setSlashIdx,
									}
								: atOpen
									? {
											idx: atIdx,
											len: atFiles.length,
											pick: () =>
												pickFile(atFiles[Math.min(atIdx, atFiles.length - 1)]),
											setIdx: setAtIdx,
										}
									: null;
							if (palette) {
								if (e.key === "ArrowDown") {
									e.preventDefault();
									palette.setIdx((palette.idx + 1) % palette.len);
									return;
								}
								if (e.key === "ArrowUp") {
									e.preventDefault();
									palette.setIdx((palette.idx - 1 + palette.len) % palette.len);
									return;
								}
								if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
									e.preventDefault();
									palette.pick();
									return;
								}
								if (e.key === "Escape") {
									e.preventDefault();
									if (slashOpen) setText(text.replace(/^\/[\w-]*$/, ""));
									setAtQuery(null);
									return;
								}
							}
							// F6：Esc——busy 时中断，否则清空输入
							if (e.key === "Escape") {
								e.preventDefault();
								if (busy) void abort(slot);
								else if (text) setText("");
								return;
							}
							// F6：空输入（或召回浏览中）按 ↑ 逐条召回历史
							if (
								e.key === "ArrowUp" &&
								(text === "" || histIdx >= 0) &&
								history.length > 0
							) {
								e.preventDefault();
								const next = Math.min(histIdx + 1, history.length - 1);
								setHistIdx(next);
								setText(history[next]);
								return;
							}
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void submit();
							}
						}}
						placeholder={
							busy
								? "运行中——可直接输入排队（Enter 发送），或点「打断并发送」"
								: "描述任务… @ 引用文件，/ 斜杠命令，⌘K 命令面板"
						}
						ref={textareaRef}
						rows={2}
						value={text}
					/>

					{/* chips：排队 / 编辑 / 附件（§10 chip-q：inset 底 mono 胶囊） */}
					{(trajectory.queued.length > 0 ||
						editingSeq !== null ||
						files.length > 0) && (
						<div className="flex flex-wrap gap-1.5 px-3.5 pb-1.5">
							{editingSeq !== null && (
								<span className="inline-flex items-center gap-1.5 rounded-full border bg-inset px-2.5 py-0.5 font-mono text-[11px] text-info">
									✎ 正在编辑历史消息
									<button
										className="px-0.5 text-faint hover:text-destructive"
										onClick={() => {
											clearEditRequest();
											setText("");
										}}
										title="取消编辑（发送后将移除其后的会话内容）"
										type="button"
									>
										×
									</button>
								</span>
							)}
							{trajectory.queued.map((q) => (
								<span
									className="inline-flex items-center gap-1.5 rounded-full border bg-inset px-2.5 py-0.5 font-mono text-[11px] text-muted-foreground"
									key={q.queueId}
									title={q.text}
								>
									⏳ {q.text.slice(0, 40)}
									{q.text.length > 40 ? "…" : ""}
									<button
										className="px-0.5 text-faint hover:text-destructive"
										onClick={() => void cancelQueued(slot, q.queueId)}
										title="撤队"
										type="button"
									>
										×
									</button>
								</span>
							))}
							{files.map((f, i) => (
								<span
									className="inline-flex items-center gap-1.5 rounded-full border bg-inset px-2.5 py-0.5 font-mono text-[11px] text-muted-foreground"
									key={i}
								>
									📎 {f.name}
									<button
										className="px-0.5 text-faint hover:text-destructive"
										onClick={() => setFiles(files.filter((_, j) => j !== i))}
										title="移除附件"
										type="button"
									>
										×
									</button>
								</span>
							))}
						</div>
					)}

					{/* comp-f：模式分段 / 模型 / 代理 / 管理入口 / 发送 */}
					<div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
						{/* §10 seg：模式分段控件 */}
						<ToggleGroup
							onValueChange={(groupValue) => {
								const next = groupValue.find((v) => v !== current.mode);
								if (next) void setMode(slot, next as "plan" | "build");
							}}
							value={[current.mode]}
						>
							<ToggleGroupItem value="build">Build</ToggleGroupItem>
							<ToggleGroupItem value="plan">Plan</ToggleGroupItem>
						</ToggleGroup>

						{/* §10 model-pick：mono 模型选择 */}
						<Select
							onValueChange={(v) => {
								if (v) void setModel(slot, v);
							}}
							value={current.model}
						>
							<SelectTrigger
								className="h-[26px] rounded-xs border-transparent bg-transparent px-2 font-mono text-[11.5px] hover:border-border hover:bg-inset"
								size="sm"
								title="模型"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent alignItemWithTrigger={false} className="min-w-44">
								{models.map((m) => (
									<SelectItem key={m.id} value={m.id}>
										{m.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>

						{/* M2：代理选择器 */}
						<Select
							onValueChange={(v) => {
								if (!v) return;
								void setAgent(slot, v).catch((err) =>
									alert(err instanceof Error ? err.message : String(err))
								);
							}}
							value={currentAgent}
						>
							<SelectTrigger
								className="h-[26px] rounded-xs border-transparent bg-transparent px-2 font-mono text-[11.5px] hover:border-border hover:bg-inset"
								size="sm"
								title={currentAgentDesc ?? "选择会话代理"}
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent alignItemWithTrigger={false} className="min-w-40">
								{[...new Set(["build", ...agents.map((a) => a.name)])].map(
									(name) => (
										<SelectItem key={name} value={name}>
											{name}
										</SelectItem>
									)
								)}
							</SelectContent>
						</Select>

						{/* 管理入口 */}
						<div className="flex items-center gap-0.5">
							<Button
								onClick={() => setAgentManagerOpen(true)}
								size="icon-sm"
								title="代理管理"
								variant="ghost"
							>
								<BotIcon />
							</Button>
							<Button
								onClick={() => setManagerOpen(true)}
								size="icon-sm"
								title="模型管理"
								variant="ghost"
							>
								<CogIcon />
							</Button>
							<Button
								onClick={() => setPermManagerOpen(true)}
								size="icon-sm"
								title="权限规则管理"
								variant="ghost"
							>
								<ShieldCheckIcon />
							</Button>
						</div>

						<span className="flex-1" />

						{trajectory.queued.length > 0 && (
							<span className="label-mono tnum text-[10px] text-faint">
								queued {trajectory.queued.length}
							</span>
						)}

						{/* 附件 */}
						<label title="添加附件（文件将保存到工作区供 agent 读取）">
							<PaperclipIcon className="mx-1 size-4 cursor-pointer text-faint transition-colors hover:text-foreground" />
							<input
								className="hidden"
								multiple
								onChange={(e) => {
									if (e.target.files)
										setFiles([...files, ...Array.from(e.target.files)]);
									e.target.value = "";
								}}
								type="file"
							/>
						</label>

						{busy ? (
							<>
								<Button
									disabled={sending || !text.trim()}
									onClick={() => void interruptAndSend()}
									size="sm"
									title="中断当前轮次并立即发送（Esc 仅中断）"
									variant="secondary"
								>
									⇧ 打断发送
								</Button>
								<Button
									aria-label="中断"
									className="border-destructive! bg-transparent! text-destructive! hover:bg-destructive-soft!"
									onClick={() => void abort(slot)}
									size="icon"
									title="中断（Esc）"
									variant="outline"
								>
									<SquareIcon />
								</Button>
							</>
						) : (
							<Button
								aria-label="发送"
								className="size-[34px] rounded-sm"
								disabled={sending || !text.trim()}
								onClick={() => void submit()}
								title="发送（Enter）"
								variant="default"
							>
								<ArrowUpIcon />
							</Button>
						)}
					</div>

					{/* §10 usage：常驻用量读数（mono · tabular） */}
					<div
						className={`flex items-center gap-3.5 border-t bg-panel px-3.5 py-[7px] font-mono text-[11px] ${
							usageHot ? "text-warning" : "text-faint"
						}`}
					>
						<span className="tnum">
							in {trajectory.usage.prompt.toLocaleString()}
						</span>
						<span className="tnum">
							out {trajectory.usage.completion.toLocaleString()}
						</span>
						{current.usage?.cost_usd != null && (
							<span className="tnum">${current.usage.cost_usd.toFixed(4)}</span>
						)}
						{ctxPct !== null && (
							<span
								className={`tnum ${usageHot ? "" : "text-muted-foreground"}`}
							>
								ctx {ctxPct}%{usageHot ? " · 即将压缩" : ""}
							</span>
						)}
						{ctxPct !== null && (
							<div className="h-[3px] max-w-[180px] flex-1 overflow-hidden rounded-full bg-border">
								<div
									className={`h-full rounded-full ${usageHot ? "bg-warning" : "bg-primary"}`}
									style={{ width: `${ctxPct}%` }}
								/>
							</div>
						)}
						{models.length === 0 && (
							<span className="flex items-center gap-1 text-faint">
								<ZapIcon className="size-3" />
								未配置模型
							</span>
						)}
					</div>
				</div>
			</div>

			<ModelManager onClose={() => setManagerOpen(false)} open={managerOpen} />
			<AgentManager
				cwd={current.cwd}
				onClose={() => setAgentManagerOpen(false)}
				open={agentManagerOpen}
			/>
			<PermissionManager
				cwd={current.cwd}
				onClose={() => setPermManagerOpen(false)}
				open={permManagerOpen}
			/>
		</div>
	);
}
