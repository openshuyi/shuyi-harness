/**
 * P0-4：自定义斜杠命令 + AGENTS.md 自动加载。
 * - 命令 = ~/.agent/commands/*.md（全局）与 <cwd>/.agent/commands/*.md（项目，同名覆盖）
 * - $ARGUMENTS 占位符替换；无占位符参数追加末尾
 * - "/name args" 在 startTurn 展开为本轮用户消息；未命中按原文
 * - AGENTS.md（项目根 + 全局）注入系统提示，单文件 32KB 截断
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadCommands,
  matchCommandInput,
  expandCommand,
  tryExpandCommandInput,
} from "../src/commands/index.js";
import { loadAgentsMd } from "../src/config/project.js";
import { SqliteEventStore } from "../src/store/event-store.js";
import { EventBus } from "../src/bus/index.js";
import { SessionManager } from "../src/session/manager.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { RuntimeModelRegistry } from "../src/model/registry.js";
import type { AgentEvent } from "@shuyi/types";
import type { ChatRequest, ChatResult, ModelAdapter, StreamHandlers } from "../src/model/types.js";

let tmp: string;
let home: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p0-cmd-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, ".agent", "commands"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".agent", "commands"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("P0-4a 斜杠命令", () => {
  test("加载：frontmatter 解析、项目覆盖全局、非法文件名跳过", () => {
    fs.writeFileSync(
      path.join(home, ".agent", "commands", "review.md"),
      "---\ndescription: 全局评审\n---\n请评审：$ARGUMENTS",
    );
    fs.writeFileSync(
      path.join(tmp, ".agent", "commands", "review.md"),
      "---\ndescription: 项目评审\n---\n项目内评审：$ARGUMENTS",
    );
    fs.writeFileSync(path.join(tmp, ".agent", "commands", "fix.md"), "修复以下问题");
    fs.writeFileSync(path.join(tmp, ".agent", "commands", ".hidden.md"), "x"); // 非法名
    fs.writeFileSync(path.join(tmp, ".agent", "commands", "empty.md"), "---\n---\n"); // 空正文

    const cmds = loadCommands(tmp, home);
    const names = cmds.map((c) => c.name);
    expect(names).toEqual(["fix", "review"]);
    const review = cmds.find((c) => c.name === "review")!;
    expect(review.description).toBe("项目评审");
    expect(review.source).toBe("project");
    expect(review.template).toBe("项目内评审：$ARGUMENTS");
  });

  test("matchCommandInput / expandCommand", () => {
    expect(matchCommandInput("/review src/")).toEqual({ name: "review", args: "src/" });
    expect(matchCommandInput("/review")).toEqual({ name: "review", args: "" });
    expect(matchCommandInput("普通文本")).toBeNull();
    expect(matchCommandInput("/路径/含斜杠")).toBeNull();

    const withPlaceholder = { name: "r", description: "", template: "评审 $ARGUMENTS 完毕", source: "project" as const };
    expect(expandCommand(withPlaceholder, "src/")).toBe("评审 src/ 完毕");
    const noPlaceholder = { name: "r", description: "", template: "修复问题", source: "project" as const };
    expect(expandCommand(noPlaceholder, "登录页")).toBe("修复问题\n\n登录页");
    expect(expandCommand(noPlaceholder, "")).toBe("修复问题");
  });

  test("tryExpandCommandInput：未命中命令返回 null", () => {
    fs.writeFileSync(path.join(tmp, ".agent", "commands", "hi.md"), "打招呼：$ARGUMENTS");
    expect(tryExpandCommandInput("/hi 世界", tmp, home)?.expanded).toBe("打招呼：世界");
    expect(tryExpandCommandInput("/nonexist 参数", tmp, home)).toBeNull();
    expect(tryExpandCommandInput("hello", tmp, home)).toBeNull();
  });

  test("e2e：/review 展开为本轮用户消息", async () => {
    fs.writeFileSync(
      path.join(tmp, ".agent", "commands", "review.md"),
      "---\ndescription: 评审\n---\n请评审代码：$ARGUMENTS",
    );
    const bus = new EventBus();
    const store = new SqliteEventStore(path.join(tmp, "events.db"), bus);
    const events: AgentEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const manager = new SessionManager(store, createDefaultRegistry(), new RuntimeModelRegistry({}));
    const session = manager.createSession({
      cwd: tmp, mode: "build", model: "mock", sandbox_level: "workspace-write",
    });
    manager.postMessage(session.session_id, "/review src/index.ts");
    const start = Date.now();
    while (!events.some((e) => e.type === "turn.completed")) {
      if (Date.now() - start > 6000) throw new Error("超时");
      await new Promise((r) => setTimeout(r, 20));
    }
    const userMsg = events.find((e) => e.type === "message.user");
    expect((userMsg!.payload as { text: string }).text).toBe("请评审代码：src/index.ts");
  });

  test("e2e：未定义的 /xxx 按原文发送", async () => {
    const bus = new EventBus();
    const store = new SqliteEventStore(path.join(tmp, "e2.db"), bus);
    const events: AgentEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const manager = new SessionManager(store, createDefaultRegistry(), new RuntimeModelRegistry({}));
    const session = manager.createSession({
      cwd: tmp, mode: "build", model: "mock", sandbox_level: "workspace-write",
    });
    manager.postMessage(session.session_id, "/unknown 保持原样");
    const start = Date.now();
    while (!events.some((e) => e.type === "turn.completed")) {
      if (Date.now() - start > 6000) throw new Error("超时");
      await new Promise((r) => setTimeout(r, 20));
    }
    const userMsg = events.find((e) => e.type === "message.user");
    expect((userMsg!.payload as { text: string }).text).toBe("/unknown 保持原样");
  });
});

describe("P0-4b AGENTS.md 自动加载", () => {
  test("loadAgentsMd：项目 + 全局拼接；不存在返回 undefined", () => {
    expect(loadAgentsMd(tmp, home)).toBeUndefined();
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "项目约定：全部测试用 bun test");
    fs.mkdirSync(path.join(home, ".agent"), { recursive: true });
    fs.writeFileSync(path.join(home, ".agent", "AGENTS.md"), "全局约定：中文回复");
    const text = loadAgentsMd(tmp, home)!;
    expect(text).toContain("AGENTS.md（项目根）");
    expect(text).toContain("项目约定：全部测试用 bun test");
    expect(text).toContain("AGENTS.md（全局）");
    expect(text).toContain("全局约定：中文回复");
  });

  test("loadAgentsMd：超长截断", () => {
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "x".repeat(40 * 1024));
    const text = loadAgentsMd(tmp, home)!;
    expect(text.length).toBeLessThan(34 * 1024);
    expect(text).toContain("已截断");
  });

  test("e2e：AGENTS.md 注入系统提示", async () => {
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "本项目一律使用 Vitest 之外的 bun test");
    // 捕获系统提示的间谍适配器
    let capturedSystem = "";
    const spy: ModelAdapter = {
      id: "spy",
      label: "spy",
      meta: { provider: "local", contextWindow: 128_000 },
      async streamChat(req: ChatRequest, _h: StreamHandlers, _s: AbortSignal): Promise<ChatResult> {
        capturedSystem = req.system;
        return { text: "好的", toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
    };
    const bus = new EventBus();
    const store = new SqliteEventStore(path.join(tmp, "e3.db"), bus);
    const events: AgentEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const models = new RuntimeModelRegistry({});
    models.adapters.set("spy", spy);
    const manager = new SessionManager(store, createDefaultRegistry(), models);
    const session = manager.createSession({
      cwd: tmp, mode: "build", model: "spy", sandbox_level: "workspace-write",
    });
    manager.postMessage(session.session_id, "你好");
    const start = Date.now();
    while (!events.some((e) => e.type === "turn.completed")) {
      if (Date.now() - start > 6000) throw new Error("超时");
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(capturedSystem).toContain("本项目一律使用 Vitest 之外的 bun test");
  });
});
