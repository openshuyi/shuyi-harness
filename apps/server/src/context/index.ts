/**
 * 上下文工程模块：
 * - rebuild：从事件日志确定性重建模型输入（唯一算法，见《事件模型设计》§5）
 * - assemble：系统前缀（逐字节稳定）+ 记忆注入 + token 估算
 * - 压缩（P2）：此处预留阈值检测与结构化模板接口
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentEvent, SessionRecord } from "@shuyi/types";
import type { EventStore } from "../store/event-store.js";
import type { ChatMessage, ToolSpec } from "../model/types.js";

// ---------- 系统前缀（逐字节稳定：不放时间戳/会话 ID 等易变信息） ----------
export function buildSystemPrefix(opts: { mode: string; tools: ToolSpec[] }): string {
  const toolNames = opts.tools.map((t) => t.name).join(", ");
  const modeRules =
    opts.mode === "plan"
      ? "当前为 Plan 模式：只读分析，给出计划，不修改任何文件，不执行命令。"
      : "当前为 Build 模式：可以修改文件与执行命令，但修改前先说明意图。";
  return [
    "你是一个编码智能体，运行在本地的 agent 框架中。",
    "",
    "## 工作方式",
    "- 使用工具逐步完成任务，不要臆测文件内容，先 read 再 edit。",
    "- 编辑文件使用 edit（外科式替换），避免整文件重写。",
    "- 大文件分页读取（offset/limit）。",
    `- 可用工具：${toolNames}`,
    "",
    "## 模式",
    modeRules,
    "",
    "## 记忆",
    "重要的架构决策、用户偏好、环境常量，应主动写入记忆（见 memory 文件内容，若有）。",
  ].join("\n");
}

export function prefixHash(prefix: string): string {
  return createHash("sha256").update(prefix).digest("hex").slice(0, 16);
}

// ---------- 记忆注入 ----------
export function readMemory(cwd: string): string | null {
  const candidates = [
    path.join(cwd, ".agent", "memory.md"),
    path.join(os_home(), ".agent", "memory.md"),
  ];
  const parts: string[] = [];
  for (const p of candidates) {
    try {
      const content = fs.readFileSync(p, "utf-8").trim();
      if (content) parts.push(`[记忆 ${p}]\n${content}`);
    } catch {
      // 不存在则跳过
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function os_home(): string {
  return process.env.HOME ?? "/root";
}

// ---------- token 估算（粗略：4 字符 ≈ 1 token） ----------
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(msgs: ChatMessage[]): number {
  return msgs.reduce((sum, m) => sum + estimateTokens(m.content) + (m.tool_calls ? 50 * m.tool_calls.length : 4), 0);
}

/** 压缩阈值：窗口填充 ~75% 触发（P2 实现结构化压缩，此处先暴露判定） */
export function shouldCompact(tokenEstimate: number, contextWindow: number): boolean {
  return tokenEstimate > contextWindow * 0.75;
}

// ---------- 上下文重建（确定性 fold，delta 事件不参与） ----------
export interface RebuildResult {
  messages: ChatMessage[];
  coversUntilSeq: number;
  compacted: boolean;
}

export function rebuildContext(
  store: EventStore,
  session: SessionRecord,
  tools: ToolSpec[],
): RebuildResult & { system: string } {
  const events = store.readSince(session.session_id, -1);

  // 1. 找最新压缩边界
  let coversUntilSeq = -1;
  let compactionSummary: string | null = null;
  for (const e of events) {
    if (e.type === "context.compacted") {
      const p = e.payload as { covers_until_seq: number; summary: Record<string, unknown> };
      if (p.covers_until_seq > coversUntilSeq) {
        coversUntilSeq = p.covers_until_seq;
        compactionSummary = formatCompactionSummary(p.summary as never);
      }
    }
  }

  // 2. fold 边界之后的事件
  const messages: ChatMessage[] = [];
  if (compactionSummary) {
    messages.push({ role: "user", content: compactionSummary });
  }

  for (const e of events) {
    if (e.seq <= coversUntilSeq) continue;
    foldEvent(e, messages);
  }

  // 3. 修补未配对的工具调用（服务端在工具执行中途崩溃/中断时会出现）。
  //    OpenAI 协议要求每个 tool_call 都有对应 tool 消息，否则请求报错。
  patchUnpairedToolCalls(messages);

  return {
    system: buildSystemPrefix({ mode: session.mode, tools }),
    messages,
    coversUntilSeq,
    compacted: compactionSummary !== null,
  };
}

