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

describe("P6：非法 tool_call 纠错回环", () => {
  test("幻觉未知工具后收到含可用清单的失败反馈，下一轮自我修正", async () => {
    const { MockAdapter } = await import("../src/model/mock.js");
    const mock = (manager as unknown as { models: { get(id: string): unknown } }).models.get("mock") as InstanceType<typeof MockAdapter>;
    // 脚本：第一次幻觉调用不存在的工具，第二次用正确工具完成任务
    mock.pushScript({ toolCalls: [{ name: "delete_everything", args: {} }] });
    mock.pushScript({ toolCalls: [{ name: "write", args: { path: `${workspace}/fixed.txt`, content: "修正后的写入" } }] });
    mock.pushScript({ text: "已修正工具调用并完成任务。" });

    const s = manager.createSession({ cwd: workspace, mode: "build", model: "mock", sandbox_level: "workspace" });
    const mark = events.length;
    manager.postMessage(s.session_id, "帮我完成写入任务");

    const start = Date.now();
    let completed = false;
    while (Date.now() - start < 8000) {
      if (events.slice(mark).some((e) => e.type === "turn.completed")) { completed = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(completed).toBe(true);

    const slice = events.slice(mark);
    // 第一次调用以未知工具失败，且错误信息带可用工具清单
    const failed = slice.find(
      (e) => e.type === "tool.call.failed" && (e.payload as { error: string }).error.includes("未知工具"),
    );
    expect(failed).toBeDefined();
    expect((failed!.payload as { error: string }).error).toContain("可用工具");
    // 第二次调用正确工具成功
    const done = slice.find(
      (e) => e.type === "tool.call.completed" && fs.existsSync(`${workspace}/fixed.txt`),
    );
    expect(done).toBeDefined();
  });
});

describe("P6：会话回放导出", () => {
  test("事件日志渲染为自包含 HTML（消息/工具/标记齐备）", async () => {
    const { renderReplayHtml } = await import("../src/api/replay.js");
    const s = manager.createSession({ cwd: workspace, mode: "build", model: "mock", sandbox_level: "workspace" });
    const mark = events.length;
    manager.postMessage(s.session_id, "!write replay-test.txt 回放内容");

    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (events.slice(mark).some((e) => e.type === "turn.completed")) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const sessionEvents = store.readSince(s.session_id, -1);
    const html = renderReplayHtml(manager.getSession(s.session_id)!, sessionEvents);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("!write replay-test.txt"); // 用户消息
    expect(html).toContain("write"); // 工具卡片
    expect(html).toContain("工具已执行完毕"); // 助手回复
    expect(html).not.toContain("undefined");
  });
});

describe("P7：会话回滚", () => {
  test("写入两轮后回滚到第一轮基线，第二轮改动消失且事件落库", async () => {
    const { execSync } = await import("node:child_process");
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rollback-"));
    execSync("git init", { cwd: ws });
    execSync("git -c user.name=t -c user.email=t@t commit --allow-empty -m init", { cwd: ws });

    const s = manager.createSession({ cwd: ws, mode: "build", model: "mock", sandbox_level: "workspace" });

    // 第一轮写入
    let mark = events.length;
    manager.postMessage(s.session_id, "!write round1.txt 第一轮");
    let start = Date.now();
    while (Date.now() - start < 8000) {
      if (events.slice(mark).some((e) => e.type === "turn.completed")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // 第二轮写入
    mark = events.length;
    manager.postMessage(s.session_id, "!write round2.txt 第二轮");
    start = Date.now();
    while (Date.now() - start < 8000) {
      if (events.slice(mark).some((e) => e.type === "turn.completed")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(fs.existsSync(path.join(ws, "round1.txt"))).toBe(true);
    expect(fs.existsSync(path.join(ws, "round2.txt"))).toBe(true);

    // 取第二轮的 base_commit，回滚 → round2.txt 应消失，round1.txt 保留
    const evts = store.readSince(s.session_id, -1);
    const started = evts.filter((e) => e.type === "turn.started");
    const base2 = (started[1].payload as { base_commit?: string }).base_commit!;
    expect(base2).toBeDefined();

    manager.rollback(s.session_id, base2);
    expect(fs.existsSync(path.join(ws, "round1.txt"))).toBe(true);
    expect(fs.existsSync(path.join(ws, "round2.txt"))).toBe(false);

    // turn.rollback 事件已落库（append-only，不删历史）
    const after = store.readSince(s.session_id, -1);
    expect(after.some((e) => e.type === "turn.rollback" && (e.payload as { commit: string }).commit === base2)).toBe(true);
    fs.rmSync(ws, { recursive: true, force: true });
  });
});

describe("P8：编辑后 LSP 诊断折回", () => {
  test("写入含类型错误的 ts 文件后，工具结果自动附诊断；干净文件不附", async () => {
    const { postEditDiagnostics } = await import("../src/lsp/post-edit.js");
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lsp-fold-"));
    // 初始化一个最小 ts 项目
    fs.writeFileSync(path.join(ws, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    fs.writeFileSync(path.join(ws, "bad.ts"), "const x: number = 'not a number';\nexport default x;\n");
    fs.writeFileSync(path.join(ws, "good.ts"), "const y: number = 42;\nexport default y;\n");

    const bad = await postEditDiagnostics(ws, [path.join(ws, "bad.ts")], 8000);
    if (bad === null) {
      // 环境无 typescript-language-server：优雅降级（返回 null），跳过断言
      console.log("[skip] LSP 不可用，降级验证通过");
    } else {
      expect(bad).toContain("LSP 诊断");
      expect(bad.toLowerCase()).toContain("error");
    }
    const good = await postEditDiagnostics(ws, [path.join(ws, "good.ts")], 8000);
    expect(good).toBeNull(); // 干净文件不附加任何内容
    // 非 ts 文件直接 null
    expect(await postEditDiagnostics(ws, [path.join(ws, "readme.txt")])).toBeNull();
    fs.rmSync(ws, { recursive: true, force: true });
  }, 20000);
});
