/**
 * 代理管理面板（M2）：查看全部代理定义（builtin/user/project/runtime），
 * 增删 runtime 代理。数据来自 GET /api/agents，增删走 PUT/DELETE /api/agents/:name。
 * 风格与 ModelManager 一致。
 */

import type { AgentInfo, UpsertAgentRequest } from "@shuyi-harness/types";
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

	if (!open) return null;
	const set = (patch: Partial<typeof EMPTY_FORM>) =>
		setForm((f) => ({ ...f, ...patch }));

	return (
		<div className="approval-overlay" onClick={onClose}>
			<div
				className="approval-dialog"
				onClick={(e) => e.stopPropagation()}
				style={{ width: 680 }}
			>
				<h3>代理管理</h3>
				<div className="risk">
					代理 = 提示词 + 模型 +
					工具面。内置/全局/项目来源只读；运行时定义保存在
					~/.agent/agents.json。
				</div>

				<table className="model-table">
					<thead>
						<tr>
							<th>名称</th>
							<th>描述</th>
							<th>工具面</th>
							<th>模型</th>
							<th>来源</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{agents.map((a) => (
							<tr key={`${a.source}-${a.name}`}>
								<td>
									{a.name}
									{a.modeDefault && (
										<span className="model-badge">{a.modeDefault}</span>
									)}
								</td>
								<td title={a.system}>{a.description || "—"}</td>
								<td>{toolsLabel(a.tools)}</td>
								<td>{a.model ?? "继承"}</td>
								<td>{SOURCE_LABEL[a.source]}</td>
								<td style={{ whiteSpace: "nowrap" }}>
									{a.source === "runtime" && (
										<button
											className="danger"
											onClick={() => removeMutation.mutate(a.name)}
										>
											删除
										</button>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>

				<h3 style={{ marginTop: 16 }}>新增/覆盖运行时代理</h3>
				<div className="model-form">
					<input
						onChange={(e) => set({ name: e.target.value.trim() })}
						placeholder="name（不可与内置同名）"
						value={form.name}
					/>
					<input
						onChange={(e) => set({ description: e.target.value })}
						placeholder="描述（可选）"
						value={form.description ?? ""}
					/>
					<input
						onChange={(e) => set({ toolsText: e.target.value })}
						placeholder="工具面：all / readonly / 逗号分隔白名单"
						value={form.toolsText}
					/>
					<input
						onChange={(e) => set({ model: e.target.value.trim() })}
						placeholder="模型覆盖（可选，缺省继承会话）"
						value={form.model ?? ""}
					/>
					<select
						onChange={(e) =>
							set({
								modeDefault: (e.target.value || undefined) as
									| "plan"
									| "build"
									| undefined,
							})
						}
						value={form.modeDefault ?? ""}
					>
						<option value="">模式语义：无（跟随会话）</option>
						<option value="build">build（可写）</option>
						<option value="plan">plan（只读）</option>
					</select>
					<textarea
						onChange={(e) => set({ system: e.target.value })}
						placeholder="系统提示（prompt）正文"
						rows={4}
						style={{ gridColumn: "span 2" }}
						value={form.system ?? ""}
					/>
				</div>

				{error && (
					<div style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>
						{error}
					</div>
				)}

				<div className="approval-actions" style={{ marginTop: 16 }}>
					<button onClick={onClose}>关闭</button>
					<button
						className="primary"
						disabled={upsertMutation.isPending || !form.name || !form.system}
						onClick={() => upsertMutation.mutate()}
					>
						{upsertMutation.isPending ? "保存中…" : "保存代理"}
					</button>
				</div>
			</div>
		</div>
	);
}
