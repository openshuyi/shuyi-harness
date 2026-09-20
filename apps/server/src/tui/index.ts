/**
 * P1-7：TUI 终端客户端——同一服务端的投影（架构原则：所有入口共享服务端语义）。
 *
 * 不是内嵌 Loop：通过 HTTP API + SSE 事件流与常驻服务端通信，
 * 与 Web SPA 并列的第二个客户端。零依赖（readline + ANSI）。
 *
 * 能力：会话选择/新建、消息收发（流式渲染）、工具进度、审批问答（y/a/n）、
 * question 作答、/mode /abort /sessions /use /new /quit 内建命令。
 *
 * 入口：agent-bin --tui [--server http://localhost:4291] [--cwd /path]
 */
import type { AgentEvent, SessionRecord } from "@shuyi/types";

// ---------- ANSI ----------
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
} as const;

export interface TuiIo {
  write(s: string): void;
  /** 用户输入行回调（readline 投影；测试注入脚本化行） */
  onLine(cb: (line: string) => void): void;
}

export interface TuiDeps {
  baseUrl: string;
  cwd: string;
  io: TuiIo;
  fetchFn?: typeof fetch;
  /** SSE 覆盖（测试用）；默认走 /api/sessions/:id/events 流 */
  eventsFn?: (sessionId: string, signal: AbortSignal) => AsyncIterable<AgentEvent>;
}

interface PendingAsk {
  approvalId: string;
  tool: string;
  options: string[];
}

