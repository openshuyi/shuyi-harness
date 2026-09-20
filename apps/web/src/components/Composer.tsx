/**
 * Composer（v0.4）：
 * - / 斜杠命令补全 + @ 文件引用补全（同一套 palette 交互）
 * - busy 时可继续发送（服务端排队），排队 chips 可撤回；「打断并发送」= abort + 排队
 * - Esc：补全打开→关闭；busy→中断；否则清空输入；空输入 ↑ 召回历史
 * - 消息编辑重发：requestEdit 载入文本，提交前先 conversation-rewind 再发送
 * - 常驻用量条（tokens / 成本 / 上下文估算占比）
 */
import { useEffect, useRef, useState } from "react";
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

  // F3：@ 文件补全（输入尾部 @xxx 时查询；防抖由 React Query 的 queryKey 天然合并）
  const { data: atFiles = [] } = useQuery<string[]>({
    queryKey: ["files", current?.session_id, atQuery],
    queryFn: async () => {
      try {
        const data = await fetchJson<{ files: string[] }>(
          `/api/sessions/${current!.session_id}/files?q=${encodeURIComponent(atQuery ?? "")}`,
        );
        return data.files;
      } catch {
        return [];
      }
    },
    enabled: !!current && atQuery !== null,
    staleTime: 5_000,
  });

  if (!current) return null;
  const busy = trajectory.status === "running" || trajectory.status === "awaiting_approval";
  // M2：当前会话代理（缺省内置 build）
  const currentAgent = current.agent ?? "build";
  const currentAgentDesc = agents.find((a) => a.name === currentAgent)?.description;

  // / 补全候选
  const slashPrefix = text.match(/^\/([\w-]*)$/)?.[1];
  const slashCandidates =
    slashPrefix !== undefined ? commands.filter((c) => c.name.startsWith(slashPrefix)) : [];
  const slashOpen = slashCandidates.length > 0;
  const pickCommand = (name: string) => {
    setText(`/${name} `);
    setSlashIdx(0);
  };

  // @ 补全候选（尾部 @xxx）
  const atMatch = text.match(/(?:^|\s)@([\w./-]*)$/);
  const atOpen = atQuery !== null && atMatch !== null && atFiles.length > 0;
  const pickFile = (rel: string) => {
    setText(text.replace(/(?:^|\s)@([\w./-]*)$/, (m) => (m.startsWith(" ") ? ` @${rel} ` : `@${rel} `)));
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
  const ctxWindow = (modelInfo as { contextWindow?: number } | undefined)?.contextWindow;
  const ctxPct =
    ctxWindow && trajectory.usage.prompt > 0
      ? Math.min(99, Math.round((trajectory.usage.prompt / ctxWindow) * 100))
      : null;

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
        {/* F6：常驻用量条（tokens / 成本 / 上下文占比估算） */}
        <span className={`usage ${ctxPct !== null && ctxPct > 70 ? "usage-warn" : ""}`}>
          {trajectory.usage.prompt.toLocaleString()} in / {trajectory.usage.completion.toLocaleString()} out
          {current.usage?.cost_usd != null && <> · ${current.usage.cost_usd.toFixed(4)}</>}
          {ctxPct !== null && <> · 上下文 {ctxPct}%</>}
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
      {/* F4：排队消息 chips */}
      {trajectory.queued.length > 0 && (
        <div className="queue-bar">
          {trajectory.queued.map((q) => (
            <span key={q.queueId} className="queue-chip" title={q.text}>
              ⏳ {q.text.slice(0, 40)}{q.text.length > 40 ? "…" : ""}
              <button onClick={() => void cancelQueued(slot, q.queueId)} title="撤回">×</button>
            </span>
          ))}
        </div>
      )}
      {editingSeq !== null && (
        <div className="edit-banner">
          ✎ 正在编辑历史消息——发送后将移除其后的会话内容
          <button onClick={() => { clearEditRequest(); setText(""); }}>取消</button>
        </div>
      )}
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
      {atOpen && (
        <div className="slash-palette">
          {atFiles.map((f, i) => (
            <button
              key={f}
              className={`slash-item ${i === atIdx ? "active" : ""}`}
              onMouseEnter={() => setAtIdx(i)}
              onClick={() => pickFile(f)}
            >
              <span className="slash-name">@{f}</span>
              <span className="slash-desc">引用文件内容</span>
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
          ref={textareaRef}
          rows={3}
          placeholder={
            busy
              ? "运行中——可直接输入排队（Enter 发送），或点「打断并发送」"
              : "输入消息（/ 命令、@ 引用文件），Enter 发送"
          }
          value={text}
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
              ? { len: slashCandidates.length, pick: () => pickCommand(slashCandidates[Math.min(slashIdx, slashCandidates.length - 1)].name), idx: slashIdx, setIdx: setSlashIdx }
              : atOpen
                ? { len: atFiles.length, pick: () => pickFile(atFiles[Math.min(atIdx, atFiles.length - 1)]), idx: atIdx, setIdx: setAtIdx }
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
            if (e.key === "ArrowUp" && (text === "" || histIdx >= 0) && history.length > 0) {
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
        />
        {busy ? (
          <>
            <button
              className="interrupt-send-btn"
              disabled={sending || !text.trim()}
              onClick={() => void interruptAndSend()}
              title="中断当前轮次并立即发送（Esc 仅中断）"
            >
              ⇧ 打断发送
            </button>
            <button className="abort-btn" onClick={() => void abort(slot)} title="中断（Esc）">
              ■
            </button>
          </>
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
