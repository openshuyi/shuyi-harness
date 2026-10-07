/**
 * 权限规则管理面板（M3）：查看/新增/删除用户配置规则。
 * - 全局规则：~/.agent/permissions.json；项目规则：<cwd>/.agent/permissions.json（项目级优先命中）
 * - 裁决顺序：内置敏感拒绝 → 代理声明 → 用户配置（项目→全局）→ 会话内记住 → 工具级+sandbox → 默认拒绝
 * 墨仪 §09/§19/§20：Dialog + mono 表格（decision 语义 Badge）+ Label 置上的表单。
 */

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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

interface Props {
	/** 当前会话 cwd（项目级规则的定位依据） */
	cwd?: string;
	onClose: () => void;
	open: boolean;
}

interface PermissionRuleItem {
	decision: "allow" | "ask" | "deny";
	index: number;
	pattern: string;
	patternType: "glob" | "regex" | "prefix";
	source: string;
	tool: string;
}

interface RulesResponse {
	global: PermissionRuleItem[];
	project: PermissionRuleItem[];
}

const DECISION_LABEL: Record<string, string> = {
	allow: "允许",
	ask: "询问",
	deny: "拒绝",
};

const DECISION_VARIANT: Record<
	PermissionRuleItem["decision"],
	"success" | "warning" | "destructive"
> = {
	allow: "success",
	ask: "warning",
	deny: "destructive",
};

const EMPTY_FORM = {
	decision: "allow" as "allow" | "ask" | "deny",
	pattern: "",
	scope: "project" as "project" | "global",
	tool: "*",
};

