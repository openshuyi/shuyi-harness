/**
 * Mock 适配器：无 API key 时的端到端测试与开发用。
 * 支持脚本化响应队列；队列耗尽后给出回退回复。
 * 同时支持便捷指令（在 fallback 模式下）：
 *   用户消息以 "!write <path> <content>" 开头 → 调用 write 工具
 *   用户消息以 "!read <path>" 开头 → 调用 read 工具
 *   用户消息以 "!bash <command>" 开头 → 调用 bash 工具
 *   用户消息以 "!todowrite 内容[=状态[=优先级]];…" 开头 → 调用 todowrite 工具（M1）
 *   用户消息以 "!todoread" 开头 → 调用 todoread 工具（M1）
 *   用户消息以 "!webfetch <url>" 开头 → 调用 webfetch 工具（M4，需工具已注册）
 *   用户消息以 "!websearch <query>" 开头 → 调用 websearch 工具（M4，需工具已注册）
 */
import { randomUUID } from "node:crypto";
import type {
  ChatRequest,
  ChatResult,
  ModelAdapter,
  ModelMeta,
  StreamHandlers,
} from "./types.js";

export interface MockScriptStep {
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
}

export class MockAdapter implements ModelAdapter {
  id = "mock";
  label = "Mock（脚本化测试模型）";
  meta: ModelMeta = { provider: "local", contextWindow: 128_000 };
  private script: MockScriptStep[] = [];

  pushScript(step: MockScriptStep): void {
    this.script.push(step);
  }

  async streamChat(
    req: ChatRequest,
    handlers: StreamHandlers,
    signal: AbortSignal,
  ): Promise<ChatResult> {
    const step = this.script.shift() ?? this.fallback(req);

    // 模拟流式输出（响应 abort：与真实适配器行为一致——中断流并抛出）
    let text = "";
    for (const ch of step.text ?? "") {
      if (signal.aborted) throw new Error("流式传输被中断（abort）");
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
    // M4：联网工具指令
    if (userText.startsWith("!webfetch ") && has("webfetch")) {
      return { toolCalls: [{ name: "webfetch", args: { url: userText.slice(10).trim() } }] };
    }
    if (userText.startsWith("!websearch ") && has("websearch")) {
      return { toolCalls: [{ name: "websearch", args: { query: userText.slice(11).trim() } }] };
    }
    // P0-3：技能加载指令
    if (userText.startsWith("!skill ") && has("skill")) {
      return { toolCalls: [{ name: "skill", args: { name: userText.slice(7).trim() } }] };
    }
    // P0：提问指令。格式：!question 问题[=选项1|选项2]
    if (userText.startsWith("!question ") && has("question")) {
      const body = userText.slice("!question ".length).trim();
      const [q, optStr] = body.split("=").map((s) => s.trim());
      const options = optStr ? optStr.split("|").map((s) => s.trim()).filter(Boolean) : undefined;
      return { toolCalls: [{ name: "question", args: { question: q, ...(options?.length ? { options } : {}) } }] };
    }
    if (userText.startsWith("!task ") && has("task")) {
      return { toolCalls: [{ name: "task", args: { prompt: userText.slice(6).trim() } }] };
    }
    // M1：任务清单指令。格式：!todowrite 内容[=状态[=优先级]];内容2…
    // 例：!todowrite 实现登录=in_progress=high;编写测试=pending
    if (userText.startsWith("!todowrite ") && has("todowrite")) {
      const body = userText.slice("!todowrite ".length).trim();
      const todos = body
        .split(";")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
          const [content, status, priority] = item.split("=").map((s) => s.trim());
          return {
            content,
            status: (["pending", "in_progress", "completed"].includes(status)
              ? status
              : "pending") as "pending" | "in_progress" | "completed",
            ...(["high", "medium", "low"].includes(priority)
              ? { priority: priority as "high" | "medium" | "low" }
              : {}),
          };
        });
      return { toolCalls: [{ name: "todowrite", args: { todos } }] };
    }
    if (userText.startsWith("!todoread") && has("todoread")) {
      return { toolCalls: [{ name: "todoread", args: {} }] };
    }
    if (userText.startsWith("!memory ") && has("memory_write")) {
      return {
        toolCalls: [
          { name: "memory_write", args: { entry: userText.slice(8).trim(), reason: "用户要求" } },
        ],
      };
    }
    return { text: `Mock 回复：收到「${userText.slice(0, 200)}」。可用 !write/!read/!bash/!task/!memory/!todowrite/!todoread/!webfetch/!websearch 触发工具调用。` };
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
