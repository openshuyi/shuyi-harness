/**
 * 模型管理面板：查看/新增/删除模型，设置默认模型。
 * 数据来自 GET /api/models，增删走 POST/DELETE /api/models。
 * 墨仪 §09/§19/§20：Dialog + mono 表格 + Label 置上的表单。
 */

import type { AddModelRequest, ModelInfo } from "@shuyi-harness/types";
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
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@shuyi-harness/ui/components/ui/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { fetchJson, fetchJsonArray } from "../core/api.js";

interface Props {
	onClose: () => void;
	open: boolean;
}

const EMPTY_FORM: AddModelRequest = {
	apiKey: "",
	baseURL: "",
	contextWindow: undefined,
	id: "",
	label: "",
	makeDefault: true,
	model: "",
	pricing: undefined,
};

export function ModelManager({ open, onClose }: Props) {
	const queryClient = useQueryClient();
	const [form, setForm] = useState<AddModelRequest>(EMPTY_FORM);
	const [error, setError] = useState("");

	const { data: models = [] } = useQuery<ModelInfo[]>({
		enabled: open,
		queryFn: () => fetchJsonArray<ModelInfo>("/api/models"),
		queryKey: ["models"],
	});

	const invalidate = () =>
		void queryClient.invalidateQueries({ queryKey: ["models"] });

	const addMutation = useMutation({
		mutationFn: async () => {
			const payload: AddModelRequest = {
				...form,
				contextWindow: form.contextWindow || undefined,
				label: form.label || undefined,
				pricing:
					form.pricing && form.pricing.input > 0 ? form.pricing : undefined,
			};
			return fetchJson<ModelInfo>("/api/models", {
				body: JSON.stringify(payload),
				headers: { "content-type": "application/json" },
				method: "POST",
			});
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
		mutationFn: (id: string) =>
			fetch(`/api/models/${id}`, { method: "DELETE" }).then(async (r) => {
				if (!r.ok)
					throw new Error(
						((await r.json()) as { error?: string }).error ??
							`删除失败 ${r.status}`
					);
			}),
		onError: (err) =>
			setError(err instanceof Error ? err.message : String(err)),
		onSuccess: invalidate,
	});

	const defaultMutation = useMutation({
		mutationFn: (id: string) =>
			fetch(`/api/models/${id}/default`, { method: "POST" }).then(async (r) => {
				if (!r.ok) throw new Error(`设置默认失败 ${r.status}`);
			}),
		onSuccess: invalidate,
	});

	const set = (patch: Partial<AddModelRequest>) =>
		setForm((f) => ({ ...f, ...patch }));

	const fieldClass = "flex flex-col gap-1.5";
	const labelClass = "text-[12.5px] font-medium text-foreground";

	return (
		<Dialog onOpenChange={(o) => !o && onClose()} open={open}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[640px]">
				<DialogHeader>
					<DialogTitle>模型管理</DialogTitle>
					<DialogDescription>
						OpenAI 兼容协议端点（OpenAI / DeepSeek / 其他 /chat/completions
						服务）
					</DialogDescription>
				</DialogHeader>

				{/* 现有模型列表 */}
				<div className="overflow-hidden rounded-md border border-border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>模型</TableHead>
								<TableHead>上游模型</TableHead>
								<TableHead className="text-right">上下文</TableHead>
								<TableHead className="text-right">定价 $/M</TableHead>
								<TableHead>来源</TableHead>
								<TableHead className="w-0" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{models.map((m) => (
								<TableRow key={m.id}>
									<TableCell className="font-mono">
										<span className="flex items-center gap-1.5">
											{m.label}
											{m.isDefault && <Badge variant="accent">默认</Badge>}
										</span>
									</TableCell>
									<TableCell className="max-w-[150px] truncate font-mono text-muted-foreground">
										{m.model ?? "—"}
									</TableCell>
									<TableCell className="text-right font-mono tnum">
										{m.contextWindow >= 1000
											? `${Math.round(m.contextWindow / 1000)}k`
											: m.contextWindow}
									</TableCell>
									<TableCell className="text-right font-mono tnum">
										{m.pricing ? `${m.pricing.input}/${m.pricing.output}` : "—"}
									</TableCell>
									<TableCell className="text-muted-foreground">
										{m.source}
									</TableCell>
									<TableCell>
										<span className="flex items-center justify-end gap-1 whitespace-nowrap">
											{!m.isDefault && (
												<Button
													onClick={() => defaultMutation.mutate(m.id)}
													size="xs"
													variant="outline"
												>
													设默认
												</Button>
											)}
											{(m.source === "file" || m.source === "runtime") && (
												<Button
													className="text-destructive hover:bg-destructive-soft hover:text-destructive"
													onClick={() => removeMutation.mutate(m.id)}
													size="xs"
													variant="ghost"
												>
													删除
												</Button>
											)}
										</span>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>

				{/* 新增模型表单 */}
				<div className="label-mono text-faint">新增模型</div>
				<div className="grid grid-cols-2 gap-3">
					<div className={fieldClass}>
						<Label className={labelClass} htmlFor="mm-id">
							ID
						</Label>
						<Input
							id="mm-id"
							onChange={(e) => set({ id: e.target.value.trim() })}
							placeholder="如 deepseek"
							value={form.id}
						/>
					</div>
					<div className={fieldClass}>
						<Label className={labelClass} htmlFor="mm-model">
							上游模型
						</Label>
						<Input
							id="mm-model"
							onChange={(e) => set({ model: e.target.value.trim() })}
							placeholder="如 deepseek-chat"
							value={form.model}
						/>
					</div>
					<div className="col-span-2 flex flex-col gap-1.5">
						<Label className={labelClass} htmlFor="mm-base-url">
							Base URL
						</Label>
						<Input
							id="mm-base-url"
							onChange={(e) => set({ baseURL: e.target.value.trim() })}
							placeholder="https://api.deepseek.com/v1"
							value={form.baseURL}
						/>
					</div>
					<div className={fieldClass}>
						<Label className={labelClass} htmlFor="mm-api-key">
							API Key
						</Label>
						<Input
							id="mm-api-key"
							onChange={(e) => set({ apiKey: e.target.value.trim() })}
							type="password"
							value={form.apiKey}
						/>
					</div>
					<div className={fieldClass}>
						<Label className={labelClass} htmlFor="mm-label">
							显示名（可选）
						</Label>
						<Input
							id="mm-label"
							onChange={(e) => set({ label: e.target.value })}
							value={form.label ?? ""}
						/>
					</div>
					<div className={fieldClass}>
						<Label className={labelClass} htmlFor="mm-ctx">
							上下文窗口（默认 128000）
						</Label>
						<Input
							id="mm-ctx"
							onChange={(e) =>
								set({
									contextWindow: e.target.value
										? Number(e.target.value)
										: undefined,
								})
							}
							type="number"
							value={form.contextWindow ?? ""}
						/>
					</div>
					<div className={fieldClass}>
						<Label className={labelClass}>定价 $/M（可选）</Label>
						<div className="grid grid-cols-2 gap-1.5">
							<Input
								onChange={(e) =>
									set({
										pricing: {
											input: Number(e.target.value) || 0,
											output: form.pricing?.output ?? 0,
										},
									})
								}
								placeholder="输入价"
								step="0.01"
								type="number"
								value={form.pricing?.input ?? ""}
							/>
							<Input
								onChange={(e) =>
									set({
										pricing: {
											input: form.pricing?.input ?? 0,
											output: Number(e.target.value) || 0,
										},
									})
								}
								placeholder="输出价"
								step="0.01"
								type="number"
								value={form.pricing?.output ?? ""}
							/>
						</div>
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
						disabled={
							addMutation.isPending ||
							!form.id ||
							!form.baseURL ||
							!form.apiKey ||
							!form.model
						}
						onClick={() => addMutation.mutate()}
					>
						{addMutation.isPending ? "保存中…" : "添加模型"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
