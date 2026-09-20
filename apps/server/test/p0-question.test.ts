/**
 * P0：question 工具——模型 turn 中主动向用户提问。
 * 复用审批通道：approval.requested(tool=question) → 用户作答 → approval.resolved(answer) →
 * tool.call.completed(result=用户回答：…)。拒绝 → tool.call.failed。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteEventStore } from "../src/store/event-store.js";
import { EventBus } from "../src/bus/index.js";
import { SessionManager } from "../src/session/manager.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { RuntimeModelRegistry } from "../src/model/registry.js";
import type { AgentEvent } from "@shuyi/types";

let tmp: string;
let store: SqliteEventStore;
let manager: SessionManager;
let events: AgentEvent[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p0-question-"));
  const bus = new EventBus();
  store = new SqliteEventStore(path.join(tmp, "events.db"), bus);
  events = [];
  bus.subscribe((e) => events.push(e));
  manager = new SessionManager(store, createDefaultRegistry(), new RuntimeModelRegistry({}));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sessionEvents(sid: string): AgentEvent[] {
  return events.filter((e) => e.session_id === sid);
}

async function waitFor(cond: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function pendingApproval(sid: string): { approval_id: string; args: Record<string, unknown> } | null {
  const e = sessionEvents(sid).find((x) => x.type === "approval.requested");
  return e ? (e.payload as { approval_id: string; args: Record<string, unknown> }) : null;
}

describe("P0 question 工具", () => {
  test("工具已注册：plan 模式可见（always-allow）、对子代理隐藏", () => {
    const r = createDefaultRegistry();
    const q = r.get("question");
    expect(q).toBeDefined();
    expect(q!.permission).toBe("always-allow");
    expect(q!.subagentVisible).toBe(false);
    expect(r.toModelSpecs("plan").map((s) => s.name)).toContain("question");
  });

  test("e2e：!question → 审批请求携带问题与选项 → 作答折回工具结果", async () => {
    const session = manager.createSession({
      cwd: tmp, mode: "build", model: "mock", sandbox_level: "workspace-write",
    });
    manager.postMessage(session.session_id, "!question 用哪种数据库？=SQLite|Postgres");
    await waitFor(() => pendingApproval(session.session_id) !== null);
    const ap = pendingApproval(session.session_id)!;
    expect(ap.args.question).toBe("用哪种数据库？");
    expect(ap.args.options).toEqual(["SQLite", "Postgres"]);

    manager.resolveApproval(session.session_id, ap.approval_id, { decision: "approve", answer: "SQLite" });
    await waitFor(() => sessionEvents(session.session_id).some((e) => e.type === "turn.completed"));

    const evts = sessionEvents(session.session_id);
    const resolved = evts.find((e) => e.type === "approval.resolved");
    expect((resolved!.payload as { answer?: string }).answer).toBe("SQLite");
    const completed = evts.find((e) => e.type === "tool.call.completed");
    expect((completed!.payload as { result: string }).result).toContain("用户回答：SQLite");
  });

  test("e2e：用户拒绝回答 → tool.call.failed 提示按最佳判断继续", async () => {
    const session = manager.createSession({
      cwd: tmp, mode: "build", model: "mock", sandbox_level: "workspace-write",
    });
    manager.postMessage(session.session_id, "!question 要删除生产数据吗？");
    await waitFor(() => pendingApproval(session.session_id) !== null);
    manager.resolveApproval(session.session_id, pendingApproval(session.session_id)!.approval_id, {
      decision: "deny",
      deny_reason: "不该问这个",
    });
    await waitFor(() => sessionEvents(session.session_id).some((e) => e.type === "turn.completed"));

    const failed = sessionEvents(session.session_id).find((e) => e.type === "tool.call.failed");
    expect((failed!.payload as { error: string }).error).toContain("用户拒绝回答");
    expect((failed!.payload as { error: string }).error).toContain("不该问这个");
  });

  test("mock 无选项时 approval.args 不含 options；空回答按默认语折回", async () => {
    const session = manager.createSession({
      cwd: tmp, mode: "build", model: "mock", sandbox_level: "workspace-write",
    });
    manager.postMessage(session.session_id, "!question 继续吗？");
    await waitFor(() => pendingApproval(session.session_id) !== null);
    const ap = pendingApproval(session.session_id)!;
    expect(ap.args.options).toBeUndefined();
    manager.resolveApproval(session.session_id, ap.approval_id, { decision: "approve", answer: "  " });
    await waitFor(() => sessionEvents(session.session_id).some((e) => e.type === "turn.completed"));
    const completed = sessionEvents(session.session_id).find((e) => e.type === "tool.call.completed");
    expect((completed!.payload as { result: string }).result).toContain("最佳判断");
  });
});
