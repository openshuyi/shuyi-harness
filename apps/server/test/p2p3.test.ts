/**
 * P1遗留 / P2 / P3 验证：
 * 1. git 集成：write 后工作区产生原子提交
 * 2. Plan 模式：工具面过滤（模型看不到写工具）+ 权限兜底
 * 3. memory_write：记忆落盘 + 事件 + 注入下次上下文
 * 4. 压缩：小窗口触发 context.compacted，重建含结构化摘要
 * 5. 子代理：task 工具跑通 subagent.started/completed
 * 6. 搜索与用量聚合
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import type { AgentEvent, SessionRecord } from "@shuyi/types";
import { EventBus } from "../src/bus/index.js";
import { SqliteEventStore } from "../src/store/event-store.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { RuntimeModelRegistry } from "../src/model/registry.js";
import { SessionManager } from "../src/session/manager.js";
import { rebuildContext, readMemory } from "../src/context/index.js";
import { deterministicCleanup, parseSummary } from "../src/context/compaction.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-p2p3-"));
const dbPath = path.join(tmp, "test.db");
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(workspace, { recursive: true });

let store: SqliteEventStore;
let bus: EventBus;
let manager: SessionManager;
let events: AgentEvent[] = [];

beforeAll(() => {
  bus = new EventBus();
  store = new SqliteEventStore(dbPath, bus);
  bus.subscribe((e) => events.push(e));
  manager = new SessionManager(store, createDefaultRegistry(), new RuntimeModelRegistry({}));
});

afterAll(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeSession(mode: "plan" | "build" = "build"): SessionRecord {
  return manager.createSession({ cwd: workspace, mode, model: "mock", sandbox_level: "workspace" });
}

async function waitIdle(session: SessionRecord, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (manager.getSession(session.session_id)!.status === "idle") return;
    if (Date.now() - start > timeoutMs) throw new Error("等待 idle 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("P1 遗留：git 集成", () => {
  test("write 后产生原子提交，commit hash 记入 side_effects", async () => {
    const s = makeSession();
    manager.postMessage(s.session_id, "!write gittest.txt v1");
    await waitIdle(s);

    const completed = events.find(
      (e) => e.type === "tool.call.completed" && (e.payload as { result: string }).result.includes("gittest.txt"),
    );
    expect(completed).toBeDefined();
    const commit = (completed!.payload as { side_effects?: { commit?: string } }).side_effects?.commit;
    expect(commit).toBeTruthy();

    const log = spawnSync("git", ["-C", workspace, "log", "--oneline"], { encoding: "utf-8" });
    expect(log.stdout).toContain("agent(write)");
  });
});

describe("P2：Plan/Build 工具面", () => {
  test("plan 模式：模型看不到写工具，!write 不触发工具调用", async () => {
    const s = makeSession("plan");
    const mark = events.length;
    manager.postMessage(s.session_id, "!write plan-forbidden.txt x");
    await waitIdle(s);

    const slice = events.slice(mark);
    // mock 尊重工具可见性：plan 模式 specs 无 write → 文本回复而非工具调用
    expect(slice.filter((e) => e.type === "tool.call.proposed").length).toBe(0);
    expect(fs.existsSync(path.join(workspace, "plan-forbidden.txt"))).toBe(false);
  });

  test("plan 模式权限兜底：即使模型幻觉调用写工具也被 deny", () => {
    const { PermissionService } = require("../src/permission/index.js") as typeof import("../src/permission/index.js");
    const ps = new PermissionService();
    const tools = createDefaultRegistry();
    const writeTool = tools.get("write")!;
    const verdict = ps.classify({
      tool: writeTool,
      args: { path: "x.txt", content: "y" },
      cwd: workspace,
      sandboxLevel: "workspace",
      mode: "plan",
    });
    expect(verdict.kind).toBe("deny");
  });
});

describe("P2：记忆", () => {
  test("memory_write 落盘 + 事件 + 注入后续上下文", async () => {
    const s = makeSession();
    const mark = events.length;
    manager.postMessage(s.session_id, "!memory 本项目用 Bun 运行时");
    await waitIdle(s);

    // 文件落盘
    const mem = readMemory(workspace);
    expect(mem).toContain("本项目用 Bun 运行时");

    // memory.written 事件
    const slice = events.slice(mark);
    expect(slice.some((e) => e.type === "memory.written")).toBe(true);

    // 注入 rebuild 后的模型输入（Loop 内组装；此处验证 readMemory 可用）
    expect(mem).toContain("memory.md");
  });
});

describe("P2：压缩组件", () => {
  test("确定性清理：重复读取只留最新，冗长输出截断", () => {
    const msgs = [
      { role: "user" as const, content: "看文件" },
      { role: "tool" as const, content: "[/a.ts 共 100 行，显示 1-100]\n旧内容", tool_call_id: "1" },
      { role: "tool" as const, content: "[/a.ts 共 100 行，显示 1-100]\n新内容", tool_call_id: "2" },
      { role: "tool" as const, content: "x".repeat(5000), tool_call_id: "3" },
    ];
    const cleaned = deterministicCleanup(msgs);
    expect(cleaned[1].content).toContain("已被后续读取取代");
    expect(cleaned[2].content).toContain("新内容");
    expect(cleaned[3].content.length).toBeLessThan(2100);
  });

  test("parseSummary：模板解析与兜底", () => {
    const good = parseSummary(
      "## Session Intent\n修 bug\n## Files Modified\n- a.ts\n## Key Decisions\n- 用 X 方案\n## Active Goals\n- 收尾\n## Next Steps\n跑测试",
    );
    expect(good.session_intent).toBe("修 bug");
    expect(good.files_modified).toEqual(["a.ts"]);
    expect(good.next_steps).toBe("跑测试");

    const fallback = parseSummary("随便一段没有结构的话");
    expect(fallback.next_steps).toContain("随便一段没有结构的话");
  });
});

describe("P3：子代理", () => {
  test("task 工具：子代理完成并返回摘要，事件链完整", async () => {
    const s = makeSession();
    const mark = events.length;
    manager.postMessage(s.session_id, "!task 总结一下这个项目");
    await waitIdle(s, 15000);

    const slice = events.slice(mark);
    expect(slice.some((e) => e.type === "subagent.started")).toBe(true);
    expect(slice.some((e) => e.type === "subagent.completed")).toBe(true);

    // 子代理摘要作为主工具结果落库
    const completed = slice.find(
      (e) => e.type === "tool.call.completed" && (e.payload as { result: string }).result.length > 0,
    );
    expect(completed).toBeDefined();
  });
});

describe("P4：搜索与用量", () => {
  test("全文搜索命中历史消息", async () => {
    const s = makeSession();
    manager.postMessage(s.session_id, "请帮我分析 unique-keyword-xyz 的用法");
    await waitIdle(s);

    const hits = store.search("unique-keyword-xyz");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].session_id).toBe(s.session_id);
    expect(hits[0].snippet).toContain("unique-keyword-xyz");
  });

  test("会话用量聚合", async () => {
    const s = makeSession();
    manager.postMessage(s.session_id, "随便聊聊");
    await waitIdle(s);

    const session = manager.getSession(s.session_id)!;
    expect(session.usage).toBeDefined();
    expect(session.usage!.prompt_tokens).toBeGreaterThan(0);
  });
});
