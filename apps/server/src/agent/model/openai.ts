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
  id: string;
  label: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

export class OpenAICompatAdapter implements ModelAdapter {
  constructor(public config: OpenAICompatConfig) {}

  get id(): string {
    return this.config.id;
  }
  get label(): string {
    return this.config.label;
  }

  async streamChat(
    req: ChatRequest,
    handlers: StreamHandlers,
    signal: AbortSignal,
  ): Promise<ChatResult> {
    const body = {
      model: this.config.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: req.system },
        ...req.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.tool_calls
            ? {
                tool_calls: m.tool_calls.map((tc) => ({
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                })),
              }
            : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        })),
      ],
      ...(req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    };

    const res = await fetch(`${this.config.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      throw new Error(`模型请求失败 ${res.status}: ${await res.text()}`);
    }
    if (!res.body) throw new Error("模型响应无 body");

    // 解析 SSE 流
    let text = "";
    const toolCalls = new Map<number, { id: string; name: string; argsText: string }>();
    let finishReason = "stop";
    let usage: ChatUsage = { prompt_tokens: 0, completion_tokens: 0 };

    const decoder = new TextDecoder();
    let buffer = "";
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.usage) {
          usage = {
            prompt_tokens: chunk.usage.prompt_tokens ?? 0,
            completion_tokens: chunk.usage.completion_tokens ?? 0,
            cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens,
          };
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (delta?.content) {
          text += delta.content;
          handlers.onTextDelta?.(delta.content);
        }
        if (delta?.reasoning_content) {
          handlers.onThinkingDelta?.(delta.reasoning_content);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const acc = toolCalls.get(idx) ?? { id: "", name: "", argsText: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.argsText += tc.function.arguments;
          toolCalls.set(idx, acc);
        }
      }
    }

    return {
      text,
      toolCalls: [...toolCalls.values()].map((tc, i) => ({
        id: tc.id || `call_${i}`,
        name: tc.name,
        args: safeParseArgs(tc.argsText),
      })),
      finishReason,
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