/** 解析 SSE 流为事件序列（data: {json}\n\n 帧） */
async function* sseEvents(
  baseUrl: string,
  sessionId: string,
  signal: AbortSignal,
  fetchFn: typeof fetch,
): AsyncIterable<AgentEvent> {
  const res = await fetchFn(`${baseUrl}/api/sessions/${sessionId}/events`, { signal });
  if (!res.ok || !res.body) throw new Error(`事件流连接失败 HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      try {
        yield JSON.parse(dataLine.slice(5)) as AgentEvent;
      } catch {
        // 无法解析的帧跳过
      }
    }
  }
}

export class TuiApp {
  private session: SessionRecord | null = null;
  private pendingAsk: PendingAsk | null = null;
  private streaming = false;
  private eventAbort: AbortController | null = null;
  private stopped = false;

  constructor(private deps: TuiDeps) {}

  private out(s: string): void {
    this.deps.io.write(s);
  }

  private line(s = ""): void {
    this.deps.io.write(`${s}\n`);
  }

  private get fetchFn(): typeof fetch {
    return this.deps.fetchFn ?? fetch;
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    // 瞬时连接错误（如 SSE 长连接并发下的 ECONNRESET 竞态）自动重试一次
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetchFn(`${this.deps.baseUrl}${path}`, init);
        if (!res.ok) throw new Error(`HTTP ${res.status}（${path}）`);
        return (await res.json()) as T;
      } catch (err) {
        lastErr = err;
        const transient = err instanceof Error && /ECONNRESET|socket|connection/i.test(err.message);
        if (!transient) throw err;
        await new Promise((r) => setTimeout(r, 80));
      }
    }
    throw lastErr;
  }

  /** 启动：选会话 → 订阅事件流 → 进入输入循环。 */
  async run(): Promise<void> {
    const sessions = await this.api<SessionRecord[]>("/api/sessions");
    const active = sessions.filter((s) => !s.archived && s.cwd === this.deps.cwd);
    if (active.length > 0) {
      this.session = active[0];
      this.line(`${C.dim}复用会话：${this.session.title}（${this.session.session_id.slice(0, 8)}）${C.reset}`);
    } else {
      await this.createSession();
    }
    this.line(`${C.bold}${C.cyan} shuyi tui${C.reset} ${C.dim}— ${this.deps.baseUrl} · ${this.deps.cwd}${C.reset}`);
    this.line(`${C.dim}输入消息与 agent 对话；/mode 切换模式，/sessions 会话列表，/abort 中断，/quit 退出${C.reset}`);
    this.prompt();
    this.deps.io.onLine((line) => {
      this.onInput(line.trimEnd()).catch((err) => {
        this.line(`${C.red}[内部错误] ${err instanceof Error ? err.message : String(err)}${C.reset}`);
        this.prompt();
      });
    });
  }

  private prompt(): void {
    const mode = this.session?.mode ?? "build";
    this.out(`${C.green}${mode}${C.reset} ${C.dim}›${C.reset} `);
  }

  private async createSession(): Promise<void> {
    this.session = await this.api<SessionRecord>("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: this.deps.cwd }),
    });
    this.line(`${C.dim}新会话：${this.session.session_id.slice(0, 8)}${C.reset}`);
  }

  /** 切换会话：重订事件流（旧流中止） */
  private async subscribeEvents(): Promise<void> {
    this.eventAbort?.abort();
    if (!this.session) return;
    const sid = this.session.session_id;
    this.eventAbort = new AbortController();
    const eventsFn =
      this.deps.eventsFn ??
      ((sessionId: string, signal: AbortSignal) =>
        sseEvents(this.deps.baseUrl, sessionId, signal, this.fetchFn));
    try {
      for await (const e of eventsFn(sid, this.eventAbort.signal)) {
        if (this.stopped) return;
        this.onEvent(e);
      }
    } catch (err) {
      if (!this.stopped && !(err instanceof Error && err.name === "AbortError")) {
        this.line(`${C.red}[事件流断开] ${err instanceof Error ? err.message : String(err)}${C.reset}`);
      }
    }
  }

  private onEvent(e: AgentEvent): void {
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case "message.assistant.delta":
        this.streaming = true;
        this.out(String(p.text_delta ?? ""));
        break;
      case "message.assistant.completed":
        if (this.streaming) {
          this.line();
          this.streaming = false;
        }
        break;
      case "tool.call.proposed":
        if (this.streaming) {
          this.line();
          this.streaming = false;
        }
        this.line(`${C.yellow}⚙ ${p.tool}${C.reset} ${C.dim}${JSON.stringify(p.args).slice(0, 120)}${C.reset}`);
        break;
      case "tool.call.completed":
        this.line(`${C.dim}  └ 完成 ${p.duration_ms}ms${C.reset}`);
        break;
      case "tool.call.failed":
        this.line(`${C.red}  └ 失败：${String(p.error).slice(0, 200)}${C.reset}`);
        break;
      case "approval.requested": {
        const options = (p.args as { options?: string[] }).options ?? [];
        this.pendingAsk = {
          approvalId: p.approval_id as string,
          tool: p.tool as string,
          options,
        };
        if (p.tool === "question") {
          this.line(`${C.magenta}💬 模型提问：${(p.args as { question?: string }).question}${C.reset}`);
          options.forEach((o, i) => this.line(`   ${C.cyan}${i + 1}${C.reset}) ${o}`));
          this.line(`${C.dim}输入编号或自由作答；输入 n 拒绝回答${C.reset}`);
        } else {
          this.line(`${C.yellow}🔐 审批：${p.risk_summary}${C.reset}`);
          this.line(`${C.dim}y=允许一次 a=本会话总是允许 n=拒绝${C.reset}`);
        }
        break;
      }
      case "turn.completed": {
        const usage = p.usage as { prompt_tokens: number; completion_tokens: number };
        const cost = p.cost_estimate as number | undefined;
        this.line(
          `${C.dim}— 轮次完成 · tokens ${usage.prompt_tokens}+${usage.completion_tokens}${cost != null ? ` · $${cost.toFixed(4)}` : ""}${C.reset}`,
        );
        this.prompt();
        break;
      }
      case "turn.aborted":
        this.line(`${C.dim}— 已中断（${p.reason}）${C.reset}`);
        this.prompt();
        break;
      case "error.occurred":
        this.line(`${C.red}[错误] ${p.message}${C.reset}`);
        break;
      default:
        break;
    }
  }

  private async onInput(line: string): Promise<void> {
    if (!line) {
      this.prompt();
      return;
    }
    // 审批/问答挂起中：输入优先解释为审批应答
    if (this.pendingAsk) {
      await this.answerPending(line);
      return;
    }
    if (line.startsWith("/")) {
      await this.onCommand(line);
      return;
    }
    if (!this.session) return;
    try {
      await this.api(`/api/sessions/${this.session.session_id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: line }),
      });
    } catch (err) {
      this.line(`${C.red}[发送失败] ${err instanceof Error ? err.message : String(err)}${C.reset}`);
      this.prompt();
    }
  }

  private async answerPending(line: string): Promise<void> {
    const ask = this.pendingAsk;
    this.pendingAsk = null;
    if (!ask || !this.session) return;
    const resolve = async (body: Record<string, unknown>) => {
      await this.api(`/api/sessions/${this.session!.session_id}/approvals/${ask.approvalId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch((err) =>
        this.line(`${C.red}[审批提交失败] ${err instanceof Error ? err.message : String(err)}${C.reset}`),
      );
    };
    if (ask.tool === "question") {
      if (/^n$/i.test(line)) {
        await resolve({ decision: "deny", deny_reason: "用户拒绝回答" });
      } else {
        const idx = Number(line);
        const answer =
          Number.isInteger(idx) && idx >= 1 && idx <= ask.options.length ? ask.options[idx - 1] : line;
        await resolve({ decision: "approve", answer });
      }
      return;
    }
    if (/^y$/i.test(line)) await resolve({ decision: "approve" });
    else if (/^a$/i.test(line)) await resolve({ decision: "approve", remember_rule: "allow" });
    else await resolve({ decision: "deny", deny_reason: `用户拒绝（${line || "n"}）` });
  }

  private async onCommand(line: string): Promise<void> {
    const [cmd, ...rest] = line.split(/\s+/);
    switch (cmd) {
      case "/quit":
      case "/exit":
        this.stopped = true;
        this.eventAbort?.abort();
        this.line(`${C.dim}再见。${C.reset}`);
        break;
      case "/abort":
        if (this.session) {
          await this.api(`/api/sessions/${this.session.session_id}/abort`, { method: "POST" }).catch(() => {});
        }
        break;
      case "/mode": {
        const mode = rest[0] === "plan" ? "plan" : "build";
        if (!this.session) return;
        await this.api(`/api/sessions/${this.session.session_id}/config`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        this.session = { ...this.session, mode };
        this.line(`${C.dim}已切换到 ${mode} 模式${C.reset}`);
        this.prompt();
        break;
      }
      case "/sessions": {
        const list = await this.api<SessionRecord[]>("/api/sessions");
        list
          .filter((s) => !s.archived)
          .forEach((s, i) => {
            const mark = s.session_id === this.session?.session_id ? `${C.green}*${C.reset}` : " ";
            this.line(`${mark} ${C.cyan}${i}${C.reset} ${s.title} ${C.dim}${s.mode}·${s.model}·${s.status}${C.reset}`);
          });
        this.prompt();
        break;
      }
      case "/use": {
        const list = await this.api<SessionRecord[]>("/api/sessions");
        const target = list.filter((s) => !s.archived)[Number(rest[0])];
        if (!target) {
          this.line(`${C.red}无效序号（/sessions 查看列表）${C.reset}`);
        } else {
          this.session = target;
          this.line(`${C.dim}切换到：${target.title}${C.reset}`);
          void this.subscribeEvents();
        }
        this.prompt();
        break;
      }
      case "/new":
        await this.createSession();
        void this.subscribeEvents();
        this.prompt();
        break;
      default:
        this.line(`${C.dim}未知命令 ${cmd}（/mode /sessions /use /new /abort /quit）${C.reset}`);
        this.prompt();
    }
  }

  /** 启动后调用：开始消费事件流（与输入循环并行）。 */
  startEventLoop(): void {
    void this.subscribeEvents();
  }

  /** 停止：中断事件流与输入循环（测试/退出时调用）。 */
  stop(): void {
    this.stopped = true;
    this.eventAbort?.abort();
  }
}
