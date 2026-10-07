/**
 * Mock 适配器：无 API key 时的端到端测试与开发用。
 * 支持脚本化响应队列；队列耗尽后给出回退回复。
 * 同时支持便捷指令（在 fallback 模式下）：
 *   用户消息以 "!write <path> <content>" 开头 → 调用 write 工具
 *   用户消息以 "!read <path>" 开头 → 调用 read 工具
 *   用户消息以 "!bash <command>" 开头 → 调用 bash 工具
 */
import { randomUUID } from "node:crypto";
import type {
  ChatRequest,
  ChatResult,
  ModelAdapter,
  StreamHandlers,
} from "./types.js";

export interface MockScriptStep {
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
}

export class MockAdapter implements ModelAdapter {
  id = "mock";
  label = "Mock（脚本化测试模型）";
  private script: MockScriptStep[] = [];

  pushScript(step: MockScriptStep): void {
    this.script.push(step);
  }

  async streamChat(
    req: ChatRequest,
    handlers: StreamHandlers,
    signal: AbortSignal,
  ): Promise<ChatResult> {
    void signal;
    const step = this.script.shift() ?? this.fallback(req);

    // 模拟流式输出
    let text = "";
    for (const ch of step.text ?? "") {
      if (handlers.onTextDelta) {
        text += ch;
        handlers.onTextDelta(ch);
        await new Promise((r) => setTimeout(r, 2));
      } else {
        text += ch;
      }
    }

    return {
      text,
      toolCalls: (step.toolCalls ?? []).map((tc) => ({
        id: `mock_${randomUUID()}`,
        name: tc.name,
        args: tc.args,
      })),
      finishReason: step.toolCalls?.length ? "tool_calls" : "stop",
      usage: {
        prompt_tokens: estimateTokens(req.system) + req.messages.length * 20,
        completion_tokens: Math.ceil(text.length / 4),
      },
    };
  }

  private fallback(req: ChatRequest): MockScriptStep {
    const last = req.messages[req.messages.length - 1];
    // 工具结果回来了 → 结束轮次
    if (last?.role === "tool") {
      return { text: "工具已执行完毕，结果如上。还有什么可以帮你？" };
    }
    const userText = last?.content ?? "";
    const visible = new Set(req.tools.map((t) => t.name));
    const has = (name: string) => visible.size === 0 || visible.has(name);

    if (userText.startsWith("!write ") && has("write")) {
      const [, p, ...rest] = userText.split(" ");
      return { toolCalls: [{ name: "write", args: { path: p, content: rest.join(" ") } }] };
    }
    if (userText.startsWith("!read ") && has("read")) {
      return { toolCalls: [{ name: "read", args: { path: userText.slice(6).trim() } }] };
    }
    if (userText.startsWith("!bash ") && has("bash")) {
      return { toolCalls: [{ name: "bash", args: { command: userText.slice(6).trim() } }] };
    }
    if (userText.startsWith("!task ") && has("task")) {
      return { toolCalls: [{ name: "task", args: { prompt: userText.slice(6).trim() } }] };
    }
    if (userText.startsWith("!memory ") && has("memory_write")) {
      return {
        toolCalls: [
          { name: "memory_write", args: { entry: userText.slice(8).trim(), reason: "用户要求" } },
        ],
      };
    }
    return { text: `Mock 回复：收到「${userText.slice(0, 200)}」。可用 !write/!read/!bash/!task/!memory 触发工具调用。` };
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
