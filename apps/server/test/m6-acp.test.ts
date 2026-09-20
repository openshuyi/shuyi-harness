/**
 * M6：ACP（Agent Client Protocol）服务端——stdio mock 客户端 e2e。
 * 覆盖协议全生命周期：
 *   initialize → session/new → session/prompt（流式 session/update）→
 *   session/request_permission 权限桥接 → stopReason → session/cancel → session/set_mode。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpServer } from "../src/acp/index.js";
import { SqliteEventStore } from "../src/store/event-store.js";
import { EventBus } from "../src/bus/index.js";
import { SessionManager } from "../src/session/manager.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { RuntimeModelRegistry } from "../src/model/registry.js";

/** 模拟 IDE 客户端：发请求收响应，收通知，自动应答权限请求 */
class MockClient {
  outbox: Record<string, unknown>[] = [];
  private waiter: { id: number | string; resolve: (m: Record<string, unknown>) => void } | null = null;
  /** 权限应答策略：收到 session/request_permission 时如何回应 */
  permissionPolicy: (options: { optionId: string }[]) => string | null = () => "allow";

  constructor(private server: AcpServer) {}

  write(msg: Record<string, unknown>): void {
    this.outbox.push(msg);
    // 响应派发
    if (!msg.method && msg.id !== undefined && this.waiter && msg.id === this.waiter.id) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(msg);
      return;
    }
    // Agent → Client 请求：权限桥接
    if (msg.method === "session/request_permission" && msg.id !== undefined) {
      const params = msg.params as { options: { optionId: string }[] };
      const pick = this.permissionPolicy(params.options);
      const outcome = pick
        ? { outcome: { outcome: "selected", optionId: pick } }
        : { outcome: { outcome: "cancelled" } };
      void this.server.handleMessage({ jsonrpc: "2.0", id: msg.id, result: outcome });
    }
  }

  async request(method: string, params: Record<string, unknown>, id: number | string): Promise<Record<string, unknown>> {
    const done = new Promise<Record<string, unknown>>((resolve) => {
      this.waiter = { id, resolve };
    });
    await this.server.handleMessage({ jsonrpc: "2.0", id, method, params });
    return done;
  }

  notifications(sessionId?: string): Record<string, unknown>[] {
    return this.outbox.filter(
      (m) =>
        m.method === "session/update" &&
        (sessionId === undefined || (m.params as { sessionId: string }).sessionId === sessionId),
    );
  }

  updates(sessionId: string, kind: string): Record<string, unknown>[] {
    return this.notifications(sessionId)
      .map((m) => (m.params as { update: Record<string, unknown> }).update)
      .filter((u) => u.sessionUpdate === kind);
  }
}

let tmp: string;
let store: SqliteEventStore;
let sessions: SessionManager;
let server: AcpServer;
let client: MockClient;
let models: RuntimeModelRegistry;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "m6-acp-"));
  const bus = new EventBus();
  store = new SqliteEventStore(path.join(tmp, "events.db"), bus);
  models = new RuntimeModelRegistry({});
  sessions = new SessionManager(store, createDefaultRegistry(), models);
  client = new MockClient(null as unknown as AcpServer);
  server = new AcpServer({ store, bus, sessions, models }, (msg) =>
    client.write(msg as Record<string, unknown>),
  );
  (client as unknown as { server: AcpServer }).server = server;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function newSession(id: string): Promise<string> {
  const res = await client.request("session/new", { cwd: tmp, mcpServers: [] }, id);
  const result = res.result as { sessionId: string; modes: { currentModeId: string } };
  expect(result.sessionId).toBeTruthy();
  expect(result.modes.currentModeId).toBe("build");
  return result.sessionId;
}