function foldEvent(e: AgentEvent, messages: ChatMessage[]): void {
  switch (e.type) {
    case "message.user": {
      const p = e.payload as { text: string };
      messages.push({ role: "user", content: p.text });
      break;
    }
    case "message.assistant.completed": {
      const p = e.payload as { text: string };
      // 助手消息若带有工具调用，需在 fold 时合并：从后续 proposed 事件里找回
      messages.push({ role: "assistant", content: p.text });
      break;
    }
    case "tool.call.proposed": {
      const p = e.payload as { call_id: string; tool: string; args: Record<string, unknown> };
      // 把工具调用挂到最近一条 assistant 消息上
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      if (lastAssistant) {
        lastAssistant.tool_calls = [
          ...(lastAssistant.tool_calls ?? []),
          { id: p.call_id, name: p.tool, args: p.args },
        ];
      }
      break;
    }
    case "tool.call.completed": {
      const p = e.payload as { call_id: string; result: string };
      messages.push({ role: "tool", content: p.result, tool_call_id: p.call_id });
      break;
    }
    case "tool.call.failed": {
      const p = e.payload as { call_id: string; error: string };
      messages.push({ role: "tool", content: `[工具执行失败] ${p.error}`, tool_call_id: p.call_id });
      break;
    }
    case "session.config_changed": {
      const p = e.payload as { mode?: string; model?: string };
      const changes = Object.entries(p)
        .map(([k, v]) => `${k} → ${v}`)
        .join(", ");
      messages.push({ role: "user", content: `[系统注记：会话配置变更 ${changes}]` });
      break;
    }
    default:
      // delta / status / 统计类事件不参与重建
      break;
  }
}

// 说明：被拒绝的工具调用由 Loop 以 tool.call.failed 事件落库，
// fold 时自然形成带正确 tool_call_id 的 tool 消息（协议要求 call 与 result 配对），
// 因此 approval.resolved 不参与重建（仅作审计留痕）。

function patchUnpairedToolCalls(messages: ChatMessage[]): void {
  const answered = new Set(
    messages.filter((m) => m.role === "tool" && m.tool_call_id).map((m) => m.tool_call_id!),
  );
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const missing = m.tool_calls.filter((tc) => !answered.has(tc.id));
    if (missing.length === 0) continue;
    const synthetic = missing.map((tc) => ({
      role: "tool" as const,
      content: "[调用未完成：会话在工具执行前/执行中被中断或崩溃]",
      tool_call_id: tc.id,
    }));
    messages.splice(i + 1, 0, ...synthetic);
    for (const tc of missing) answered.add(tc.id);
  }
}

function formatCompactionSummary(s: {
  session_intent: string;
  files_modified: string[];
  key_decisions: string[];
  active_goals: string[];
  next_steps: string;
}): string {
  return [
    "[以下为此前会话的压缩摘要]",
    `## Session Intent\n${s.session_intent}`,
    `## Files Modified\n${s.files_modified.map((f) => `- ${f}`).join("\n") || "(无)"}`,
    `## Key Decisions\n${s.key_decisions.map((d) => `- ${d}`).join("\n") || "(无)"}`,
    `## Active Goals\n${s.active_goals.map((g) => `- ${g}`).join("\n") || "(无)"}`,
    `## Next Steps\n${s.next_steps}`,
  ].join("\n\n");
}
