/**
 * OpenAI 兼容协议适配器（流式）。
 * 适用于 OpenAI、DeepSeek 及一切 /chat/completions 兼容端点。
 * 含失败重试（429/5xx 指数退避）与流式中断恢复。
 */
import type {
	ChatRequest,
	ChatResult,
	ChatUsage,
	ModelAdapter,
	ModelMeta,
	ModelPricing,
	StreamHandlers,
} from "./types.js";

export interface OpenAICompatConfig {
	apiKey: string;
	baseURL: string;
	contextWindow?: number;
	id: string;
	label: string;
	model: string;
	pricing?: ModelPricing;
}

/** 可重试的 HTTP 状态码：限流与服务端错误 */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

/** OpenAI SSE 分块的宽松形状（字段按需可选，缺失走默认值） */
interface OpenAIStreamChunk {
	choices?: {
		delta?: {
			content?: string;
			reasoning_content?: string;
			tool_calls?: {
				function?: { arguments?: string; name?: string };
				id?: string;
				index?: number;
			}[];
		};
		finish_reason?: string;
	}[];
	usage?: {
		completion_tokens?: number;
		prompt_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number };
	};
}

export class ModelRequestError extends Error {
	readonly status: number | null;
	readonly retryable: boolean;

	constructor(status: number | null, message: string, retryable: boolean) {
		super(message);
		this.status = status;
		this.retryable = retryable;
	}
}

export class OpenAICompatAdapter implements ModelAdapter {
	readonly meta: ModelMeta;
	readonly config: OpenAICompatConfig;

	constructor(config: OpenAICompatConfig) {
		this.config = config;
		this.meta = {
			contextWindow: config.contextWindow ?? 128_000,
			pricing: config.pricing,
			provider: "openai-compatible",
		};
	}

	get id(): string {
		return this.config.id;
	}
	get label(): string {
		return this.config.label;
	}

	async streamChat(
		req: ChatRequest,
		handlers: StreamHandlers,
		signal: AbortSignal
	): Promise<ChatResult> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
			if (signal.aborted) {
				throw new DOMException("Aborted", "AbortError");
			}
			try {
				// biome-ignore lint/performance/noAwaitInLoops: 重试必须顺序进行（指数退避），不可并行
				return await this.attemptStream(req, handlers, signal);
			} catch (err) {
				lastError = err;
				if (
					signal.aborted ||
					(err instanceof DOMException && err.name === "AbortError")
				) {
					throw err;
				}
				const retryable =
					err instanceof ModelRequestError ? err.retryable : true; // 网络错误默认可重试
				if (!retryable || attempt === MAX_ATTEMPTS) {
					throw err;
				}
				const backoff = Math.min(2 ** attempt * 500, 8000);
				console.warn(
					`[model:${this.id}] 第 ${attempt} 次调用失败（${err instanceof Error ? err.message : String(err)}），${backoff}ms 后重试`
				);
				await new Promise((r) => setTimeout(r, backoff));
			}
		}
		throw lastError;
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: SSE 流式解析与工具调用累积，平移自 v0.x 成熟实现，保持 1:1
	private async attemptStream(
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
			const bodyText = await res.text().catch(() => "");
			throw new ModelRequestError(
				res.status,
				`模型请求失败 ${res.status}: ${bodyText.slice(0, 500)}`,
				RETRYABLE_STATUS.has(res.status)
			);
		}
		if (!res.body) {
			throw new ModelRequestError(null, "模型响应无 body", true);
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
			const { done, value } = await reader.read().catch((err) => {
				// 流式传输中途断开（网络抖动/对端 RST）：视为可重试错误，
				// 由外层按 attempt 重发完整请求（OpenAI 协议无断点续传）
				if (signal.aborted) {
					throw err;
				}
				throw new ModelRequestError(
					null,
					`流式响应中断: ${err instanceof Error ? err.message : String(err)}`,
					true
				);
			});
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
					chunk = JSON.parse(data);
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
				if (choice.finish_reason) {
					finishReason = choice.finish_reason;
				}
				const { delta } = choice;
				if (delta?.content) {
					text += delta.content;
					// biome-ignore lint/performance/noAwaitInLoops: 流式回调天然逐块顺序处理，不可并行
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
