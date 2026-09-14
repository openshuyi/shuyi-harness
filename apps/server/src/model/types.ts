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

export interface ModelAdapter {
  id: string;
  label: string;
  streamChat(
    req: ChatRequest,
    handlers: StreamHandlers,
    signal: AbortSignal,
  ): Promise<ChatResult>;
}