describe("M6 ACP 协议", () => {
  test("initialize：回显协议版本 + 能力 + 空 authMethods + agentInfo", async () => {
    const res = await client.request(
      "initialize",
      { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } },
      1,
    );
    const r = res.result as Record<string, unknown>;
    expect(r.protocolVersion).toBe(1);
    const caps = r.agentCapabilities as Record<string, unknown>;
    expect(caps.loadSession).toBe(false);
    expect(r.authMethods).toEqual([]);
    expect((r.agentInfo as { name: string }).name).toBe("shuyi-agent");
  });

  test("未知方法 → -32601；坏 sessionId → 错误响应", async () => {
    const res = await client.request("no/such", {}, 9);
    expect((res.error as { code: number }).code).toBe(-32601);
    const res2 = await client.request("session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "hi" }] }, 10);
    expect((res2.error as { code: number }).code).toBe(-32602);
  });

  test("完整 prompt 流程：流式 chunk + tool_call 生命周期 + stopReason=end_turn", async () => {
    await client.request("initialize", { protocolVersion: 1 }, 1);
    const sid = await newSession(2);

    const promptDone = client.request(
      "session/prompt",
      { sessionId: sid, prompt: [{ type: "text", text: "!write hello.txt ACP 你好" }] },
      3,
    );
    const res = await promptDone;
    expect((res.result as { stopReason: string }).stopReason).toBe("end_turn");

    // 工具调用生命周期通知
    const calls = client.updates(sid, "tool_call");
    expect(calls.length).toBe(1);
    expect(calls[0].title).toContain("write");
    expect(calls[0].kind).toBe("edit");
    expect(calls[0].status).toBe("pending");
    expect((calls[0].locations as { path: string }[])[0].path).toBe("hello.txt");

    const updates = client.updates(sid, "tool_call_update");
    const statuses = updates.map((u) => u.status);
    expect(statuses).toContain("in_progress");
    expect(statuses).toContain("completed");

    // 文本 chunk + usage_update
    const chunks = client.updates(sid, "agent_message_chunk");
    expect(chunks.length).toBeGreaterThan(0);
    expect(client.updates(sid, "usage_update").length).toBe(1);

    // 文件真实写入（工具语义复用核心 Loop）
    expect(fs.readFileSync(path.join(tmp, "hello.txt"), "utf-8")).toBe("ACP 你好");
  });

  test("权限桥接：always-ask 工具 → request_permission → 客户端批准 → 执行", async () => {
    await client.request("initialize", { protocolVersion: 1 }, 1);
    const sid = await newSession(2);
    // webfetch 是 always-ask；用 mock !webfetch 触发（工具未注册时走未知工具路径，
    // 因此改用 bash 越界写入触发 ask：写 /etc 外的绝对路径会命中 sandbox 升级？
    // 简化：直接把 question 工具当 ask 通道验证桥接）
    client.permissionPolicy = (opts) => opts[0].optionId; // 选第一个选项
    const res = await client.request(
      "session/prompt",
      { sessionId: sid, prompt: [{ type: "text", text: "!question 用哪种方案？=方案A|方案B" }] },
      3,
    );
    expect((res.result as { stopReason: string }).stopReason).toBe("end_turn");
    // 权限请求确实发出且带 question 选项
    const permReq = client.outbox.find((m) => m.method === "session/request_permission");
    expect(permReq).toBeDefined();
    const params = permReq!.params as { options: { optionId: string; name: string }[] };
    expect(params.options.map((o) => o.name)).toEqual(["方案A", "方案B", "拒绝回答"]);
    // 客户端选了「方案A」→ 工具结果折回该答案
    const completed = client.updates(sid, "tool_call_update").filter((u) => u.status === "completed");
    const content = JSON.stringify(completed.map((u) => u.content));
    expect(content).toContain("方案A");
  });

  test("权限桥接：客户端取消 → 工具失败折回", async () => {
    await client.request("initialize", { protocolVersion: 1 }, 1);
    const sid = await newSession(2);
    client.permissionPolicy = () => null; // cancelled
    const res = await client.request(
      "session/prompt",
      { sessionId: sid, prompt: [{ type: "text", text: "!question 继续吗？" }] },
      3,
    );
    expect((res.result as { stopReason: string }).stopReason).toBe("end_turn");
    const failed = client.updates(sid, "tool_call_update").filter((u) => u.status === "failed");
    expect(JSON.stringify(failed)).toContain("客户端取消");
  });

  test("session/set_mode：切换 plan 并收到 current_mode_update；非法 modeId 报错", async () => {
    await client.request("initialize", { protocolVersion: 1 }, 1);
    const sid = await newSession(2);
    const res = await client.request("session/set_mode", { sessionId: sid, modeId: "plan" }, 5);
    expect(res.error).toBeUndefined();
    expect(client.updates(sid, "current_mode_update").some((u) => u.modeId === "plan")).toBe(true);
    expect(store.getSession(sid)!.mode).toBe("plan");

    const bad = await client.request("session/set_mode", { sessionId: sid, modeId: "yolo" }, 6);
    expect((bad.error as { code: number }).code).toBe(-32602);
  });

  test("session/cancel：中断运行中的轮次 → stopReason=cancelled", async () => {
    await client.request("initialize", { protocolVersion: 1 }, 1);
    const sid = await newSession(2);
    // 脚本化长流式回复（每字符 2ms → 足够窗口期发起 cancel）
    const mock = models.adapters.get("mock") as unknown as {
      pushScript: (step: { text?: string }) => void;
    };
    mock.pushScript({ text: "很长的回复".repeat(80) }); // 400 字符 × 2ms ≈ 0.8s 流式窗口
    const promptDone = client.request(
      "session/prompt",
      { sessionId: sid, prompt: [{ type: "text", text: "讲个长故事" }] },
      3,
    );
    // 流式进行中发起 cancel
    await new Promise((r) => setTimeout(r, 100));
    await server.handleMessage({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: sid } });
    const res = await promptDone;
    expect((res.result as { stopReason: string }).stopReason).toBe("cancelled");
  });

  test("available_commands_update：.agent/commands 下的命令随 session/new 推送", async () => {
    fs.mkdirSync(path.join(tmp, ".agent", "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".agent", "commands", "review.md"),
      "---\ndescription: 代码评审\n---\n请评审：$ARGUMENTS",
    );
    await client.request("initialize", { protocolVersion: 1 }, 1);
    const sid = await newSession(2);
    const cmds = client.updates(sid, "available_commands_update");
    expect(cmds.length).toBe(1);
    const available = cmds[0].availableCommands as { name: string; description: string }[];
    expect(available[0]).toEqual({ name: "review", description: "代码评审" });
  });
});
