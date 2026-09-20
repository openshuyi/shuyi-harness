/**
 * M2 代理配置化测试。
 * 对应文档：《编码智能体-v0.3设计-能力追赶计划.md》§M2 验收：
 * - e2e：切换 plan 代理后 write 工具在工具面消失（等价旧 Plan 模式行为）
 * - e2e：!task xxx 指定自定义代理，子代理使用其 prompt/模型
 * - 单元：优先级 runtime > project > builtin；内置不可覆盖（同名 project 报错提示改名）
 * 另覆盖：runtime 持久化（~/.agent/agents.json）、SQLite ALTER TABLE ADD COLUMN 迁移、
 * 事件 payload 只增加可选 agent 字段。
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "bun:sqlite";
import type { AgentEvent, SessionRecord } from "@shuyi/types";
import { EventBus } from "../src/bus/index.js";
import { SqliteEventStore } from "../src/store/event-store.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { RuntimeModelRegistry } from "../src/model/registry.js";
import type { MockAdapter } from "../src/model/mock.js";
import { SessionManager } from "../src/session/manager.js";
import { AgentRegistry, parseAgentMarkdown } from "../src/agents/index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-m2-"));
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(workspace, { recursive: true });

// ---------- 单元：注册表优先级与 runtime 持久化 ----------
describe("M2 单元：AgentRegistry", () => {
  const home = path.join(tmp, "home");
  const cwd = path.join(tmp, "proj");

  beforeAll(() => {
    fs.mkdirSync(path.join(home, ".agent", "agents"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".agent", "agents"), { recursive: true });
  });

  test("优先级：runtime > project > user；内置不可覆盖", () => {
    fs.writeFileSync(path.join(home, ".agent", "agents", "helper.md"), "---\nname: helper\n---\n全局版");
    fs.writeFileSync(path.join(cwd, ".agent", "agents", "helper.md"), "---\nname: helper\n---\n项目版");

    const reg = new AgentRegistry(home);
    // user 层
    expect(reg.get("helper")!.system).toBe("全局版");
    // project 覆盖 user
    expect(reg.get("helper", cwd)!.system).toBe("项目版");
    // runtime 覆盖 project
    reg.upsertRuntime({ name: "helper", description: "", tools: "all", system: "运行时版" });
    expect(reg.get("helper", cwd)!).toMatchObject({ system: "运行时版", source: "runtime" });
    // 内置不可被 runtime 覆盖
    expect(() => reg.upsertRuntime({ name: "build", description: "", tools: "all", system: "x" })).toThrow(
      "内置代理",
    );
    expect(reg.get("build", cwd)!.source).toBe("builtin");
  });

  test("runtime 持久化：写入 ~/.agent/agents.json，新实例重载仍在", () => {
    const reg = new AgentRegistry(home);
    reg.upsertRuntime({
      name: "reviewer-pro",
      description: "评审专家",
      tools: ["read", "grep"],
      model: "deepseek",
      system: "你是评审专家",
      modeDefault: "plan",
    });
    const file = path.join(home, ".agent", "agents.json");
    expect(fs.existsSync(file)).toBe(true);

    const reg2 = new AgentRegistry(home);
    expect(reg2.get("reviewer-pro", cwd)).toMatchObject({
      source: "runtime",
      tools: ["read", "grep"],
      model: "deepseek",
      modeDefault: "plan",
    });
    // 删除：runtime 可删；内置不可删
    reg2.removeRuntime("reviewer-pro");
    expect(reg2.get("reviewer-pro", cwd)).toBeUndefined();
    expect(() => reg2.removeRuntime("build")).toThrow("只读");
    expect(() => reg2.removeRuntime("不存在")).toThrow("不存在");
  });

  test("frontmatter 扩展：mode 字段（plan 代理等价旧 plan 模式）", () => {
    const a = parseAgentMarkdown("---\nname: p\ntools: readonly\nmode: plan\n---\n只读计划", "project");
    expect(a).toMatchObject({ name: "p", modeDefault: "plan", tools: "readonly" });
    const b = parseAgentMarkdown("---\nname: q\n---\n无 mode 字段", "project");
    expect(b!.modeDefault).toBeUndefined();
  });

  test("工具面过滤：模式 × 代理 tools 声明", () => {
    const tools = createDefaultRegistry();
    const names = (specs: { name: string }[]) => specs.map((s) => s.name);
    // build + 无代理声明 → 全量（含 write/edit/bash）
    expect(names(tools.toModelSpecs("build"))).toContain("write");
    // plan 模式 → 只读（旧语义不变）
    const plan = names(tools.toModelSpecs("plan"));
    expect(plan).not.toContain("write");
    expect(plan).not.toContain("bash");
    expect(plan).toContain("read");
    // build + readonly 代理 → 只读
    expect(names(tools.toModelSpecs("build", "readonly"))).not.toContain("write");
    // build + 白名单 → 交集
    expect(names(tools.toModelSpecs("build", ["read", "grep"]))).toEqual(["read", "grep"]);
    // build + all → 全量
    expect(names(tools.toModelSpecs("build", "all"))).toContain("write");
  });
});

// ---------- 单元：SQLite 迁移与事件 ----------
describe("M2 单元：会话绑定持久化", () => {
  test("旧库迁移：无 agent 列的 v0.2 库打开后 ALTER TABLE ADD COLUMN，数据完好", () => {
    const dbPath = path.join(tmp, "legacy.db");
    // 手工构造 v0.2 旧 schema（无 agent 列）
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, title TEXT NOT NULL, cwd TEXT NOT NULL,
      mode TEXT NOT NULL, model TEXT NOT NULL, sandbox_level TEXT NOT NULL,
      created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      forked_from TEXT, caller_identity TEXT NOT NULL DEFAULT 'local-user'
    );`);
    raw.exec(`CREATE TABLE events (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
      ts INTEGER NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL,
      turn_id TEXT, causation_id TEXT, payload TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    ) WITHOUT ROWID;`);
    raw.query(
      `INSERT INTO sessions (session_id, title, cwd, mode, model, sandbox_level, created_at, archived, forked_from, caller_identity)
       VALUES ('legacy-1', '旧会话', '/tmp', 'build', 'mock', 'workspace', 1, 0, NULL, 'local-user')`,
    ).run();
    raw.close();

    // 用新代码打开旧库：迁移后读写正常
    const store = new SqliteEventStore(dbPath, new EventBus());
    const legacy = store.getSession("legacy-1")!;
    expect(legacy.title).toBe("旧会话");
    expect(legacy.agent).toBeUndefined();
    // 迁移后可写入 agent
    store.updateSessionConfig("legacy-1", { agent: "plan" });
    expect(store.getSession("legacy-1")!.agent).toBe("plan");
    store.close();
  });

  test("session.created / config_changed 事件携带可选 agent 字段（只增不改）", () => {
    const store = new SqliteEventStore(path.join(tmp, "bind.db"), new EventBus());
    const manager = new SessionManager(store, createDefaultRegistry(), new RuntimeModelRegistry({}), new AgentRegistry(path.join(tmp, "home")));
    const s = manager.createSession({
      cwd: workspace, mode: "build", model: "mock", sandbox_level: "workspace", agent: "plan",
    });
    expect(s.agent).toBe("plan");
    const created = store.readSince(s.session_id, -1).find((e) => e.type === "session.created")!;
    expect((created.payload as { agent?: string }).agent).toBe("plan");

    manager.updateConfig(s.session_id, { agent: "build" });
    const changed = store.readSince(s.session_id, -1).find((e) => e.type === "session.config_changed")!;
    expect((changed.payload as { agent?: string }).agent).toBe("build");
    expect(store.getSession(s.session_id)!.agent).toBe("build");
    store.close();
  });
});

// ---------- e2e：代理驱动的工具面 / 子代理 ----------
describe("M2 e2e：代理生效", () => {
  let store: SqliteEventStore;
  let manager: SessionManager;
  let models: RuntimeModelRegistry;
  let agents: AgentRegistry;
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

  /** 捕获 mock 适配器收到的全部请求 */
  function captureRequests() {
    const mock = models.get("mock") as MockAdapter;
    const original = mock.streamChat.bind(mock);
    const reqs: { system: string; tools: string[] }[] = [];
    mock.streamChat = async (req, handlers, signal) => {
      reqs.push({ system: req.system, tools: req.tools.map((t) => t.name) });
      return original(req, handlers, signal);
    };
    return { reqs, restore: () => { mock.streamChat = original; } };
  }

  beforeAll(() => {
    const bus = new EventBus();
    store = new SqliteEventStore(path.join(tmp, "e2e.db"), bus);
    bus.subscribe((e) => events.push(e));
    models = new RuntimeModelRegistry({});
    agents = new AgentRegistry(path.join(tmp, "home"));
    manager = new SessionManager(store, createDefaultRegistry(), models, agents);
    session = manager.createSession({ cwd: workspace, mode: "build", model: "mock", sandbox_level: "workspace" });
  });

  afterAll(() => {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("切换 plan 代理后 write 工具在工具面消失（等价旧 Plan 模式）", async () => {
    const cap = captureRequests();
    try {
      // 默认（build）：工具面含 write
      let mark = events.length;
      manager.postMessage(session.session_id, "你好");
      await waitForTurnEnd(mark);
      expect(cap.reqs[cap.reqs.length - 1].tools).toContain("write");

      // 切换 plan 代理：write/edit/bash 消失，只读工具保留
      manager.updateConfig(session.session_id, { agent: "plan" });
      mark = events.length;
      manager.postMessage(session.session_id, "分析一下");
      await waitForTurnEnd(mark);
      const planReq = cap.reqs[cap.reqs.length - 1];
      expect(planReq.tools).not.toContain("write");
      expect(planReq.tools).not.toContain("edit");
      expect(planReq.tools).not.toContain("bash");
      expect(planReq.tools).toContain("read");
      // 代理 prompt 注入系统提示
      expect(planReq.system).toContain("## 代理角色（plan）");
      expect(planReq.system).toContain("只读分析");

      // 切回 build 代理：工具面恢复
      manager.updateConfig(session.session_id, { agent: "build" });
      mark = events.length;
      manager.postMessage(session.session_id, "继续");
      await waitForTurnEnd(mark);
      expect(cap.reqs[cap.reqs.length - 1].tools).toContain("write");
    } finally {
      cap.restore();
    }
  });

  test("plan 代理下写操作被权限兜底拒绝（fail-closed 双保险）", async () => {
    manager.updateConfig(session.session_id, { agent: "plan" });
    // 用脚本强制模型发起 write 调用（绕过工具面，模拟模型幻觉）
    const mock = models.get("mock") as MockAdapter;
    mock.pushScript({ toolCalls: [{ name: "write", args: { path: "evil.txt", content: "x" } }] });
    const mark = events.length;
    manager.postMessage(session.session_id, "触发脚本");
    await waitForTurnEnd(mark);

    const failed = events.slice(mark).find((e) => e.type === "tool.call.failed");
    expect(failed).toBeDefined();
    expect((failed!.payload as { error: string }).error).toContain("Plan 模式只读");
    expect(fs.existsSync(path.join(workspace, "evil.txt"))).toBe(false);
    manager.updateConfig(session.session_id, { agent: "build" });
  });

  test("!task 指定自定义代理：子代理使用其 prompt", async () => {
    agents.upsertRuntime({
      name: "custom-explorer",
      description: "自定义探索",
      tools: "readonly",
      system: "自定义代理提示语XYZ",
    });
    const cap = captureRequests();
    try {
      const mock = models.get("mock") as MockAdapter;
      mock.pushScript({ toolCalls: [{ name: "task", args: { prompt: "调查代码结构", agent: "custom-explorer" } }] });
      const mark = events.length;
      manager.postMessage(session.session_id, "派发子任务");
      await waitForTurnEnd(mark);

      // 子代理的模型调用使用了自定义代理的 system prompt
      expect(cap.reqs.some((r) => r.system.includes("自定义代理提示语XYZ"))).toBe(true);
      const types = events.slice(mark).map((e) => e.type);
      expect(types).toContain("subagent.started");
      expect(types).toContain("subagent.completed");
    } finally {
      cap.restore();
      agents.removeRuntime("custom-explorer");
    }
  });

  test("创建会话时绑定代理：session.created 携带 agent 且首轮生效", async () => {
    const cap = captureRequests();
    try {
      const s2 = manager.createSession({
        cwd: workspace, mode: "build", model: "mock", sandbox_level: "workspace", agent: "plan",
      });
      const mark = events.length;
      manager.postMessage(s2.session_id, "hello");
      const start = Date.now();
      for (;;) {
        const done = events.slice(mark).some((e) => e.type === "turn.completed" || e.type === "turn.aborted");
        if (done && manager.getSession(s2.session_id)!.status === "idle") break;
        if (Date.now() - start > 8000) throw new Error("等待轮次结束超时");
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(cap.reqs[cap.reqs.length - 1].tools).not.toContain("write");
      expect(cap.reqs[cap.reqs.length - 1].system).toContain("## 代理角色（plan）");
    } finally {
      cap.restore();
    }
  });
});
