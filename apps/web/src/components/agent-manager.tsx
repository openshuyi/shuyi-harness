/**
 * 代理管理面板（M2）：查看全部代理定义（builtin/user/project/runtime），
 * 增删 runtime 代理。数据来自 GET /api/agents，增删走 PUT/DELETE /api/agents/:name。
 * 墨仪 §09/§19/§20：Dialog + mono 表格 + Label 置上的表单。
 */

import type { AgentInfo, UpsertAgentRequest } from "@shuyi-harness/types";
import { Badge } from "@shuyi-harness/ui/components/ui/badge";
import { Button } from "@shuyi-harness/ui/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@shuyi-harness/ui/components/ui/dialog";
import { Input } from "@shuyi-harness/ui/components/ui/input";
import { Label } from "@shuyi-harness/ui/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@shuyi-harness/ui/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@shuyi-harness/ui/components/ui/table";
import { Textarea } from "@shuyi-harness/ui/components/ui/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { fetchJsonArray } from "../core/api.js";

interface Props {
	/** 当前会话 cwd（项目级代理按 cwd 过滤展示） */
	cwd?: string;
	onClose: () => void;
	open: boolean;
}

const EMPTY_FORM: UpsertAgentRequest & { name: string; toolsText: string } = {
	description: "",
	modeDefault: undefined,
	model: "",
	name: "",
	system: "",
	toolsText: "all",
};

const SOURCE_LABEL: Record<AgentInfo["source"], string> = {
	builtin: "内置",
	project: "项目",
	runtime: "运行时",
	user: "全局",
};

function toolsLabel(t: AgentInfo["tools"]): string {
	if (t === "all") return "全部工具";
	if (t === "readonly") return "只读";
	if (t.length === 0) return "无工具";
	return t.join(", ");
}

