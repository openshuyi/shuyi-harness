/**
 * 模型适配层：统一的消息/工具调用/流式抽象。
 * Loop 只依赖此接口，不知道自己在跟哪个模型说话（叶子接缝，可替换）。
 */

export interface ChatMessage {
	content: string;
	role: "system" | "user" | "assistant" | "tool";
	tool_call_id?: string;
	tool_calls?: { id: string; name: string; args: Record<string, unknown> }[];
}

export interface ToolSpec {
	description: string;
	name: string;
	parameters: Record<string, unknown>;
}

export interface ChatRequest {
	messages: ChatMessage[];
	model: string;
	system: string;
	tools: ToolSpec[];
}

export interface ChatUsage {
	cached_tokens?: number;
	completion_tokens: number;
	prompt_tokens: number;
}

export interface ChatResult {
	finishReason: string;
	text: string;
	toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
	usage: ChatUsage;
}

export interface StreamHandlers {
	onTextDelta?: (delta: string) => void | Promise<void>;
	onThinkingDelta?: (delta: string) => void | Promise<void>;
}

export interface ModelAdapter {
	id: string;
	label: string;
	streamChat: (
		req: ChatRequest,
		handlers: StreamHandlers,
		signal: AbortSignal
	) => Promise<ChatResult>;
}