export function PermissionManager({ open, onClose, cwd }: Props) {
	const queryClient = useQueryClient();
	const [form, setForm] = useState(EMPTY_FORM);
	const [error, setError] = useState("");

	const { data } = useQuery<RulesResponse>({
		enabled: open,
		queryFn: async () => {
			const res = await fetch(
				`/api/permissions/rules${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`
			);
			if (!res.ok) throw new Error(`加载失败 ${res.status}`);
			return (await res.json()) as RulesResponse;
		},
		queryKey: ["permission-rules", cwd],
	});

	const invalidate = () =>
		void queryClient.invalidateQueries({ queryKey: ["permission-rules"] });

	const addMutation = useMutation({
		mutationFn: async () => {
			const res = await fetch("/api/permissions/rules", {
				body: JSON.stringify({
					cwd,
					decision: form.decision,
					pattern: form.pattern.trim(),
					scope: form.scope,
					tool: form.tool.trim() || "*",
				}),
				headers: { "content-type": "application/json" },
				method: "POST",
			});
			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(err.error ?? `保存失败 ${res.status}`);
			}
		},
		onError: (err) =>
			setError(err instanceof Error ? err.message : String(err)),
		onSuccess: () => {
			invalidate();
			setForm((f) => ({ ...EMPTY_FORM, scope: f.scope }));
			setError("");
		},
	});

	const removeMutation = useMutation({
		mutationFn: async (args: {
			scope: "project" | "global";
			index: number;
		}) => {
			const res = await fetch("/api/permissions/rules", {
				body: JSON.stringify({ cwd, index: args.index, scope: args.scope }),
				headers: { "content-type": "application/json" },
				method: "DELETE",
			});
			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(err.error ?? `删除失败 ${res.status}`);
			}
		},
		onError: (err) =>
			setError(err instanceof Error ? err.message : String(err)),
		onSuccess: invalidate,
	});

	const renderTable = (
		rules: PermissionRuleItem[],
		scope: "project" | "global"
	) => (
		<div className="overflow-hidden rounded-md border border-border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>工具</TableHead>
						<TableHead>模式</TableHead>
						<TableHead>类型</TableHead>
						<TableHead>裁决</TableHead>
						<TableHead className="w-0" />
					</TableRow>
				</TableHeader>
				<TableBody>
					{rules.length === 0 && (
						<TableRow>
							<TableCell className="py-4 text-center text-faint" colSpan={5}>
								（无规则）
							</TableCell>
						</TableRow>
					)}
					{rules.map((r) => (
						<TableRow key={`${scope}-${r.index}`}>
							<TableCell className="font-mono">{r.tool}</TableCell>
							<TableCell>
								<code className="font-mono text-[12px]">{r.pattern}</code>
							</TableCell>
							<TableCell className="label-mono text-faint">
								{r.patternType}
							</TableCell>
							<TableCell>
								<Badge variant={DECISION_VARIANT[r.decision]}>
									{DECISION_LABEL[r.decision] ?? r.decision}
								</Badge>
							</TableCell>
							<TableCell>
								<Button
									className="text-destructive hover:bg-destructive-soft hover:text-destructive"
									onClick={() =>
										removeMutation.mutate({ index: r.index, scope })
									}
									size="xs"
									variant="ghost"
								>
									删除
								</Button>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);

	const fieldClass = "flex flex-col gap-1.5";
	const labelClass = "text-[12.5px] font-medium text-foreground";

	return (
		<Dialog onOpenChange={(o) => !o && onClose()} open={open}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[680px]">
				<DialogHeader>
					<DialogTitle>权限规则</DialogTitle>
					<DialogDescription>
						命中即裁决，顺序：项目规则 → 全局规则。glob 支持 * 与 **（不支持 !
						否定）；含 *?&#123;&#125;[] 的写法自动按 glob 处理，否则按前缀匹配。
					</DialogDescription>
				</DialogHeader>

				<div className="label-mono text-faint">
					项目规则（.agent/permissions.json）
				</div>
				{renderTable(data?.project ?? [], "project")}

				<div className="label-mono text-faint">
					全局规则（~/.agent/permissions.json）
				</div>
				{renderTable(data?.global ?? [], "global")}

				<div className="label-mono text-faint">新增规则</div>
				<div className="grid grid-cols-2 gap-3">
					<div className={fieldClass}>
						<Label className={labelClass} htmlFor="pm-scope">
							写入位置
						</Label>
						<Select
							onValueChange={(v) =>
								setForm((f) => ({
									...f,
									scope: (v as "project" | "global") ?? "project",
								}))
							}
							value={form.scope}
						>
							<SelectTrigger className="w-full" id="pm-scope">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="project">写入项目配置</SelectItem>
								<SelectItem value="global">写入全局配置</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className={fieldClass}>
						<Label className={labelClass} htmlFor="pm-tool">
							工具名
						</Label>
						<Input
							id="pm-tool"
							onChange={(e) => setForm((f) => ({ ...f, tool: e.target.value }))}
							placeholder="* = 全部，如 bash / write"
							value={form.tool}
						/>
					</div>
					<div className={fieldClass}>
						<Label className={labelClass} htmlFor="pm-pattern">
							模式
						</Label>
						<Input
							className="font-mono"
							id="pm-pattern"
							onChange={(e) =>
								setForm((f) => ({ ...f, pattern: e.target.value }))
							}
							placeholder="tests/**、rm -rf *、src/ …"
							value={form.pattern}
						/>
					</div>
					<div className={fieldClass}>
						<Label className={labelClass} htmlFor="pm-decision">
							裁决
						</Label>
						<Select
							onValueChange={(v) =>
								setForm((f) => ({
									...f,
									decision: (v as "allow" | "ask" | "deny") ?? "allow",
								}))
							}
							value={form.decision}
						>
							<SelectTrigger className="w-full" id="pm-decision">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="allow">允许</SelectItem>
								<SelectItem value="ask">询问</SelectItem>
								<SelectItem value="deny">拒绝</SelectItem>
							</SelectContent>
						</Select>
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
						disabled={addMutation.isPending || !form.pattern.trim()}
						onClick={() => addMutation.mutate()}
					>
						{addMutation.isPending ? "保存中…" : "保存规则"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
