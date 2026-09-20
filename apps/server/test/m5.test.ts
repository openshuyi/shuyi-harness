/**
 * M5 多会话并行测试。
 * 对应文档：《编码智能体-v0.3设计-能力追赶计划.md》§M5 验收：
 * - e2e：两个会话同时跑 mock 模型，互不串流；A 会话等待审批时 B 会话可继续
 * - 单元：聚合 SSE 流按 sessionId 分派；event-store 并发追加不丢事件
 * 另覆盖：GET /api/sessions 列表增强（activeCallCount）、bus 订阅过滤。
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentEvent, SessionRecord } from "@shuyi/types";
import { EventBus } from "../src/bus/index.js";
import { SqliteEventStore } from "../src/store/event-store.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { RuntimeModelRegistry } from "../src/model/registry.js";
import { SessionManager } from "../src/session/manager.js";
import { AgentRegistry } from "../src/agents/index.js";
import { createApi } from "../src/api/index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-m5-"));
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(workspace, { recursive: true });

// ---------- 单元：bus 订阅过滤（聚合流分派的基础） ----------
describe("M5 单元：bus 按 sessionId 过滤", () => {
  test("单会话与多会话集合过滤", () => {
    const bus = new EventBus();
    const mk = (sid: string, seq: number): AgentEvent =>
      ({ event_id: `${sid}-${seq}`, session_id: sid, seq, ts: 0, type: "message.user", actor: "user", payload: { text: "x" } }) as AgentEvent;

    const single: string[] = [];
    const multi: string[] = [];
    const all: string[] = [];
    const un1 = bus.subscribe((e) => single.push(e.session_id), "A");
    const un2 = bus.subscribe((e) => multi.push(e.session_id), new Set(["A", "B"]));
    const un3 = bus.subscribe((e) => all.push(e.session_id));

    bus.publish(mk("A", 0));
    bus.publish(mk("B", 0));
    bus.publish(mk("C", 0));

    expect(single).toEqual(["A"]);
    expect(multi).toEqual(["A", "B"]);
    expect(all).toEqual(["A", "B", "C"]);
    un1(); un2(); un3();
  });
});

// ---------- 单元：event-store 并发追加不丢事件 ----------
describe("M5 单元：event-store 并发追加", () => {
  test("两会话交错并发写入：不丢事件、seq 各自单调无空洞", async () => {
    const store = new SqliteEventStore(path.join(tmp, "concurrent.db"), new EventBus());
    const a = store.createSession({
      session_id: "sess-a", title: "A", cwd: workspace, mode: "build", model: "mock",
      sandbox_level: "workspace", created_at: Date.now(), archived: false,
      forked_from: null, caller_identity: "local-user",
    });
    const b = store.createSession({
      session_id: "sess-b", title: "B", cwd: workspace, mode: "build", model: "mock",
      sandbox_level: "workspace", created_at: Date.now(), archived: false,
      forked_from: null, caller_identity: "local-user",
    });
    const N = 25;
    // 交错并发：每个 append 前让出事件循环，最大化交错概率
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      for (const sid of [a.session_id, b.session_id]) {
        tasks.push(
          (async () => {
            await new Promise((r) => setTimeout(r, Math.random() * 3));
            store.append({ session_id: sid, type: "message.user", actor: "user", payload: { text: `m${i}` } });
          })(),
        );
      }
    }
    await Promise.all(tasks);

    for (const sid of [a.session_id, b.session_id]) {
      const events = store.readSince(sid, -1);
      const userMsgs = events.filter((e) => e.type === "message.user");
      expect(userMsgs.length).toBe(N); // 不丢事件
      // seq 从 0 连续无空洞（session.created 占 seq 0）
      events.forEach((e, idx) => expect(e.seq).toBe(idx));
    }
    store.close();
  });
});

// ---------- 单元：聚合 SSE 流按 sessionId 分派（真实服务器） ----------
describe("M5 单元：聚合 SSE 流", () => {
  test("?sessions=A,B 只推送订阅集合内会话；无参数推送全部", async () => {
    const bus = new EventBus();
    const store = new SqliteEventStore(path.join(tmp, "sse.db"), bus);
    const manager = new SessionManager(store, createDefaultRegistry(), new RuntimeModelRegistry({}), new AgentRegistry(path.join(tmp, "home-sse")));
    const app = createApi({ store, bus, sessions: manager, models: new RuntimeModelRegistry({}), agents: new AgentRegistry(path.join(tmp, "home-sse")) });
    const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 0 });
    try {
      for (const sid of ["agg-a", "agg-b", "agg-c"]) {
        store.createSession({
          session_id: sid, title: sid, cwd: workspace, mode: "build", model: "mock",
          sandbox_level: "workspace", created_at: Date.now(), archived: false,
          forked_from: null, caller_identity: "local-user",
        });
      }

      // 工具：读取 SSE 帧到数组（出错静默，连接关闭即结束）
      const collect = (res: Response, sink: AgentEvent[]) => {
        const reader = res.body!.getReader();
        const pump = (async () => {
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const frames = buf.split("\n\n");
            buf = frames.pop() ?? "";
            for (const frame of frames) {
              const line = frame.split("\n").find((l) => l.startsWith("data:"));
              if (!line) continue;
              try {
                sink.push(JSON.parse(line.slice(5).trim()) as AgentEvent);
              } catch {
                // ping 帧忽略
              }
            }
          }
        })();
        pump.catch(() => {});
        return { reader, pump };
      };
      const waitFor = async (n: number, sink: AgentEvent[]) => {
        const start = Date.now();
        while (sink.length < n && Date.now() - start < 5000) {
          await new Promise((r) => setTimeout(r, 20));
        }
      };

      // 1) 订阅 A,B：A/B/C 各发一条，流里只应出现 A、B
      const res1 = await fetch(`http://localhost:${server.port}/api/events?sessions=agg-a,agg-b`);
      expect(res1.status).toBe(200);
      const received: AgentEvent[] = [];
      const c1 = collect(res1, received);
      await new Promise((r) => setTimeout(r, 300)); // 等订阅注册
      for (const sid of ["agg-a", "agg-b", "agg-c"]) {
        store.append({ session_id: sid, type: "message.user", actor: "user", payload: { text: `hello-${sid}` } });
      }
      await waitFor(2, received);
      expect(received.length).toBe(2);
      expect(received.map((e) => e.session_id).sort()).toEqual(["agg-a", "agg-b"]);
      await c1.reader.cancel().catch(() => {});
      await Promise.race([c1.pump, new Promise((r) => setTimeout(r, 800))]);

      // 2) 无参数 = 全部会话：只发 C 也能收到
      const res2 = await fetch(`http://localhost:${server.port}/api/events`);
      expect(res2.status).toBe(200);
      const receivedAll: AgentEvent[] = [];
      const c2 = collect(res2, receivedAll);
      await new Promise((r) => setTimeout(r, 300));
      store.append({ session_id: "agg-c", type: "message.user", actor: "user", payload: { text: "only-c" } });
      await waitFor(1, receivedAll);
      expect(receivedAll.length).toBe(1);
      expect(receivedAll[0].session_id).toBe("agg-c");
      await c2.reader.cancel().catch(() => {});
      await Promise.race([c2.pump, new Promise((r) => setTimeout(r, 800))]);
    } finally {
      server.stop(true);
      store.close();
    }
  }, 15000);
});

// ---------- e2e：双会话并行（文档验收） ----------
describe("M5 e2e：多会话并行", () => {
  let store: SqliteEventStore;
  let manager: SessionManager;
  let events: AgentEvent[] = [];

  async function waitStatus(s: SessionRecord, status: string, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (manager.getSession(s.session_id)!.status === status) return;
      if (Date.now() - start > timeoutMs) throw new Error(`等待 ${s.session_id} 状态 ${status} 超时`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  beforeAll(() => {
    const bus = new EventBus();
    store = new SqliteEventStore(path.join(tmp, "m5-e2e.db"), bus);
    bus.subscribe((e) => events.push(e));
    manager = new SessionManager(store, createDefaultRegistry(), new RuntimeModelRegistry({}), new AgentRegistry(path.join(tmp, "home-e2e")));
  });

  afterAll(() => {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("A 等待审批时 B 可继续；审批后 A 完成；事件按 session_id 隔离", async () => {
    const a = manager.createSession({ cwd: workspace, mode: "build", model: "mock", sandbox_level: "workspace" });
    const b = manager.createSession({ cwd: workspace, mode: "build", model: "mock", sandbox_level: "workspace" });

    // A 触发 bash 审批 → 挂起
    manager.postMessage(a.session_id, "!bash echo session-a");
    await waitStatus(a, "awaiting_approval");

    // 列表增强：A 有 1 个挂起审批，B 为 0
    const list = manager.listSessions();
    expect(list.find((s) => s.session_id === a.session_id)!.activeCallCount).toBe(1);
    expect(list.find((s) => s.session_id === b.session_id)!.activeCallCount).toBe(0);

    // A 挂起期间 B 完整跑完一轮（互不阻塞）
    manager.postMessage(b.session_id, "你好 B");
    await waitStatus(b, "idle");
    expect(manager.getSession(a.session_id)!.status).toBe("awaiting_approval"); // A 仍在等

    // B 的事件全部归属 B（不串流）
    const bEvents = events.filter((e) => e.session_id === b.session_id);
    expect(bEvents.some((e) => e.type === "turn.completed")).toBe(true);
    expect(events.filter((e) => e.session_id === a.session_id).some((e) => e.type === "turn.completed")).toBe(false);

    // 批准 A → A 完成
    const reqA = events.find((e) => e.session_id === a.session_id && e.type === "approval.requested")!;
    manager.resolveApproval(a.session_id, (reqA.payload as { approval_id: string }).approval_id, { decision: "approve" });
    await waitStatus(a, "idle");
    expect(events.filter((e) => e.session_id === a.session_id).some((e) => e.type === "turn.completed")).toBe(true);
  });

  test("两会话同时流式输出：各自完成且轨迹不混", async () => {
    const a = manager.createSession({ cwd: workspace, mode: "build", model: "mock", sandbox_level: "workspace" });
    const b = manager.createSession({ cwd: workspace, mode: "build", model: "mock", sandbox_level: "workspace" });
    const mark = events.length;

    // 同时发消息（mock 流式输出）
    manager.postMessage(a.session_id, "A 的第一个问题");
    manager.postMessage(b.session_id, "!write b-file.txt 来自B");
    await Promise.all([waitStatus(a, "idle"), waitStatus(b, "idle")]);

    const slice = events.slice(mark);
    const aIds = new Set(slice.filter((e) => e.session_id === a.session_id).map((e) => e.event_id));
    const bIds = new Set(slice.filter((e) => e.session_id === b.session_id).map((e) => e.event_id));
    // 无交叉：同一 event_id 不会出现在两个会话
    for (const id of aIds) expect(bIds.has(id)).toBe(false);
    // 各自有完整轮次
    expect(slice.some((e) => e.session_id === a.session_id && e.type === "turn.completed")).toBe(true);
    expect(slice.some((e) => e.session_id === b.session_id && e.type === "turn.completed")).toBe(true);
    // B 的文件写入归属 B 的轨迹
    expect(slice.some((e) => e.session_id === b.session_id && e.type === "tool.call.completed")).toBe(true);
    expect(fs.readFileSync(path.join(workspace, "b-file.txt"), "utf-8")).toBe("来自B");
    // 每个会话的事件 seq 各自连续
    for (const sid of [a.session_id, b.session_id]) {
      const evts = store.readSince(sid, -1);
      evts.forEach((e, idx) => expect(e.seq).toBe(idx));
    }
  });
});
