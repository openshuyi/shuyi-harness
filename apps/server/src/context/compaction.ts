/**
 * 结构化压缩（P2）。
 * 流程（对应《事件模型设计》与架构文档 §上下文工程）：
 *   1. 确定性清理（零模型成本）：重复文件读取只留最新、截断冗长工具输出
 *   2. 调模型按结构化模板产出摘要（Session Intent / Files Modified /
 *      Key Decisions / Active Goals / Next Steps），禁止自由摘要
 *   3. 写 context.compacted 事件（covers_until_seq 为重建边界）
 * 阈值：token 估算 > 窗口 * 0.75（留空间给压缩提示本身）。
 */
import type { AgentEvent } from "@shuyi/types";
import type { ChatMessage, ModelAdapter } from "../model/types.js";
import type { EventStore } from "../store/event-store.js";
import { estimateTokens } from "./index.js";

export interface CompactionSummary {
  session_intent: string;
  files_modified: string[];
  key_decisions: string[];
  active_goals: string[];
  next_steps: string;
}

const COMPACTION_PROMPT = `请把以下会话历史压缩为结构化摘要，严格按这五个小节输出（用中文，每节简明）：

## Session Intent
（用户最初的意图与总体目标）
## Files Modified
（被创建/修改的文件列表，每行一个）
## Key Decisions
（已做出的关键技术决定，每行一条）
## Active Goals
（仍在进行中的目标，每行一条）
## Next Steps
（下一步该做什么）

会话历史如下：
`;

/** 确定性清理：供压缩输入使用（不改变事件日志本身） */
export function deterministicCleanup(messages: ChatMessage[]): ChatMessage[] {
  const cleaned: ChatMessage[] = [];
  const latestReadByPath = new Map<string, number>();

  // 第一遍：定位每个 read 工具结果的最后一次出现
  messages.forEach((m, i) => {
    if (m.role === "tool") {
      const path = extractReadPath(m.content);
      if (path) latestReadByPath.set(path, i);
    }
  });

  // 第二遍：旧的重复读取替换为占位；冗长输出截断
  messages.forEach((m, i) => {
    if (m.role === "tool") {
      const path = extractReadPath(m.content);
      if (path && latestReadByPath.get(path) !== i) {
        cleaned.push({ ...m, content: `[早期读取 ${path} 的内容已被后续读取取代，略]` });
        return;
      }
      if (m.content.length > 2000) {
        cleaned.push({ ...m, content: m.content.slice(0, 2000) + "\n…[压缩时截断]" });
        return;
      }
    }
    cleaned.push(m);
  });
  return cleaned;
}

function extractReadPath(content: string): string | null {
  const m = content.match(/^\[(.+?) 共 \d+ 行/);
  return m ? m[1] : null;
}

/** 把消息序列转成压缩提示用的纯文本 */
function messagesToText(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const calls = m.tool_calls?.map((tc) => `调用 ${tc.name}(${JSON.stringify(tc.args).slice(0, 200)})`).join("; ");
      return `[${m.role}] ${m.content}${calls ? `\n${calls}` : ""}`;
    })
    .join("\n\n");
}

/** 解析模型输出为结构化摘要；解析失败时兜底（原文进 next_steps，不丢信息） */
export function parseSummary(text: string): CompactionSummary {
  const section = (name: string): string => {
    const re = new RegExp(`##\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n##|$)`, "i");
    return text.match(re)?.[1]?.trim() ?? "";
  };
  const list = (s: string): string[] =>
    s.split("\n").map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim()).filter(Boolean);

  const files = list(section("Files Modified"));
  const decisions = list(section("Key Decisions"));
  const goals = list(section("Active Goals"));
  const intent = section("Session Intent");
  const next = section("Next Steps");

  if (!intent && !next) {
    // 模型没按模板输出（如 mock）：兜底
    return {
      session_intent: "（压缩时未能解析模型输出，原始摘要见 Next Steps）",
      files_modified: [],
      key_decisions: [],
      active_goals: [],
      next_steps: text.slice(0, 1500),
    };
  }
  return {
    session_intent: intent,
    files_modified: files,
    key_decisions: decisions,
    active_goals: goals,
    next_steps: next,
  };
}

export interface CompactResult {
  summary: CompactionSummary;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * 执行一次压缩：清理 → 模型摘要 → 写 context.compacted 事件。
 * covers_until_seq = 当前最新 seq（边界之后的事件继续参与 fold）。
 */
export async function compactSession(
  store: EventStore,
  sessionId: string,
  turnId: string,
  messages: ChatMessage[],
  adapter: ModelAdapter,
): Promise<CompactResult> {
  const cleaned = deterministicCleanup(messages);
  const tokensBefore = messages.reduce((s, m) => s + estimateTokens(m.content), 0);

  const result = await adapter.streamChat(
    {
      model: "compaction",
      system: "你是会话压缩器。只输出结构化摘要，不要输出其他内容。",
      messages: [{ role: "user", content: COMPACTION_PROMPT + messagesToText(cleaned) }],
      tools: [],
    },
    {},
    new AbortController().signal,
  );

  const summary = parseSummary(result.text);
  const tokensAfter = estimateTokens(JSON.stringify(summary));
  const coversUntilSeq = store.latestSeq(sessionId);

  store.append({
    session_id: sessionId,
    type: "context.compacted",
    actor: "system",
    turn_id: turnId,
    payload: {
      summary,
      covers_until_seq: coversUntilSeq,
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
    },
  });

  return { summary, tokensBefore, tokensAfter };
}
