/**
 * 内存事件总线（事件挂钩）。
 * EventStore.append 提交后同步发布；SSE 是当前唯一订阅者。
 * 团队版将在此追加审计订阅者，核心不动。
 */
import type { AgentEvent } from "@shuyi/types";

export type EventListener = (event: AgentEvent) => void;

export class EventBus {
  private listeners = new Set<EventListener>();

  /**
   * 订阅事件；M5：可选 sessionId 过滤（聚合 SSE 流按会话分派的基础）。
   * 传 Set<string> 可订阅多个会话。
   */
  subscribe(listener: EventListener, sessionId?: string | Set<string>): () => void {
    const wrapped: EventListener = sessionId
      ? (e) => {
          if (typeof sessionId === "string" ? e.session_id === sessionId : sessionId.has(e.session_id)) {
            listener(e);
          }
        }
      : listener;
    this.listeners.add(wrapped);
    return () => this.listeners.delete(wrapped);
  }

  publish(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // 订阅者故障不允许影响写入路径
        console.error("[bus] listener error:", err);
      }
    }
  }
}
