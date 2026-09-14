/**
 * SSE 客户端：订阅会话事件流，断线自动以 after_seq 续传。
 * 零框架依赖；事件交给调用方（reducer）。
 */
import type { AgentEvent } from "@shuyi/types";

export class SessionEventSource {
  private es: EventSource | null = null;
  private lastSeq = -1;
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private sessionId: string,
    private onEvent: (e: AgentEvent) => void,
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const url = `/api/sessions/${this.sessionId}/events?after_seq=${this.lastSeq}`;
    const es = new EventSource(url);
    this.es = es;

    es.onmessage = (msg) => {
      try {
        const e = JSON.parse(msg.data) as AgentEvent;
        if (e.seq > this.lastSeq) this.lastSeq = e.seq;
        this.onEvent(e);
      } catch {
        // ping 等非 JSON 帧忽略
      }
    };

    es.onerror = () => {
      es.close();
      if (!this.closed) {
        // 1.5s 后带最新 after_seq 重连（服务端先补缺口再转实时）
        this.retryTimer = setTimeout(() => this.connect(), 1500);
      }
    };
  }

  stop(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.es?.close();
    this.es = null;
  }
}
