/**
 * 任务清单工具（v0.3 / M1）：todowrite / todoread。
 * 对应文档：《编码智能体-v0.3设计-能力追赶计划.md》§M1。
 *
 * 语义规则：
 * - todo 列表是会话级状态，由 TodoStore 独立维护（不折进每条消息，
 *   状态变更以 todo.list_updated 事件通知并留痕，回放/重启可恢复）。
 * - 每次 todowrite 为全量覆盖（模型重写整个列表），简化合并逻辑。
 * - 权限级别 always-allow：无副作用，不读写文件系统。
 * - 子代理不继承父 todo 列表（子代理 ToolContext 不注入 todos，见 subagent.ts）。
 */
import { z } from "zod";
import { TodoItem, type AgentEvent } from "@shuyi/types";
import type { ToolDefinition } from "./index.js";

// ---------- 会话级状态容器 ----------
/**
 * 每会话一份 todo 列表。内存缓存 + 可选 restore 回调：
 * 服务端重启后首次访问某会话时，从事件日志取最近一次 todo.list_updated 重建
 * （事件溯源：事件是唯一事实来源，内存只是缓存）。
 */
export class TodoStore {
  private cache = new Map<string, TodoItem[]>();

  constructor(
    /** 缓存未命中时从事件日志重建（返回 undefined 视为空列表） */
    private restore?: (sessionId: string) => TodoItem[] | undefined,
  ) {}

  get(sessionId: string): TodoItem[] {
    let list = this.cache.get(sessionId);
    if (!list) {
      list = this.restore?.(sessionId) ?? [];
      this.cache.set(sessionId, list);
    }
    return list;
  }

  /** 全量覆盖 */
  set(sessionId: string, todos: TodoItem[]): void {
    this.cache.set(sessionId, todos);
  }
}

/** 从事件序列重建某会话的 todo 列表（取最后一次 todo.list_updated） */
export function restoreTodosFromEvents(events: AgentEvent[]): TodoItem[] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "todo.list_updated") {
      const parsed = TodoItem.array().safeParse((e.payload as { todos: unknown }).todos);
      return parsed.success ? parsed.data : undefined;
    }
  }
  return undefined;
}

// ---------- 排序：in_progress > pending > completed（同级保持原有顺序） ----------
const STATUS_ORDER: Record<TodoItem["status"], number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

export function sortTodos(todos: TodoItem[]): TodoItem[] {
  return todos
    .map((t, i) => ({ t, i }))
    .sort((a, b) => STATUS_ORDER[a.t.status] - STATUS_ORDER[b.t.status] || a.i - b.i)
    .map(({ t }) => t);
}

// ---------- 渲染 ----------
const STATUS_ICON: Record<TodoItem["status"], string> = {
  in_progress: "◐",
  pending: "○",
  completed: "●",
};

function formatLine(t: TodoItem): string {
  const pri = t.priority ? `（${t.priority}）` : "";
  return `${STATUS_ICON[t.status]} [${t.status}] ${t.content}${pri}`;
}

/** todoread 的输出文本 */
export function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return "(任务清单为空)";
  const sorted = sortTodos(todos);
  const done = todos.filter((t) => t.status === "completed").length;
  const lines = sorted.map(formatLine).join("\n");
  return `任务清单（${done}/${todos.length} 已完成）：\n${lines}`;
}

/** 注入上限：清单最多注入 30 项，超出提示模型精简 */
export const TODO_INJECT_LIMIT = 30;

/**
 * 每个 loop 迭代开始时注入 system 的附录。
 * 列表为空时返回空串（不注入）；因附录来自 TodoStore 而非事件 fold，
 * compaction 后依然保留（M1 验收：compaction 保留）。
 */
export function formatTodoAppendix(todos: TodoItem[]): string {
  if (todos.length === 0) return "";
  const sorted = sortTodos(todos);
  const shown = sorted.slice(0, TODO_INJECT_LIMIT);
  const overflow = sorted.length - shown.length;
  const lines = [
    "## 任务清单（todowrite 全量覆盖更新；completed 的项可适时清理）",
    ...shown.map(formatLine),
  ];
  if (overflow > 0) {
    lines.push(`…另有 ${overflow} 项未显示。清单过长，请用 todowrite 精简（移除已完成/过期项）。`);
  }
  return lines.join("\n");
}

// ---------- 工具定义 ----------
export const todowriteTool: ToolDefinition = {
  name: "todowrite",
  description:
    "全量覆盖当前会话的任务清单。多步任务开始时写入计划，每完成一步就更新状态（pending/in_progress/completed，可选 priority: high/medium/low）。",
  permission: "always-allow",
  argsSchema: z.object({
    todos: z.array(TodoItem).describe("完整任务清单（全量覆盖，非增量合并）"),
  }),
  async execute(args, ctx) {
    if (!ctx.todos) throw new Error("任务清单不可用（当前上下文不支持，如子代理）");
    const todos = args.todos as TodoItem[];
    ctx.todos.write(todos);
    return {
      result: `任务清单已更新（${todos.length} 项）。\n${formatTodoList(todos)}`,
      truncated: false,
    };
  },
};

export const todoreadTool: ToolDefinition = {
  name: "todoread",
  description: "读取当前会话的任务清单（按 in_progress > pending > completed 排序）。",
  permission: "always-allow",
  argsSchema: z.object({}),
  async execute(_args, ctx) {
    if (!ctx.todos) throw new Error("任务清单不可用（当前上下文不支持，如子代理）");
    return { result: formatTodoList(ctx.todos.read()), truncated: false };
  },
};
