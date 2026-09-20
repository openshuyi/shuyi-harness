import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentInfo, ModelInfo } from "@shuyi/types";
import { useSessionStore, type PaneSlot } from "../core/store.js";
import { fetchJson, fetchJsonArray } from "../core/api.js";

/** P0-4a：斜杠命令定义（/api/sessions/:id/commands） */
interface CommandInfo {
  name: string;
  description: string;
  source: "global" | "project";
}
import { ModelManager } from "./ModelManager.js";
import { AgentManager } from "./AgentManager.js";
import { PermissionManager } from "./PermissionManager.js";

export function Composer({ slot = "primary" }: { slot?: PaneSlot }) {
  const current = useSessionStore((s) => (slot === "secondary" ? s.split : s.current));
  const trajectory = useSessionStore((s) => (slot === "secondary" ? s.splitTrajectory : s.trajectory));
  const { sendMessage, abort, setMode, setModel, setAgent } = useSessionStore();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [agentManagerOpen, setAgentManagerOpen] = useState(false);
  const [permManagerOpen, setPermManagerOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);

  const { data: models = [] } = useQuery<ModelInfo[]>({
    queryKey: ["models"],
    queryFn: async () => {
      try {
        return await fetchJsonArray<ModelInfo>("/api/models");
      } catch {
        return [];
      }
    },
  });

  // M2：代理选择器（按当前会话 cwd 加载，含项目级定义）
  const { data: agents = [] } = useQuery<AgentInfo[]>({
    queryKey: ["agents", current?.cwd],
    queryFn: async () => {
      try {
        return await fetchJsonArray<AgentInfo>(
          `/api/agents${current ? `?cwd=${encodeURIComponent(current.cwd)}` : ""}`,
        );
      } catch {
        return [];
      }
    },
    enabled: !!current,
  });

  // P0-4a：斜杠命令清单（输入 "/" 开头时自动补全）
  const { data: commands = [] } = useQuery<CommandInfo[]>({
    queryKey: ["commands", current?.session_id],
    queryFn: async () => {
      try {
        const data = await fetchJson<{ commands: CommandInfo[] }>(
          `/api/sessions/${current!.session_id}/commands`,
        );
        return data.commands;
      } catch {
        return [];
      }
    },
    enabled: !!current,
  });

  if (!current) return null;
  const busy = trajectory.status === "running" || trajectory.status === "awaiting_approval";
  // M2：当前会话代理（缺省内置 build）
  const currentAgent = current.agent ?? "build";
  const currentAgentDesc = agents.find((a) => a.name === currentAgent)?.description;

  // P0-4a：补全候选——整行匹配 /xxx 前缀时弹出
  const slashPrefix = text.match(/^\/([\w-]*)$/)?.[1];
  const slashCandidates =
    slashPrefix !== undefined ? commands.filter((c) => c.name.startsWith(slashPrefix)) : [];
  const slashOpen = slashCandidates.length > 0;
  const pickCommand = (name: string) => {
    setText(`/${name} `);
    setSlashIdx(0);
  };

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setSending(true);
    try {
      await sendMessage(slot, t, files.length ? files : undefined);
      setText("");
      setFiles([]);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="composer">
      <div className="composer-inner">
      <div className="composer-toolbar">
        <select
          value={current.mode}
          onChange={(e) => void setMode(slot, e.target.value as "plan" | "build")}
        >
          <option value="build">Build 模式</option>
          <option value="plan">Plan 模式</option>
        </select>
        <select value={current.model} onChange={(e) => void setModel(slot, e.target.value)}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {/* M2：代理选择器（title 显示当前代理描述） */}
        <select
          value={currentAgent}
          title={currentAgentDesc ?? "选择会话代理"}
          onChange={(e) =>
            void setAgent(slot, e.target.value).catch((err) =>
              alert(err instanceof Error ? err.message : String(err)),
            )
          }
        >
          {[...new Set(["build", ...agents.map((a) => a.name)])].map((name) => (
            <option key={name} value={name}>
              {name === currentAgent ? `代理: ${name}` : name}
            </option>
          ))}
        </select>
        <button onClick={() => setAgentManagerOpen(true)} title="代理管理">
          ⚙ 代理
        </button>
        <button onClick={() => setManagerOpen(true)} title="模型管理">
          ⚙ 模型
        </button>
        <button onClick={() => setPermManagerOpen(true)} title="权限规则管理">
          ⚙ 权限
        </button>
        <span className="usage">
          tokens: {trajectory.usage.prompt} in / {trajectory.usage.completion} out
          {current.usage?.cost_usd != null && <> · ${current.usage.cost_usd.toFixed(4)}</>}
        </span>
      </div>
      <ModelManager open={managerOpen} onClose={() => setManagerOpen(false)} />
      <AgentManager
        open={agentManagerOpen}
        onClose={() => setAgentManagerOpen(false)}
        cwd={current.cwd}
      />
      <PermissionManager
        open={permManagerOpen}
        onClose={() => setPermManagerOpen(false)}
        cwd={current.cwd}
      />
      {files.length > 0 && (
        <div className="attachment-bar">
          {files.map((f, i) => (
            <span key={i} className="attachment-chip">
              📎 {f.name}
              <button onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      )}
      {slashOpen && (
        <div className="slash-palette">
          {slashCandidates.map((c, i) => (
            <button
              key={c.name}
              className={`slash-item ${i === slashIdx ? "active" : ""}`}
              onMouseEnter={() => setSlashIdx(i)}
              onClick={() => pickCommand(c.name)}
            >
              <span className="slash-name">/{c.name}</span>
              <span className="slash-desc">{c.description || "自定义命令"}</span>
              <span className="slash-source">{c.source === "project" ? "项目" : "全局"}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-row">
        <label className="attach-btn" title="添加附件（文件将保存到工作区供 agent 读取）">
          📎
          <input
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files) setFiles([...files, ...Array.from(e.target.files)]);
              e.target.value = "";
            }}
          />
        </label>
        <textarea
          rows={3}
          placeholder={busy ? "Agent 运行中…" : "输入消息，Enter 发送，Shift+Enter 换行"}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // P0-4a：补全面板打开时，↑↓ 选择、Tab/Enter 补全
            if (slashOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashIdx((i) => (i + 1) % slashCandidates.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIdx((i) => (i - 1 + slashCandidates.length) % slashCandidates.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                pickCommand(slashCandidates[Math.min(slashIdx, slashCandidates.length - 1)].name);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setText(text.replace(/^\/[\w-]*$/, ""));
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {busy ? (
          <button className="abort-btn" onClick={() => void abort(slot)}>
            ■ 中断
          </button>
        ) : (
          <button
            className="send-btn"
            onClick={() => void submit()}
            disabled={sending || !text.trim()}
            title="发送（Enter）"
          >
            ↑
          </button>
        )}
      </div>
      </div>
    </div>
  );
}
