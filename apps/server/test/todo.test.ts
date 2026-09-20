/**
 * M1 任务清单工具（todowrite / todoread）测试。
 * 对应文档：《编码智能体-v0.3设计-能力追赶计划.md》§M1 验收：
 * - 单元：全量覆盖语义、排序规则、compaction 保留
 * - e2e：!todowrite 后清单（事件）出现并随 !todoread 返回正确数据
 * 另覆盖设计总则：权限 always-allow（fail-closed 下的显式声明）、
 * 事件模型只增不改（todo.list_updated 纯追加）、重启后从事件日志恢复（本地优先）。
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentEvent, SessionRecord, TodoItem } from "@shuyi/types";
import { EventBus } from "../src/bus/index.js";
import { SqliteEventStore } from "../src/store/event-store.js";
import { createDefaultRegistry, type ToolContext } from "../src/tools/index.js";
import {
  TodoStore,
  restoreTodosFromEvents,
  sortTodos,
  formatTodoList,
  formatTodoAppendix,
  TODO_INJECT_LIMIT,
} from "../src/tools/todo.js";
import { PermissionService } from "../src/permission/index.js";
import { RuntimeModelRegistry } from "../src/model/registry.js";
import type { MockAdapter } from "../src/model/mock.js";
import { SessionManager } from "../src/session/manager.js";
import { rebuildContext } from "../src/context/index.js";

const item = (
  content: string,
  status: TodoItem["status"] = "pending",
  priority?: TodoItem["priority"],
): TodoItem => ({ content, status, ...(priority ? { priority } : {}) });

// ---------- 单元：语义与渲染 ----------
describe("M1 单元：todo 工具语义", () => {
  function makeCtx(sessionId = "s1") {
    const store = new TodoStore();
    const written: TodoItem[][] = [];
    const ctx: ToolContext = {
      sessionId,
      cwd: "/tmp",
      todos: {
        read: () => store.get(sessionId),
        write: (t) => {
          store.set(sessionId, t);
          written.push(t);
        },
      },
    };
    const tools = createDefaultRegistry();
    return { store, written, ctx, tools };
  }

  test("todowrite 全量覆盖：第二次调用完全替换列表", async () => {
    const { ctx, tools } = makeCtx();
    const tw = tools.get("todowrite")!;
    await tw.execute({ todos: [item("A"), item("B")] }, ctx);
    const second = await tw.execute({ todos: [item("C", "in_progress")] }, ctx);
    expect(second.result).toContain("（1 项）");
    const read = await tools.get("todoread")!.execute({}, ctx);
    expect(read.result).toContain("C");
    expect(read.result).not.toContain("A");
    expect(read.result).not.toContain("B");
  });

  test("todoread 排序：in_progress > pending > completed（同级稳定）", async () => {
    const { ctx, tools } = makeCtx();
    await tools.get("todowrite")!.execute(
      {
        todos: [
          item("已完成1", "completed"),
          item("待办1", "pending"),
          item("进行中1", "in_progress"),
          item("待办2", "pending"),
          item("进行中2", "in_progress"),
        ],
      },
      ctx,
    );
    const read = await tools.get("todoread")!.execute({}, ctx);
    const lines = read.result.split("\n").slice(1);
    expect(lines.map((l) => l.replace(/^[◐○●] \[[a-z_]+\] /, "").replace(/（.+）$/, ""))).toEqual([
      "进行中1",
      "进行中2",
      "待办1",
      "待办2",
      "已完成1",
    ]);
    expect(read.result).toContain("1/5 已完成");
  });

  test("sortTodos 不修改原数组且同级保持原顺序", () => {
    const input = [item("x", "pending"), item("y", "in_progress"), item("z", "pending")];
    const sorted = sortTodos(input);
    expect(sorted.map((t) => t.content)).toEqual(["y", "x", "z"]);
    expect(input.map((t) => t.content)).toEqual(["x", "y", "z"]); // 原数组不变
  });

  test("formatTodoList：空列表与完成度统计", () => {
    expect(formatTodoList([])).toBe("(任务清单为空)");
    expect(formatTodoList([item("a", "completed"), item("b")])).toContain("1/2 已完成");
  });

  test("system 附录：空列表不注入；超过 30 项截断并提示精简", () => {
    expect(formatTodoAppendix([])).toBe("");
    const within = formatTodoAppendix([item("任务一", "in_progress", "high")]);
    expect(within).toContain("## 任务清单");
    expect(within).toContain("任务一");
    expect(within).toContain("high");

    const many = Array.from({ length: TODO_INJECT_LIMIT + 5 }, (_, i) => item(`任务${i}`));
    const appendix = formatTodoAppendix(many);
    expect(appendix).toContain(`任务${TODO_INJECT_LIMIT - 1}`);
    expect(appendix).not.toContain(`任务${TODO_INJECT_LIMIT}`);
    expect(appendix).toContain("另有 5 项未显示");
    expect(appendix).toContain("精简");
  });

  test("权限：todowrite/todoread 为 always-allow，plan 模式下也放行", () => {
    const tools = createDefaultRegistry();
    const perm = new PermissionService();
    for (const name of ["todowrite", "todoread"]) {
      const tool = tools.get(name)!;
      expect(tool.permission).toBe("always-allow");
      const verdict = perm.classify({
        tool,
        args: name === "todowrite" ? { todos: [] } : {},
        cwd: "/tmp",
        sandboxLevel: "workspace",
        mode: "plan",
      });
      expect(verdict.kind).toBe("allow");
    }
    // plan 模式工具面（只读过滤）也包含 todo 工具
    const planSpecs = tools.toModelSpecs("plan").map((s) => s.name);
    expect(planSpecs).toContain("todowrite");
    expect(planSpecs).toContain("todoread");
  });

  test("子代理不继承父 todo 列表：无 todos 上下文时工具报错而非误用父列表", async () => {
    const tools = createDefaultRegistry();
    const ctx: ToolContext = { sessionId: "s1", cwd: "/tmp" }; // 子代理形态：无 todos 注入
    await expect(tools.get("todowrite")!.execute({ todos: [item("A")] }, ctx)).rejects.toThrow(
      "任务清单不可用",
    );
    await expect(tools.get("todoread")!.execute({}, ctx)).rejects.toThrow("任务清单不可用");
  });
});

// ---------- 单元：事件恢复与 compaction 保留 ----------
describe("M1 单元：事件恢复与 compaction 保留", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-todo-unit-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test("restoreTodosFromEvents：取最后一次 todo.list_updated；无事件返回 undefined", () => {
    const events = [
      { type: "message.user", payload: { text: "hi" } },
      { type: "todo.list_updated", payload: { todos: [item("旧", "completed")] } },
      { type: "todo.list_updated", payload: { todos: [item("新", "in_progress")] } },
      { type: "turn.completed", payload: {} },
    ] as unknown as AgentEvent[];
    expect(restoreTodosFromEvents(events)).toEqual([item("新", "in_progress")]);
    expect(
      restoreTodosFromEvents([{ type: "message.user", payload: { text: "hi" } } as unknown as AgentEvent]),
    ).toBeUndefined();
  });

  test("TodoStore 缓存未命中时经 restore 回调从事件日志重建", () => {
    const store = new TodoStore(() => [item("恢复的任务", "in_progress")]);
    expect(store.get("s-x")).toEqual([item("恢复的任务", "in_progress")]);
    // 第二次读走缓存（restore 只调一次）
    store.set("s-x", [item("覆盖", "pending")]);
    expect(store.get("s-x")).toEqual([item("覆盖", "pending")]);
  });

  test("compaction 保留：压缩边界覆盖 todo 事件后，附录仍来自 TodoStore 而非 fold", () => {
    const bus = new EventBus();
    const store = new SqliteEventStore(path.join(tmp, "compact.db"), bus);
    const session = store.createSession({
      session_id: "s-todo",
      title: "t",
      cwd: tmp,
      mode: "build",
      model: "mock",
      sandbox_level: "workspace",
      created_at: Date.now(),
      archived: false,
      forked_from: null,
      caller_identity: "local-user",
    });
    store.append({
      session_id: session.session_id,
      type: "todo.list_updated",
      actor: "agent",
      payload: { todos: [item("压缩前的任务", "in_progress")] },
    });
    // 压缩边界覆盖所有已有事件
    store.append({
      session_id: session.session_id,
      type: "context.compacted",
      actor: "system",
      payload: {
        summary: {
          session_intent: "意图",
          files_modified: [],
          key_decisions: [],
          active_goals: [],
          next_steps: "继续",
        },
        covers_until_seq: store.latestSeq(session.session_id),
        tokens_before: 100,
        tokens_after: 10,
      },
    });

    const tools = createDefaultRegistry();
    // fold 不把 todo 事件折进消息（它不是消息类事件）
    const { messages, compacted } = rebuildContext(store, session, tools.toModelSpecs());
    expect(compacted).toBe(true);
    expect(messages.every((m) => !m.content.includes("压缩前的任务"))).toBe(true);

    // 但 TodoStore 仍能从事件日志恢复 → system 附录照常注入（这就是「compaction 保留项」）
    const todos = new TodoStore((sid) => restoreTodosFromEvents(store.readSince(sid, -1)));
    const appendix = formatTodoAppendix(todos.get(session.session_id));
    expect(appendix).toContain("压缩前的任务");
    store.close();
  });
});

// ---------- e2e：Mock 模型全链路 ----------
describe("M1 e2e：!todowrite / !todoread", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-todo-e2e-"));
  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  let store: SqliteEventStore;
  let bus: EventBus;
  let manager: SessionManager;
  let models: RuntimeModelRegistry;
  let events: AgentEvent[] = [];
  let session: SessionRecord;

  async function waitForTurnEnd(fromIndex: number, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    for (;;) {
      const done = events
        .slice(fromIndex)
        .some((e) => e.type === "turn.completed" || e.type === "turn.aborted");
      if (done && manager.getSession(session.session_id)!.status === "idle") return;
      if (Date.now() - start > timeoutMs) throw new Error("等待轮次结束超时");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  beforeAll(() => {
    bus = new EventBus();
    store = new SqliteEventStore(path.join(tmp, "e2e.db"), bus);
    bus.subscribe((e) => events.push(e));
    models = new RuntimeModelRegistry({});
    manager = new SessionManager(store, createDefaultRegistry(), models);
    session = manager.createSession({
      cwd: workspace,
      mode: "build",
      model: "mock",
      sandbox_level: "workspace",
    });
  });

  afterAll(() => {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("!todowrite：全量覆盖落 todo.list_updated 事件，无需审批", async () => {
    const mark = events.length;
    manager.postMessage(
      session.session_id,
      "!todowrite 写设计文档=completed;实现 M1=in_progress=high;补测试=pending=medium",
    );
    await waitForTurnEnd(mark);

    const slice = events.slice(mark);
    expect(slice.map((e) => e.type)).not.toContain("approval.requested");
    const updated = slice.find((e) => e.type === "todo.list_updated");
    expect(updated).toBeDefined();
    expect((updated!.payload as { todos: TodoItem[] }).todos).toEqual([
      item("写设计文档", "completed"),
      item("实现 M1", "in_progress", "high"),
      item("补测试", "pending", "medium"),
    ]);
  });

  test("!todowrite 全量覆盖语义（e2e）：第二次写替换第一次", async () => {
    const mark = events.length;
    manager.postMessage(session.session_id, "!todowrite 全新任务=pending");
    await waitForTurnEnd(mark);
    const updated = events.slice(mark).find((e) => e.type === "todo.list_updated");
    expect((updated!.payload as { todos: TodoItem[] }).todos).toEqual([item("全新任务")]);
  });

  test("!todoread：返回正确数据且按状态排序", async () => {
    const m1 = events.length;
    manager.postMessage(
      session.session_id,
      "!todowrite 旧任务=completed;进行中任务=in_progress;排队任务=pending",
    );
    await waitForTurnEnd(m1);

    const m2 = events.length;
    manager.postMessage(session.session_id, "!todoread");
    await waitForTurnEnd(m2);

    const completed = events
      .slice(m2)
      .find((e) => e.type === "tool.call.completed")!;
    const result = (completed.payload as { result: string }).result;
    expect(result).toContain("1/3 已完成");
    const i1 = result.indexOf("进行中任务");
    const i2 = result.indexOf("排队任务");
    const i3 = result.indexOf("旧任务");
    expect(i1).toBeGreaterThan(-1);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
  });

  test("清单非空时注入 system 附录（模型可见）", async () => {
    // 捕获下一次模型调用收到的 system
    const mock = models.get("mock") as MockAdapter;
    const original = mock.streamChat.bind(mock);
    const capturedSystems: string[] = [];
    mock.streamChat = async (req, handlers, signal) => {
      capturedSystems.push(req.system);
      return original(req, handlers, signal);
    };
    try {
      const m1 = events.length;
      manager.postMessage(session.session_id, "!todowrite 附录可见性=in_progress=high");
      await waitForTurnEnd(m1);

      const m2 = events.length;
      manager.postMessage(session.session_id, "随便说点什么");
      await waitForTurnEnd(m2);

      // 取最后一轮迭代的 system：todowrite 当轮首次调用时清单尚为空，
      // 工具写入后的下一次迭代起附录必须出现
      const last = capturedSystems[capturedSystems.length - 1];
      expect(last).toContain("## 任务清单");
      expect(last).toContain("附录可见性");
    } finally {
      mock.streamChat = original;
    }
  });

  test("恢复：新 SessionManager 重开同一 DB，todo 列表从事件日志重建", async () => {
    // 新 stack（模拟服务端重启），同一 DB
    const bus2 = new EventBus();
    const store2 = new SqliteEventStore(path.join(tmp, "e2e.db"), bus2);
    const events2: AgentEvent[] = [];
    bus2.subscribe((e) => events2.push(e));
    const manager2 = new SessionManager(store2, createDefaultRegistry(), new RuntimeModelRegistry({}));
    try {
      const restored = manager2.getSession(session.session_id)!;
      expect(restored).not.toBeNull();

      const m = events2.length;
      manager2.postMessage(session.session_id, "!todoread");
      // 等轮次结束
      const start = Date.now();
      for (;;) {
        const done = events2
          .slice(m)
          .some((e) => e.type === "turn.completed" || e.type === "turn.aborted");
        if (done && manager2.getSession(session.session_id)!.status === "idle") break;
        if (Date.now() - start > 8000) throw new Error("等待轮次结束超时");
        await new Promise((r) => setTimeout(r, 20));
      }
      const completed = events2.slice(m).find((e) => e.type === "tool.call.completed")!;
      // 重启后仍能读到重启前最后一次全量覆盖写入的清单（事件是唯一事实来源）
      expect((completed.payload as { result: string }).result).toContain("附录可见性");
    } finally {
      store2.close();
    }
  });
});
