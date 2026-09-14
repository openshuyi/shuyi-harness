/**
 * 模型适配层：统一的消息/工具调用/流式抽象。
 * Loop 只依赖此接口，不知道自己在跟哪个模型说话（叶子接缝，可替换）。
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id: string; name: string; args: Record<string, unknown> }[];
  tool_call_id?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens?: number;
}

export interface ChatResult {
  text: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  finishReason: string;
  usage: ChatUsage;
}

export interface StreamHandlers {
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
}

/** 模型元数据：上下文窗口与定价（美元 / 百万 token），用于压缩阈值与成本估算 */
export interface ModelPricing {
  /** 输入价，美元/百万 token */
  input: number;
  /** 输出价，美元/百万 token */
  output: number;
  /** 缓存命中输入价（可选，如 DeepSeek 缓存命中更便宜） */
  cachedInput?: number;
}

export interface ModelMeta {
  provider: string;
  contextWindow: number;
  pricing?: ModelPricing;
}

export interface ModelAdapter {
  id: string;
  label: string;
  /** v0.3 新增：provider/上下文窗口/定价元数据（mock 可无定价） */
  meta: ModelMeta;
  streamChat(
    req: ChatRequest,
    handlers: StreamHandlers,
    signal: AbortSignal,
  ): Promise<ChatResult>;
}

/** 按 token 用量与定价计算一次调用的美元成本 */
export function estimateCost(usage: ChatUsage, pricing?: ModelPricing): number | undefined {
  if (!pricing) return undefined;
  const cached = usage.cached_tokens ?? 0;
  const fresh = Math.max(0, usage.prompt_tokens - cached);
  const inputCost =
    (fresh / 1_000_000) * pricing.input +
    (cached / 1_000_000) * (pricing.cachedInput ?? pricing.input);
  return inputCost + (usage.completion_tokens / 1_000_000) * pricing.output;
}
