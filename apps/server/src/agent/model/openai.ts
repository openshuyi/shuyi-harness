/**
 * OpenAI 兼容协议适配器（流式）。
 * 适用于 OpenAI、DeepSeek 及一切 /chat/completions 兼容端点。
 */
import type {
	ChatRequest,
	ChatResult,
	ChatUsage,
	ModelAdapter,
	StreamHandlers,
} from "./types.js";

export interface OpenAICompatConfig {
	apiKey: string;
	baseURL: string;
	id: string;
	label: string;
	model: string;
}

/** /chat/completions 流式增量块的最小结构（仅声明本适配器用到的字段） */
interface OpenAIStreamChunk {
	choices?: Array<{
		delta?: {
			content?: string;
			reasoning_content?: string;
			tool_calls?: Array<{
				id?: string;
				index?: number;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string;
	}>;
	usage?: {
		completion_tokens?: number;
		prompt_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number };
	};
}

export class OpenAICompatAdapter implements ModelAdapter {
	private readonly config: OpenAICompatConfig;

	constructor(config: OpenAICompatConfig) {
		this.config = config;
	}

	get id(): string {
		return this.config.id;
	}
	get label(): string {
		return this.config.label;
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: 手写 SSE 流解析与 tool_call 增量拼装，1:1 保留经过实战验证的解析逻辑
	async streamChat(
		req: ChatRequest,
		handlers: StreamHandlers,
		signal: AbortSignal
	): Promise<ChatResult> {
		const body = {
			messages: [
				{ content: req.system, role: "system" },
				...req.messages.map((m) => ({
					content: m.content,
					role: m.role,
					...(m.tool_calls
						? {
								tool_calls: m.tool_calls.map((tc) => ({
									function: {
										arguments: JSON.stringify(tc.args),
										name: tc.name,
									},
									id: tc.id,
									type: "function",
								})),
							}
						: {}),
					...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
				})),
			],
			model: this.config.model,
			stream: true,
			stream_options: { include_usage: true },
			...(req.tools.length > 0
				? {
						tools: req.tools.map((t) => ({
							function: {
								description: t.description,
								name: t.name,
								parameters: t.parameters,
							},
							type: "function",
						})),
					}
				: {}),
		};

		const res = await fetch(`${this.config.baseURL}/chat/completions`, {
			body: JSON.stringify(body),
			headers: {
				authorization: `Bearer ${this.config.apiKey}`,
				"content-type": "application/json",
			},
			method: "POST",
			signal,
		});
		if (!res.ok) {
			throw new Error(`模型请求失败 ${res.status}: ${await res.text()}`);
		}
		if (!res.body) {
			throw new Error("模型响应无 body");
		}

		// 解析 SSE 流
		let text = "";
		const toolCalls = new Map<
			number,
			{ id: string; name: string; argsText: string }
		>();
		let finishReason = "stop";
		let usage: ChatUsage = { completion_tokens: 0, prompt_tokens: 0 };

		const decoder = new TextDecoder();
		let buffer = "";
		const reader = res.body.getReader();
		for (;;) {
			// biome-ignore lint/performance/noAwaitInLoops: 流式读取天然逐块顺序处理，不可并行
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data:")) {
					continue;
				}
				const data = trimmed.slice(5).trim();
				if (data === "[DONE]") {
					continue;
				}
				let chunk: OpenAIStreamChunk;
				try {
					chunk = JSON.parse(data) as OpenAIStreamChunk;
				} catch {
					continue;
				}
				if (chunk.usage) {
					usage = {
						cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens,
						completion_tokens: chunk.usage.completion_tokens ?? 0,
						prompt_tokens: chunk.usage.prompt_tokens ?? 0,
					};
				}
				const choice = chunk.choices?.[0];
				if (!choice) {
					continue;
				}
				const { finish_reason } = choice;
				if (finish_reason) {
					finishReason = finish_reason;
				}
				const { delta } = choice;
				if (delta?.content) {
					text += delta.content;
					// biome-ignore lint/performance/noAwaitInLoops: 流式回调按序逐条落库，保证 delta 事件顺序
					await handlers.onTextDelta?.(delta.content);
				}
				if (delta?.reasoning_content) {
					await handlers.onThinkingDelta?.(delta.reasoning_content);
				}
				for (const tc of delta?.tool_calls ?? []) {
					const idx = tc.index ?? 0;
					const acc = toolCalls.get(idx) ?? { argsText: "", id: "", name: "" };
					if (tc.id) {
						acc.id = tc.id;
					}
					if (tc.function?.name) {
						acc.name = tc.function.name;
					}
					if (tc.function?.arguments) {
						acc.argsText += tc.function.arguments;
					}
					toolCalls.set(idx, acc);
				}
			}
		}

		return {
			finishReason,
			text,
			toolCalls: [...toolCalls.values()].map((tc, i) => ({
				args: safeParseArgs(tc.argsText),
				id: tc.id || `call_${i}`,
				name: tc.name,
			})),
			usage,
		};
	}
}

function safeParseArgs(argsText: string): Record<string, unknown> {
	try {
		return JSON.parse(argsText || "{}");
	} catch {
		return { _raw: argsText };
	}
}
