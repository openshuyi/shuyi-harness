/**
 * 内存事件总线（事件挂钩）。
 * EventStore.append 提交后同步发布；SSE 是当前唯一订阅者。
 * 团队版将在此追加审计订阅者，核心不动。
 */
import type { AgentEvent } from "@shuyi/types";

export type EventListener = (event: AgentEvent) => void;

export class EventBus {
  private listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
