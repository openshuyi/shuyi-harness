/**
 * v0.4 F1/F2/F3/F4/F9：检查点+rewind、变更面板、@引用、消息排队、分叉。
 * 快照语义：write/edit 执行前影子拷贝到 .agent/checkpoints/<sid>/<seq>/；
 * rewind(code) 恢复 seq>to_seq 快照；rewind(conversation) 追加 session.rewound，
 * 上下文重建在 to_seq 截断。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteEventStore } from "../src/store/event-store.js";
import { EventBus } from "../src/bus/index.js";
import { SessionManager, expandFileRefs } from "../src/session/manager.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { RuntimeModelRegistry } from "../src/model/registry.js";
import { unifiedDiff } from "../src/checkpoint/diff.js";
import { rewindCutoff } from "../src/context/index.js";
import type { AgentEvent } from "@shuyi/types";

let tmp: string;
let store: SqliteEventStore;
let manager: SessionManager;
let events: AgentEvent[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v04-"));
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

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function makeSession() {
  return manager.createSession({ cwd: tmp, mode: "build", model: "mock", sandbox_level: "workspace-write" });
}

function turnSeqs(sid: string): number[] {
  return sessionEvents(sid)
    .filter((e) => e.type === "turn.started")
    .map((e) => e.seq);
}

describe("v0.4 F1 检查点 + rewind", () => {
  test("write 前自动快照；rewind(code) 恢复文件内容", async () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "原始内容");
    const s = makeSession();
    manager.postMessage(s.session_id, "!write a.txt 被改写");
    await waitFor(() => sessionEvents(s.session_id).some((e) => e.type === "turn.completed"));
    expect(fs.readFileSync(path.join(tmp, "a.txt"), "utf8")).toBe("被改写");
    // 有检查点锚点事件
    const ckpt = sessionEvents(s.session_id).find((e) => e.type === "checkpoint.created");
    expect(ckpt).toBeDefined();
    const turnSeq = turnSeqs(s.session_id)[0];
    const r = manager.rewind(s.session_id, turnSeq, "code");
    expect(r.files_restored).toBe(1);
    expect(fs.readFileSync(path.join(tmp, "a.txt"), "utf8")).toBe("原始内容");
  });

  test("新建文件 rewind 后被删除（快照 existed=false）", async () => {
    const s = makeSession();
    manager.postMessage(s.session_id, "!write new.txt 全新");
    await waitFor(() => sessionEvents(s.session_id).some((e) => e.type === "turn.completed"));
    expect(fs.existsSync(path.join(tmp, "new.txt"))).toBe(true);
    manager.rewind(s.session_id, turnSeqs(s.session_id)[0], "code");
    expect(fs.existsSync(path.join(tmp, "new.txt"))).toBe(false);
  });

  test("两轮 rewind 到第一轮锚点：第二轮改动被恢复、第一轮保留", async () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "v0");
    const s = makeSession();
    manager.postMessage(s.session_id, "!write a.txt v1");
    await waitFor(() => sessionEvents(s.session_id).filter((e) => e.type === "turn.completed").length === 1);
    manager.postMessage(s.session_id, "!write a.txt v2");
    await waitFor(() => sessionEvents(s.session_id).filter((e) => e.type === "turn.completed").length === 2);
    expect(fs.readFileSync(path.join(tmp, "a.txt"), "utf8")).toBe("v2");
    const seqs = turnSeqs(s.session_id);
    manager.rewind(s.session_id, seqs[1], "code");
    expect(fs.readFileSync(path.join(tmp, "a.txt"), "utf8")).toBe("v1");
  });

  test("rewind(conversation) 追加 session.rewound 且上下文截断", async () => {
    const s = makeSession();
    manager.postMessage(s.session_id, "你好");
    await waitFor(() => sessionEvents(s.session_id).some((e) => e.type === "turn.completed"));
    const seqs = turnSeqs(s.session_id);
    manager.rewind(s.session_id, seqs[0], "conversation");
    const evs = store.readSince(s.session_id, -1);
    const rew = evs.find((e) => e.type === "session.rewound");
    expect(rew).toBeDefined();
    expect((rew!.payload as { mode: string }).mode).toBe("conversation");
    expect(rewindCutoff(evs)).toBe(seqs[0]);
    // 代码不动
  });

  test("busy 时 rewind 拒绝", async () => {
    const s = makeSession();
    manager.postMessage(s.session_id, "!bash sleep 2");
    await waitFor(() => sessionEvents(s.session_id).some((e) => e.type === "approval.requested"));
    expect(() => manager.rewind(s.session_id, 0, "both")).toThrow("正忙");
    manager.abort(s.session_id);
    await waitFor(() => store.getSession(s.session_id)!.status === "idle");
  });
});

describe("v0.4 F2 变更面板", () => {
  test("listChanges 聚合 diff；review revert 恢复、accept 清快照", async () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "line1\nline2\nline3");
    const s = makeSession();
    manager.postMessage(s.session_id, "!write a.txt line1\nCHANGED\nline3");
    await waitFor(() => sessionEvents(s.session_id).some((e) => e.type === "turn.completed"));
    const changes = manager.listChanges(s.session_id);
    expect(changes.length).toBe(1);
    expect(changes[0].path).toBe("a.txt");
    expect(changes[0].additions).toBe(1);
    expect(changes[0].deletions).toBe(1);
    expect(changes[0].diff).toContain("-line2");
    expect(changes[0].diff).toContain("+CHANGED");
    // revert
    const rr = manager.reviewChange(s.session_id, "a.txt", "revert");
    expect(rr.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmp, "a.txt"), "utf8")).toBe("line1\nline2\nline3");
    expect(manager.listChanges(s.session_id).length).toBe(0);
    expect(sessionEvents(s.session_id).some((e) => e.type === "changes.reviewed")).toBe(true);
  });

  test("unifiedDiff 基本正确（增删计数 + 上下文折叠）", () => {
    const d = unifiedDiff("x.txt", "a\nb\nc\nd\ne\nf\ng\nh", "a\nb\nc\nd\ne\nf\nG\nh");
    expect(d.additions).toBe(1);
    expect(d.deletions).toBe(1);
    expect(d.text).toContain(" @@ …… @@");
    expect(d.text).toContain("-g");
    expect(d.text).toContain("+G");
  });
});

describe("v0.4 F3 @ 文件引用", () => {
  test("expandFileRefs 注入存在的文件、保留未知引用、越界拒绝", () => {
    fs.writeFileSync(path.join(tmp, "foo.ts"), "export const x = 1;");
    const out = expandFileRefs("看看 @foo.ts 和 @nope.ts", tmp);
    expect(out).toContain('<file path="foo.ts">');
    expect(out).toContain("export const x = 1;");
    expect(out).not.toContain('<file path="nope.ts">');
    const out2 = expandFileRefs("读 @../etc/passwd", tmp);
    expect(out2).not.toContain("<file");
  });

  test("listFiles 模糊搜索忽略 node_modules", () => {
    fs.mkdirSync(path.join(tmp, "node_modules/pkg"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "node_modules/pkg/x.ts"), "x");
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src/app.ts"), "x");
    const s = makeSession();
    const files = manager.listFiles(s.session_id, "app");
    expect(files).toContain(path.join("src", "app.ts"));
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });
});

describe("v0.4 F4 消息排队（Steering）", () => {
  test("busy 时入队，turn 结束自动出队执行；message.queued 事件落库", async () => {
    const s = makeSession();
    manager.postMessage(s.session_id, "!bash sleep 1");
    await waitFor(() => sessionEvents(s.session_id).some((e) => e.type === "approval.requested"));
    const ap = sessionEvents(s.session_id).find((e) => e.type === "approval.requested")!;
    const r = manager.postMessage(s.session_id, "排队的消息");
    expect(r.queued).toBe(true);
    expect(sessionEvents(s.session_id).some((e) => e.type === "message.queued")).toBe(true);
    // 批准 bash，turn 结束后队列应自动执行
    manager.resolveApproval(s.session_id, (ap.payload as { approval_id: string }).approval_id, { decision: "approve" });
    await waitFor(() =>
      sessionEvents(s.session_id).filter((e) => e.type === "message.user").length === 2,
    );
    await waitFor(() => sessionEvents(s.session_id).filter((e) => e.type === "turn.completed").length === 2);
    const userTexts = sessionEvents(s.session_id)
      .filter((e) => e.type === "message.user")
      .map((e) => (e.payload as { text: string }).text);
    expect(userTexts[1]).toBe("排队的消息");
  });

  test("cancelQueued 撤回后不再执行", async () => {
    const s = makeSession();
    manager.postMessage(s.session_id, "!bash sleep 1");
    await waitFor(() => sessionEvents(s.session_id).some((e) => e.type === "approval.requested"));
    manager.postMessage(s.session_id, "要撤回的");
    const queuedEvt = sessionEvents(s.session_id).find((e) => e.type === "message.queued")!;
    const qid = (queuedEvt.payload as { queue_id: string }).queue_id;
    expect(manager.cancelQueued(s.session_id, qid)).toBe(true);
    expect(sessionEvents(s.session_id).some((e) => e.type === "message.queue_cancelled")).toBe(true);
    const ap = sessionEvents(s.session_id).find((e) => e.type === "approval.requested")!;
    manager.resolveApproval(s.session_id, (ap.payload as { approval_id: string }).approval_id, { decision: "approve" });
    await waitFor(() => sessionEvents(s.session_id).some((e) => e.type === "turn.completed"));
    await new Promise((r) => setTimeout(r, 300));
    expect(sessionEvents(s.session_id).filter((e) => e.type === "message.user").length).toBe(1);
  });
});

describe("v0.4 F9 会话分叉", () => {
  test("fork 复制 [0, atSeq] 事件并落 session.forked", async () => {
    const s = makeSession();
    manager.postMessage(s.session_id, "第一轮");
    await waitFor(() => sessionEvents(s.session_id).some((e) => e.type === "turn.completed"));
    const atSeq = turnSeqs(s.session_id)[0];
    const fork = manager.fork(s.session_id, atSeq);
    const forkEvents = store.readSince(fork.session_id, -1);
    expect(forkEvents.some((e) => e.type === "session.forked")).toBe(true);
    expect(forkEvents.some((e) => e.type === "turn.completed")).toBe(false); // atSeq 之后不复制
    expect(forkEvents.some((e) => e.type === "turn.started")).toBe(true);
  });
});
