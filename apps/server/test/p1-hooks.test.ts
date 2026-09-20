/**
 * P1-5：Hook 机制——.agent/hooks/ 可执行文件，shuyi.json hooks:true 显式开启。
 * - tool.execute.before：非零退出阻止工具（fail-closed），stderr 折回模型
 * - tool.execute.after：纯观测不阻塞
 * - 默认关闭：有 hook 文件但未开配置 → 不执行
 * - hook.executed 审计事件落库
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findHooks, runHook, runBeforeHooks, runObserveHooks, hooksPresent } from "../src/hooks/index.js";
import { SqliteEventStore } from "../src/store/event-store.js";
import { EventBus } from "../src/bus/index.js";
import { SessionManager } from "../src/session/manager.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { RuntimeModelRegistry } from "../src/model/registry.js";
import type { AgentEvent } from "@shuyi/types";

let tmp: string;
let home: string;

function writeHook(root: string, point: string, script: string): string {
  const dir = path.join(root, ".agent", "hooks");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, point);
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p1-hooks-"));
  home = path.join(tmp, "home");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("P1-5 hook 单元", () => {
  test("findHooks：全局 + 项目都收，先全局后项目", () => {
    const g = writeHook(home, "tool.execute.before", "#!/bin/sh\nexit 0\n");
    const p = writeHook(tmp, "tool.execute.before", "#!/bin/sh\nexit 0\n");
    writeHook(tmp, "event", "#!/bin/sh\nexit 0\n");
    expect(findHooks("tool.execute.before", tmp, home)).toEqual([g, p]);
    expect(hooksPresent(tmp, home)).toBe(true);
    expect(hooksPresent(path.join(tmp, "empty"), path.join(tmp, "empty-home"))).toBe(false);
  });

  test("runHook：stdin 收到 JSON；退出码/stdout/stderr/耗时可读", async () => {
    const hook = writeHook(tmp, "tool.execute.before", "#!/bin/sh\nread line\necho \"got:$line\"\nexit 0\n");
    const r = await runHook(hook, "tool.execute.before", { tool: "write" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('"tool":"write"');
    expect(r.timedOut).toBe(false);
  });

  test("runBeforeHooks：非零退出即阻止，stderr 为原因；后续 hook 不再执行", async () => {
    writeHook(home, "tool.execute.before", "#!/bin/sh\ncat > /dev/null\necho '禁止写生产配置' >&2\nexit 1\n");
    const marker = path.join(tmp, "second-ran");
    writeHook(tmp, "tool.execute.before", `#!/bin/sh\ntouch ${marker}\nexit 0\n`);
    const { runs, blocked } = await runBeforeHooks(tmp, { tool: "write" }, home);
    expect(runs.length).toBe(1); // 第一个即阻止，短路
    expect(blocked).toContain("禁止写生产配置");
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("runHook：不可执行文件返回错误结果而不抛出（fail-closed）", async () => {
    const dir = path.join(tmp, ".agent", "hooks");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "tool.execute.before");
    fs.writeFileSync(file, "#!/bin/sh\nexit 0\n"); // 无执行位
    const r = await runHook(file, "tool.execute.before", {});
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test("runHook：超时强制终止", async () => {
    const hook = writeHook(tmp, "event", "#!/bin/sh\nsleep 30\n");
    const r = await runHook(hook, "event", {});
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
  }, 15000);

  test("runObserveHooks：观测钩子失败不抛出", async () => {
    writeHook(tmp, "tool.execute.after", "#!/bin/sh\nexit 3\n");
    const runs = await runObserveHooks("tool.execute.after", tmp, {});
    expect(runs.length).toBe(1);
    expect(runs[0].exitCode).toBe(3);
  });
});

describe("P1-5 hook e2e", () => {
  async function runStack(opts: { hooksConfig: boolean }) {
    const bus = new EventBus();
    const store = new SqliteEventStore(path.join(tmp, `events-${Math.random()}.db`), bus);
    const events: AgentEvent[] = [];
    bus.subscribe((e) => events.push(e));
    if (opts.hooksConfig) {
      fs.writeFileSync(path.join(tmp, "shuyi.json"), JSON.stringify({ hooks: true }));
    }
    const manager = new SessionManager(store, createDefaultRegistry(), new RuntimeModelRegistry({}));
    const session = manager.createSession({
      cwd: tmp, mode: "build", model: "mock", sandbox_level: "workspace-write",
    });
    return { store, events, manager, session };
  }

  async function waitTurn(events: AgentEvent[], mark: number): Promise<void> {
    const start = Date.now();
    while (!events.slice(mark).some((e) => e.type === "turn.completed")) {
      if (Date.now() - start > 8000) throw new Error("超时");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  test("before hook 阻止 write：tool.call.failed [Hook 阻止] + hook.executed 审计", async () => {
    writeHook(tmp, "tool.execute.before", "#!/bin/sh\ncat > /dev/null\necho '策略：禁止写 README' >&2\nexit 1\n");
    const { events, manager, session } = await runStack({ hooksConfig: true });
    const mark = events.length;
    manager.postMessage(session.session_id, "!write README.md hello");
    await waitTurn(events, mark);
    const slice = events.slice(mark);
    const failed = slice.find((e) => e.type === "tool.call.failed");
    expect((failed!.payload as { error: string }).error).toContain("[Hook 阻止]");
    expect((failed!.payload as { error: string }).error).toContain("禁止写 README");
    expect(fs.existsSync(path.join(tmp, "README.md"))).toBe(false); // 未执行
    const audit = slice.find((e) => e.type === "hook.executed");
    expect(audit).toBeDefined();
    expect((audit!.payload as { point: string }).point).toBe("tool.execute.before");
    expect((audit!.payload as { blocked_reason?: string }).blocked_reason).toContain("禁止写 README");
  });

  test("after hook 观测：执行完成后触发，ok=true", async () => {
    const logFile = path.join(tmp, "after.log");
    writeHook(tmp, "tool.execute.after", `#!/bin/sh\ncat >> ${logFile}\necho "" >> ${logFile}\nexit 0\n`);
    const { events, manager, session } = await runStack({ hooksConfig: true });
    const mark = events.length;
    manager.postMessage(session.session_id, "!read shuyi.json");
    await waitTurn(events, mark);
    // after hook 在 turn.completed 前执行（await），日志应已落盘
    expect(fs.existsSync(logFile)).toBe(true);
    const log = fs.readFileSync(logFile, "utf-8");
    expect(log).toContain('"tool":"read"');
    expect(log).toContain('"ok":true');
    const audit = events.slice(mark).filter((e) => e.type === "hook.executed");
    expect(audit.some((e) => (e.payload as { point: string }).point === "tool.execute.after")).toBe(true);
  });

  test("默认关闭：有 hook 文件但 shuyi.json 未开 hooks → 不执行", async () => {
    const marker = path.join(tmp, "hook-ran");
    writeHook(tmp, "tool.execute.before", `#!/bin/sh\ntouch ${marker}\nexit 0\n`);
    const { events, manager, session } = await runStack({ hooksConfig: false });
    const mark = events.length;
    manager.postMessage(session.session_id, "!write a.txt content");
    await waitTurn(events, mark);
    expect(fs.existsSync(marker)).toBe(false); // hook 未运行
    expect(fs.existsSync(path.join(tmp, "a.txt"))).toBe(true); // 工具正常执行
    expect(events.slice(mark).some((e) => e.type === "hook.executed")).toBe(false);
  });
});
