/**
 * P0/P1 端到端验证（Mock 模型）：
 * 1. 发消息 → 工具提议 → 权限放行 → 执行 → 落库 → 轮次完成
 * 2. bash → 审批挂起 → 批准 → 执行
 * 3. bash → 拒绝 → tool.call.failed（用户拒绝）
 * 4. 权限拒绝：越出工作区的写入被 deny
 * 5. 上下文重建：tool call 与 tool result 正确配对
 * 6. 恢复：换存储实例重开同一 DB，事件与重建结果完好
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
import { rebuildContext } from "../src/context/index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-e2e-"));
const dbPath = path.join(tmp, "test.db");
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(workspace, { recursive: true });

let store: SqliteEventStore;
let bus: EventBus;
let manager: SessionManager;
let events: AgentEvent[] = [];
let session: SessionRecord;

function makeStack() {
  bus = new EventBus();
  store = new SqliteEventStore(dbPath, bus);
  bus.subscribe((e) => events.push(e));
  const tools = createDefaultRegistry();
  const models = new RuntimeModelRegistry({});
  manager = new SessionManager(store, tools, models);
}

/** 等待某个事件类型出现（只查 fromIndex 之后的，避免命中历史事件） */
async function waitFor(type: string, fromIndex: number, timeoutMs = 5000): Promise<AgentEvent> {
  const start = Date.now();
  for (;;) {
    const found = events.slice(fromIndex).find((e) => e.type === type);
    if (found) return found;
    if (Date.now() - start > timeoutMs) throw new Error(`等待事件超时: ${type}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function waitForTurnCompleted(fromIndex: number, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const done = events
      .slice(fromIndex)
      .some((e) => e.type === "turn.completed" || e.type === "turn.aborted");
    // 轮次事件与状态变更是两次 append，需等状态落到 idle 才算真正结束
    if (done && manager.getSession(session.session_id)!.status === "idle") return;
    if (Date.now() - start > timeoutMs) throw new Error("等待轮次结束超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(() => {
  makeStack();
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

describe("P0 端到端", () => {
  test("write 工具：工作区内自动放行并真实写文件", async () => {
    const mark = events.length;
    manager.postMessage(session.session_id, "!write hello.txt hello agent");
    await waitForTurnCompleted(mark);

    // 文件真实写入
    expect(fs.readFileSync(path.join(workspace, "hello.txt"), "utf-8")).toBe("hello agent");

    // 事件链完整：proposed → started → completed → turn.completed
    const slice = events.slice(mark);
    const types = slice.map((e) => e.type);
    expect(types).toContain("tool.call.proposed");
    expect(types).toContain("tool.call.started");
    expect(types).toContain("tool.call.completed");
    expect(types).toContain("turn.completed");
    // 工作区内写入不该触发审批
    expect(types).not.toContain("approval.requested");

    const completed = slice.find((e) => e.type === "tool.call.completed");
    expect((completed!.payload as { side_effects?: { diff?: string } }).side_effects?.diff).toContain("+hello agent");
  });

  test("bash 审批：挂起 → 批准 → 执行", async () => {
    const mark = events.length;
    manager.postMessage(session.session_id, "!bash echo approval-works");

    // 等待审批挂起
    const req = await waitFor("approval.requested");
    const { approval_id } = req.payload as { approval_id: string };
    expect(manager.getSession(session.session_id)!.status).toBe("awaiting_approval");

    // 批准
    const ok = manager.resolveApproval(session.session_id, approval_id, { decision: "approve" });
    expect(ok).toBe(true);
    await waitForTurnCompleted(mark);

    const slice = events.slice(mark);
    expect(slice.map((e) => e.type)).toContain("approval.resolved");
    const completed = slice.find((e) => e.type === "tool.call.completed");
    expect((completed!.payload as { result: string }).result).toContain("approval-works");
  });

  test("bash 审批：拒绝 → 工具失败事件，模型收到拒绝信息", async () => {
    const mark = events.length;
    manager.postMessage(session.session_id, "!bash rm -rf /");
    const req = await waitFor("approval.requested", mark, 8000);
    const { approval_id } = req.payload as { approval_id: string };
    manager.resolveApproval(session.session_id, approval_id, {
      decision: "deny",
      deny_reason: "危险命令",
    });
    await waitForTurnCompleted(mark);

    const slice = events.slice(mark);
    const failed = slice.find((e) => e.type === "tool.call.failed");
    expect(failed).toBeDefined();
    expect((failed!.payload as { error: string }).error).toContain("用户拒绝");
    // 被拒绝的命令绝不执行：completed 里不该有 rm 的结果
    expect(slice.filter((e) => e.type === "tool.call.completed").length).toBe(0);
  });

  test("权限拒绝：越出工作区的写入被 deny（fail-closed）", async () => {
    const mark = events.length;
    manager.postMessage(session.session_id, "!write /etc/evil.txt nope");
    await waitForTurnCompleted(mark);

    const slice = events.slice(mark);
    const failed = slice.find((e) => e.type === "tool.call.failed");
    expect(failed).toBeDefined();
    expect((failed!.payload as { error: string }).error).toContain("权限拒绝");
    expect(fs.existsSync("/etc/evil.txt")).toBe(false);
  });

  test("上下文重建：tool call 与 tool result 配对", () => {
    const tools = createDefaultRegistry();
    const { messages } = rebuildContext(store, manager.getSession(session.session_id)!, tools.toModelSpecs());

    const assistantWithCalls = messages.filter((m) => m.role === "assistant" && m.tool_calls?.length);
    const toolMsgs = messages.filter((m) => m.role === "tool");
    expect(assistantWithCalls.length).toBeGreaterThan(0);
    expect(toolMsgs.length).toBeGreaterThan(0);

    // 每个 assistant 的 tool_call 都有对应 tool 消息（协议正确性）
    for (const m of assistantWithCalls) {
      for (const tc of m.tool_calls!) {
        expect(toolMsgs.some((t) => t.tool_call_id === tc.id)).toBe(true);
      }
    }
  });

  test("恢复：新存储实例重开同一 DB，事件与上下文完好", () => {
    store.close();
    events = [];
    makeStack(); // 新 store + 新 manager，同一 dbPath

    const restored = manager.getSession(session.session_id);
    expect(restored).not.toBeNull();
    expect(restored!.last_seq).toBeGreaterThan(0);

    const tools = createDefaultRegistry();
    const { messages } = rebuildContext(store, restored!, tools.toModelSpecs());
    const userMsgs = messages.filter((m) => m.role === "user");
    expect(userMsgs.some((m) => m.content.includes("!write hello.txt"))).toBe(true);
  });

  test("分叉：复制事件至指定 seq", () => {
    const source = manager.getSession(session.session_id)!;
    const midSeq = Math.floor(source.last_seq / 2);
    const fork = manager.fork(session.session_id, midSeq);
    expect(fork.session_id).not.toBe(session.session_id);

    const forkEvents = store.readSince(fork.session_id, -1);
    const forkedMarker = forkEvents.find((e) => e.type === "session.forked");
    expect(forkedMarker).toBeDefined();
    expect((forkedMarker!.payload as { fork_at_seq: number }).fork_at_seq).toBe(midSeq);
  });

  test("seq 单调无空洞", () => {
    const all = store.readSince(session.session_id, -1);
    for (let i = 0; i < all.length; i++) {
      expect(all[i].seq).toBe(i);
    }
  });
});
