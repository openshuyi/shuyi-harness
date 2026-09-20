/**
 * 权限规则管理面板（M3）：查看/新增/删除用户配置规则。
 * - 全局规则：~/.agent/permissions.json；项目规则：<cwd>/.agent/permissions.json（项目级优先命中）
 * - 裁决顺序：内置敏感拒绝 → 代理声明 → 用户配置（项目→全局）→ 会话内记住 → 工具级+sandbox → 默认拒绝
 * 风格与 AgentManager / ModelManager 一致。
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 当前会话 cwd（项目级规则的定位依据） */
  cwd?: string;
}

interface PermissionRuleItem {
  tool: string;
  pattern: string;
  patternType: "glob" | "regex" | "prefix";
  decision: "allow" | "ask" | "deny";
  source: string;
  index: number;
}

interface RulesResponse {
  project: PermissionRuleItem[];
  global: PermissionRuleItem[];
}

const DECISION_LABEL: Record<string, string> = {
  allow: "允许",
  ask: "询问",
  deny: "拒绝",
};

const EMPTY_FORM = {
  scope: "project" as "project" | "global",
  tool: "*",
  pattern: "",
  decision: "allow" as "allow" | "ask" | "deny",
};

export function PermissionManager({ open, onClose, cwd }: Props) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState("");

  const { data } = useQuery<RulesResponse>({
    queryKey: ["permission-rules", cwd],
    queryFn: async () => {
      const res = await fetch(`/api/permissions/rules${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`);
      if (!res.ok) throw new Error(`加载失败 ${res.status}`);
      return (await res.json()) as RulesResponse;
    },
    enabled: open,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["permission-rules"] });

  const addMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/permissions/rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: form.scope,
          cwd,
          tool: form.tool.trim() || "*",
          pattern: form.pattern.trim(),
          decision: form.decision,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `保存失败 ${res.status}`);
      }
    },
    onSuccess: () => {
      invalidate();
      setForm((f) => ({ ...EMPTY_FORM, scope: f.scope }));
      setError("");
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const removeMutation = useMutation({
    mutationFn: async (args: { scope: "project" | "global"; index: number }) => {
      const res = await fetch("/api/permissions/rules", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: args.scope, cwd, index: args.index }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `删除失败 ${res.status}`);
      }
    },
    onSuccess: invalidate,
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  if (!open) return null;

  const renderTable = (rules: PermissionRuleItem[], scope: "project" | "global") => (
    <table className="model-table">
      <thead>
        <tr>
          <th>工具</th>
          <th>模式</th>
          <th>类型</th>
          <th>裁决</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {rules.length === 0 && (
          <tr>
            <td colSpan={5} style={{ color: "var(--text-dim)" }}>
              （无规则）
            </td>
          </tr>
        )}
        {rules.map((r) => (
          <tr key={`${scope}-${r.index}`}>
            <td>{r.tool}</td>
            <td>
              <code className="remember-pattern">{r.pattern}</code>
            </td>
            <td>{r.patternType}</td>
            <td>{DECISION_LABEL[r.decision] ?? r.decision}</td>
            <td style={{ whiteSpace: "nowrap" }}>
              <button
                className="danger"
                onClick={() => removeMutation.mutate({ scope, index: r.index })}
              >
                删除
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="approval-overlay" onClick={onClose}>
      <div className="approval-dialog" style={{ width: 680 }} onClick={(e) => e.stopPropagation()}>
        <h3>权限规则</h3>
        <div className="risk">
          命中即裁决，顺序：项目规则 → 全局规则。glob 支持 * 与 **（不支持 ! 否定）；含 *?&#123;&#125;[] 的写法自动按 glob 处理，否则按前缀匹配。
        </div>

        <h3 style={{ marginTop: 8 }}>项目规则（.agent/permissions.json）</h3>
        {renderTable(data?.project ?? [], "project")}

        <h3 style={{ marginTop: 16 }}>全局规则（~/.agent/permissions.json）</h3>
        {renderTable(data?.global ?? [], "global")}

        <h3 style={{ marginTop: 16 }}>新增规则</h3>
        <div className="model-form">
          <select
            value={form.scope}
            onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value as "project" | "global" }))}
          >
            <option value="project">写入项目配置</option>
            <option value="global">写入全局配置</option>
          </select>
          <input
            placeholder="工具名（* = 全部，如 bash / write）"
            value={form.tool}
            onChange={(e) => setForm((f) => ({ ...f, tool: e.target.value }))}
          />
          <input
            placeholder="模式：tests/**、rm -rf *、src/ …"
            value={form.pattern}
            onChange={(e) => setForm((f) => ({ ...f, pattern: e.target.value }))}
          />
          <select
            value={form.decision}
            onChange={(e) =>
              setForm((f) => ({ ...f, decision: e.target.value as "allow" | "ask" | "deny" }))
            }
          >
            <option value="allow">允许</option>
            <option value="ask">询问</option>
            <option value="deny">拒绝</option>
          </select>
        </div>

        {error && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>{error}</div>}

        <div className="approval-actions" style={{ marginTop: 16 }}>
          <button onClick={onClose}>关闭</button>
          <button
            className="primary"
            disabled={addMutation.isPending || !form.pattern.trim()}
            onClick={() => addMutation.mutate()}
          >
            {addMutation.isPending ? "保存中…" : "保存规则"}
          </button>
        </div>
      </div>
    </div>
  );
}