export function AgentManager({ open, onClose, cwd }: Props) {
	const queryClient = useQueryClient();
	const [form, setForm] = useState(EMPTY_FORM);
	const [error, setError] = useState("");

	const { data: agents = [] } = useQuery<AgentInfo[]>({
		enabled: open,
		queryFn: () =>
			fetchJsonArray<AgentInfo>(
				`/api/agents${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`
			),
		queryKey: ["agents", cwd],
	});

	const invalidate = () =>
		void queryClient.invalidateQueries({ queryKey: ["agents"] });

	const upsertMutation = useMutation({
		mutationFn: async () => {
			const toolsText = form.toolsText.trim();
			const tools: UpsertAgentRequest["tools"] =
				toolsText === "all" || toolsText === "readonly"
					? toolsText
					: toolsText
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
			const payload: UpsertAgentRequest = {
				description: form.description,
				modeDefault: form.modeDefault,
				model: form.model || undefined,
				system: form.system,
				tools,
			};
			const res = await fetch(
				`/api/agents/${encodeURIComponent(form.name.trim())}`,
				{
					body: JSON.stringify(payload),
					headers: { "content-type": "application/json" },
					method: "PUT",
				}
			);
			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(err.error ?? `保存失败 ${res.status}`);
			}
		},
		onError: (err) =>
			setError(err instanceof Error ? err.message : String(err)),
		onSuccess: () => {
			invalidate();
			setForm(EMPTY_FORM);
			setError("");
		},
	});

	const removeMutation = useMutation({
		mutationFn: (name: string) =>
			fetch(`/api/agents/${encodeURIComponent(name)}`, {
				method: "DELETE",
			}).then(async (r) => {
				if (!r.ok) {
					const err = (await r.json().catch(() => ({}))) as { error?: string };
					throw new Error(err.error ?? `删除失败 ${r.status}`);
				}
			}),
		onError: (err) =>
			setError(err instanceof Error ? err.message : String(err)),
		onSuccess: invalidate,
	});

	const set = (patch: Partial<typeof EMPTY_FORM>) =>
		setForm((f) => ({ ...f, ...patch }));

	const fieldClass = "flex flex-col gap-1.5";
	const labelClass = "text-[12.5px] font-medium text-foreground";

	return (
		<Dialog onOpenChange={(o) => !o && onClose()} open={open}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[680px]">
				<DialogHeader>
					<DialogTitle>代理管理</DialogTitle>
					<DialogDescription>
						代理 = 提示词 + 模型 +
						工具面。内置/全局/项目来源只读；运行时定义保存在
						~/.agent/agents.json。
					</DialogDescription>
				</DialogHeader>

				<div className="overflow-hidden rounded-md border border-border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>名称</TableHead>
								<TableHead>描述</TableHead>
								<TableHead>工具面</TableHead>
								<TableHead>模型</TableHead>
								<TableHead>来源</TableHead>
								<TableHead className="w-0" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{agents.map((a) => (
								<TableRow key={`${a.source}-${a.name}`}>
									<TableCell className="font-mono">
										<span className="flex items-center gap-1.5">
											{a.name}
											{a.modeDefault && (
												<Badge variant="accent">{a.modeDefault}</Badge>
											)}
										</span>
									</TableCell>
									<TableCell
										className="max-w-[180px] truncate text-muted-foreground"
										title={a.system}
									>
										{a.description || "—"}
									</TableCell>
									<TableCell className="text-muted-foreground">
										{toolsLabel(a.tools)}
									</TableCell>
									<TableCell className="font-mono text-muted-foreground">
										{a.model ?? "继承"}
									</TableCell>
									<TableCell className="text-muted-foreground">
										{SOURCE_LABEL[a.source]}
									</TableCell>
									<TableCell>
										{a.source === "runtime" && (
											<Button
												className="text-destructive hover:bg-destructive-soft hover:text-destructive"
												onClick={() => removeMutation.mutate(a.name)}
												size="xs"
												variant="ghost"
											>
												删除
											</Button>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>

				<div className="label-mono text-faint">新增/覆盖运行时代理</div>
				<div className="grid grid-cols-2 gap-3">
					<div className={fieldClass}>
						<Label className={labelClass} htmlFor="am-name">
							name（不可与内置同名）
						</Label>
						<Input
							id="am-name"
							onChange={(e) => set({ name: e.target.value.trim() })}
							value={form.name}
						/>
					</div>
					<div className={fieldClass}>
						<Label className={labelClass} htmlFor="am-desc">
							描述（可选）
						</Label>
						<Input
							id="am-desc"
							onChange={(e) => set({ description: e.target.value })}
							value={form.description ?? ""}
						/>
					</div>
					<div className={fieldClass}>
						<Label className={labelClass} htmlFor="am-tools">
							工具面
						</Label>
						<Input
							id="am-tools"
							onChange={(e) => set({ toolsText: e.target.value })}
							placeholder="all / readonly / 逗号分隔白名单"
							value={form.toolsText}
						/>
					</div>
					<div className={fieldClass}>
						<Label className={labelClass} htmlFor="am-model">
							模型覆盖（可选）
						</Label>
						<Input
							id="am-model"
							onChange={(e) => set({ model: e.target.value.trim() })}
							placeholder="缺省继承会话"
							value={form.model ?? ""}
						/>
					</div>
					<div className="col-span-2 flex flex-col gap-1.5">
						<Label className={labelClass} htmlFor="am-mode">
							模式语义
						</Label>
						<Select
							onValueChange={(v) =>
								set({
									modeDefault: (v as "build" | "plan" | null) ?? undefined,
								})
							}
							value={form.modeDefault ?? null}
						>
							<SelectTrigger className="w-full" id="am-mode">
								<SelectValue placeholder="无（跟随会话）" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="build">build（可写）</SelectItem>
								<SelectItem value="plan">plan（只读）</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="col-span-2 flex flex-col gap-1.5">
						<Label className={labelClass} htmlFor="am-system">
							系统提示（prompt）正文
						</Label>
						<Textarea
							id="am-system"
							onChange={(e) => set({ system: e.target.value })}
							rows={4}
							value={form.system ?? ""}
						/>
					</div>
				</div>

				{error && (
					<div className="font-mono text-[11.5px] text-destructive">
						{error}
					</div>
				)}

				<DialogFooter>
					<Button onClick={onClose} variant="outline">
						关闭
					</Button>
					<Button
						disabled={upsertMutation.isPending || !form.name || !form.system}
						onClick={() => upsertMutation.mutate()}
					>
						{upsertMutation.isPending ? "保存中…" : "保存代理"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
