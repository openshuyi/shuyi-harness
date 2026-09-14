/**
 * 模型管理面板：查看/新增/删除模型，设置默认模型。
 * 数据来自 GET /api/models，增删走 POST/DELETE /api/models。
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ModelInfo, AddModelRequest } from "@shuyi/types";
import { fetchJson, fetchJsonArray } from "../core/api.js";

interface Props {
  open: boolean;
  onClose: () => void;
}

const EMPTY_FORM: AddModelRequest = {
  id: "",
  baseURL: "",
  apiKey: "",
  model: "",
  label: "",
  contextWindow: undefined,
  pricing: undefined,
  makeDefault: true,
};

export function ModelManager({ open, onClose }: Props) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<AddModelRequest>(EMPTY_FORM);
  const [error, setError] = useState("");

  const { data: models = [] } = useQuery<ModelInfo[]>({
    queryKey: ["models"],
    queryFn: () => fetchJsonArray<ModelInfo>("/api/models"),
    enabled: open,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["models"] });

  const addMutation = useMutation({
    mutationFn: async () => {
      const payload: AddModelRequest = {
        ...form,
        label: form.label || undefined,
        contextWindow: form.contextWindow || undefined,
        pricing:
          form.pricing && form.pricing.input > 0
            ? form.pricing
            : undefined,
      };
      return fetchJson<ModelInfo>("/api/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      invalidate();
      setForm(EMPTY_FORM);
      setError("");
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/models/${id}`, { method: "DELETE" }).then(async (r) => {
        if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `删除失败 ${r.status}`);
      }),
    onSuccess: invalidate,
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const defaultMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/models/${id}/default`, { method: "POST" }).then(async (r) => {
        if (!r.ok) throw new Error(`设置默认失败 ${r.status}`);
      }),
    onSuccess: invalidate,
  });

  if (!open) return null;
  const set = (patch: Partial<AddModelRequest>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div className="approval-overlay" onClick={onClose}>
      <div className="approval-dialog" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
        <h3>模型管理</h3>
        <div className="risk">OpenAI 兼容协议端点（OpenAI / DeepSeek / 其他 /chat/completions 服务）</div>

        {/* 现有模型列表 */}
        <table className="model-table">
          <thead>
            <tr>
              <th>ID</th><th>上游模型</th><th>上下文</th><th>定价 ($/M)</th><th>来源</th><th></th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.label}
                  {m.isDefault && <span className="model-badge">默认</span>}
                </td>
                <td>{m.model ?? "—"}</td>
                <td>{m.contextWindow >= 1000 ? `${Math.round(m.contextWindow / 1000)}k` : m.contextWindow}</td>
                <td>{m.pricing ? `${m.pricing.input}/${m.pricing.output}` : "—"}</td>
                <td>{m.source}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {!m.isDefault && (
                    <button onClick={() => defaultMutation.mutate(m.id)}>设默认</button>
                  )}
                  {(m.source === "file" || m.source === "runtime") && (
                    <button className="danger" onClick={() => removeMutation.mutate(m.id)}>删除</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* 新增模型表单 */}
        <h3 style={{ marginTop: 16 }}>新增模型</h3>
        <div className="model-form">
          <input placeholder="id（如 deepseek）" value={form.id} onChange={(e) => set({ id: e.target.value.trim() })} />
          <input placeholder="上游模型名（如 deepseek-chat）" value={form.model} onChange={(e) => set({ model: e.target.value.trim() })} />
          <input placeholder="Base URL（如 https://api.deepseek.com/v1）" value={form.baseURL} onChange={(e) => set({ baseURL: e.target.value.trim() })} style={{ gridColumn: "span 2" }} />
          <input placeholder="API Key" type="password" value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value.trim() })} />
          <input placeholder="显示名（可选）" value={form.label ?? ""} onChange={(e) => set({ label: e.target.value })} />
          <input
            placeholder="上下文窗口（可选，默认 128000）"
            type="number"
            value={form.contextWindow ?? ""}
            onChange={(e) => set({ contextWindow: e.target.value ? Number(e.target.value) : undefined })}
          />
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              placeholder="输入价 $/M"
              type="number"
              step="0.01"
              style={{ width: "50%" }}
              value={form.pricing?.input ?? ""}
              onChange={(e) =>
                set({
                  pricing: {
                    input: Number(e.target.value) || 0,
                    output: form.pricing?.output ?? 0,
                  },
                })
              }
            />
            <input
              placeholder="输出价 $/M"
              type="number"
              step="0.01"
              style={{ width: "50%" }}
              value={form.pricing?.output ?? ""}
              onChange={(e) =>
                set({
                  pricing: {
                    input: form.pricing?.input ?? 0,
                    output: Number(e.target.value) || 0,
                  },
                })
              }
            />
          </div>
        </div>

        {error && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>{error}</div>}

        <div className="approval-actions" style={{ marginTop: 16 }}>
          <button onClick={onClose}>关闭</button>
          <button
            className="primary"
            disabled={addMutation.isPending || !form.id || !form.baseURL || !form.apiKey || !form.model}
            onClick={() => addMutation.mutate()}
          >
            {addMutation.isPending ? "保存中…" : "添加模型"}
          </button>
        </div>
      </div>
    </div>
  );
}
