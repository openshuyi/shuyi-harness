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

/**
 * M5：聚合事件流客户端（GET /api/events?sessions=a,b,c）。
 * 实时通知用（不补发缺口）；会话面板的全量轨迹仍走单会话流。
 * sessions 为 null 表示订阅全部会话；集合变化时重连。
 */
export class AggregateEventSource {
  private es: EventSource | null = null;
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private currentKey = "";

  constructor(private onEvent: (e: AgentEvent) => void) {}

  /** 更新订阅集合（null = 全部）；集合变化时自动重连 */
  update(sessions: string[] | null): void {
    const key = sessions === null ? "*" : [...sessions].sort().join(",");
    if (key === this.currentKey && this.es) return;
    this.currentKey = key;
    this.es?.close();
    this.connect();
  }

  start(sessions: string[] | null): void {
    this.closed = false;
    this.update(sessions);
  }

  private connect(): void {
    if (this.closed || !this.currentKey) return;
    const url =
      this.currentKey === "*" ? "/api/events" : `/api/events?sessions=${encodeURIComponent(this.currentKey)}`;
    const es = new EventSource(url);
    this.es = es;

    es.onmessage = (msg) => {
      try {
        this.onEvent(JSON.parse(msg.data) as AgentEvent);
      } catch {
        // ping 等非 JSON 帧忽略
      }
    };

    es.onerror = () => {
      es.close();
      if (!this.closed) {
        const key = this.currentKey;
        this.currentKey = ""; // 强制 update 重连
        this.retryTimer = setTimeout(() => {
          this.currentKey = "";
          this.update(key === "*" ? null : key.split(","));
        }, 1500);
      }
    };
  }

  stop(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.es?.close();
    this.es = null;
    this.currentKey = "";
  }
}
