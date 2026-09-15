/**
 * P8 验证（对齐 OpenCode / DeepSeek Harness）：
 * 1. Agent 定义系统：frontmatter 解析、内置/全局/项目三层合并与覆盖、子代理用自定义定义
 * 2. 自动标题：首轮完成后生成标题并落 session.titled 事件；auto_title=false 时跳过
 * 3. 项目级配置 shuyi.json：全局←项目合并、指令注入系统提示
 * 4. models.dev 元数据：解析 + enrich 只补空缺不覆盖显式配置
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SessionRecord } from "@shuyi/types";
import { EventBus } from "../src/bus/index.js";
import { SqliteEventStore } from "../src/store/event-store.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { RuntimeModelRegistry } from "../src/model/registry.js";
import { SessionManager } from "../src/session/manager.js";
import { rebuildContext } from "../src/context/index.js";
import { AgentRegistry, parseAgentMarkdown } from "../src/agents/index.js";
import { loadProjectConfig } from "../src/config/project.js";
import { parseModelsDev, enrichFromModelsDev } from "../src/model/modelsdev.js";
import { runSubagent } from "../src/loop/subagent.js";
import type { ChatRequest, ChatResult, ModelAdapter, ModelMeta } from "../src/model/types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-p8-"));
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(workspace, { recursive: true });

let store: SqliteEventStore;
let bus: EventBus;
let manager: SessionManager;

beforeAll(() => {
  bus = new EventBus();
  store = new SqliteEventStore(path.join(tmp, "test.db"), bus);
  manager = new SessionManager(store, createDefaultRegistry(), new RuntimeModelRegistry({}));
});

afterAll(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 记录请求的适配器：provider != local，可触发自动标题 */
class RecordingAdapter implements ModelAdapter {
  id = "rec";
  label = "Recording";
  meta: ModelMeta = { provider: "test", contextWindow: 128_000 };
  requests: ChatRequest[] = [];
  constructor(private reply: string) {}
  async streamChat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    return {
      text: this.reply,
      toolCalls: [],
      finishReason: "stop",
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    };
  }
}

async function waitIdle(m: SessionManager, s: SessionRecord, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (m.getSession(s.session_id)!.status === "idle") return;
    if (Date.now() - start > timeoutMs) throw new Error("等待 idle 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---------- P8-3：Agent 定义系统 ----------

describe("P8-3：Agent 定义系统", () => {
  test("frontmatter 解析：工具面三种形态 + 模型覆盖", () => {
    const readonly = parseAgentMarkdown(
      "---\nname: a\ndescription: 描述\ntools: readonly\n---\n系统提示正文",
      "user",
    );
    expect(readonly).toMatchObject({ name: "a", description: "描述", tools: "readonly", system: "系统提示正文" });

    const list = parseAgentMarkdown("---\nname: b\ntools: [read, grep]\nmodel: deepseek\n---\n只许读和搜", "project");
    expect(list).toMatchObject({ name: "b", tools: ["read", "grep"], model: "deepseek" });

    const none = parseAgentMarkdown("---\nname: c\ntools: none\n---\n无工具", "user");
    expect(none!.tools).toEqual([]);

    expect(parseAgentMarkdown("没有 frontmatter", "user")).toBeNull();
    expect(parseAgentMarkdown("---\ndescription: 缺 name\n---\n正文", "user")).toBeNull();
  });

  test("三层合并：项目覆盖全局覆盖内置", () => {
    const home = path.join(tmp, "home-agents");
    const cwd = path.join(tmp, "proj-agents");
    fs.mkdirSync(path.join(home, ".agent", "agents"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".agent", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".agent", "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: 评审\n---\n全局评审代理",
    );
    fs.writeFileSync(
      path.join(cwd, ".agent", "agents", "explore.md"),
      "---\nname: explore\n---\n项目定制的探索代理",
    );

    const reg = new AgentRegistry(home);
    expect(reg.get("reviewer", cwd)).toMatchObject({ source: "user", system: "全局评审代理" });
    // 项目同名覆盖内置 explore
    expect(reg.get("explore", cwd)).toMatchObject({ source: "project", system: "项目定制的探索代理" });
    // 不传 cwd 时回退内置
    expect(reg.get("explore")!.source).toBe("builtin");
    // 内置 title / summary 始终存在
    expect(reg.get("title")).toBeDefined();
    expect(reg.get("summary")).toBeDefined();
  });

  test("子代理使用自定义代理定义：系统提示与工具面生效", async () => {
    const s = manager.createSession({ cwd: workspace, mode: "build", model: "mock", sandbox_level: "workspace" });
    const rec = new RecordingAdapter("探索结论");
    const summary = await runSubagent(
      "任务A",
      "call-1",
      s,
      rec,
      createDefaultRegistry(),
      store,
      "turn-1",
      { name: "x", description: "", tools: [], system: "自定义角色提示", source: "project" },
    );
    expect(summary).toBe("探索结论");
    expect(rec.requests[0].system).toContain("自定义角色提示");
    expect(rec.requests[0].tools).toEqual([]); // tools: [] → 无工具面
  });
});

// ---------- P8-4：自动标题 ----------

describe("P8-4：自动标题", () => {
  test("首轮完成后生成标题并落 session.titled 事件", async () => {
    const rec = new RecordingAdapter("修复登录页样式错乱");
    const models = new RuntimeModelRegistry({});
    models.adapters.set("rec", rec);
    const m = new SessionManager(store, createDefaultRegistry(), models);
    const s = m.createSession({ cwd: workspace, mode: "build", model: "rec", sandbox_level: "workspace" });
    expect(s.title).toMatch(/^会话 /);

    m.postMessage(s.session_id, "帮我修复登录页样式错乱的问题");
    await waitIdle(m, s);

    // 标题生成在轮次结束后异步进行，轮询等待
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (!/^会话 \d/.test(m.getSession(s.session_id)!.title)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(m.getSession(s.session_id)!.title).toBe("修复登录页样式错乱");
    // 第二次调用是标题生成（系统提示来自内置 title 代理）
    expect(rec.requests.length).toBe(2);
    expect(rec.requests[1].system).toContain("标题");

    const titled = store
      .readSince(s.session_id, -1)
      .find((e) => e.type === "session.titled");
    expect(titled).toBeDefined();
    expect((titled!.payload as { title: string }).title).toBe("修复登录页样式错乱");
  });

  test("shuyi.json auto_title=false 时跳过标题生成", async () => {
    const cwd = path.join(tmp, "no-title");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, "shuyi.json"), JSON.stringify({ auto_title: false }));

    const rec = new RecordingAdapter("不应成为标题");
    const models = new RuntimeModelRegistry({});
    models.adapters.set("rec", rec);
    const m = new SessionManager(store, createDefaultRegistry(), models);
    const s = m.createSession({ cwd, mode: "build", model: "rec", sandbox_level: "workspace" });

    m.postMessage(s.session_id, "随便聊一句");
    await waitIdle(m, s);
    await new Promise((r) => setTimeout(r, 400)); // 给（不应发生的）标题生成留出时间

    expect(m.getSession(s.session_id)!.title).toMatch(/^会话 /);
    expect(rec.requests.length).toBe(1); // 只有轮次本身那一次调用
  });
});

// ---------- P8-5：项目级配置 shuyi.json ----------

describe("P8-5：项目级配置", () => {
  test("全局←项目合并：model 项目优先、instructions 拼接、permissions 合并", () => {
    const home = path.join(tmp, "home-cfg");
    const cwd = path.join(tmp, "proj-cfg");
    fs.mkdirSync(path.join(home, ".agent"), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(home, ".agent", "shuyi.json"),
      JSON.stringify({
        model: "global-model",
        instructions: "全局指令",
        permissions: { allow: ["read"] },
        auto_title: false,
      }),
    );
    fs.writeFileSync(
      path.join(cwd, "shuyi.json"),
      JSON.stringify({
        model: "project-model",
        instructions: ["项目指令一", "项目指令二"],
        permissions: { deny: ["bash"] },
      }),
    );

    const cfg = loadProjectConfig(cwd, home);
    expect(cfg.model).toBe("project-model");
    expect(cfg.instructions).toBe("全局指令\n\n项目指令一\n项目指令二");
    expect(cfg.permissions).toEqual({ allow: ["read"], deny: ["bash"] });
    expect(cfg.auto_title).toBe(false); // 全局生效（项目未覆盖）
  });

  test("损坏/缺失配置文件静默降级为空配置", () => {
    const cwd = path.join(tmp, "bad-cfg");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, "shuyi.json"), "{ 不是合法 json");
    expect(loadProjectConfig(cwd, path.join(tmp, "nonexistent-home"))).toEqual({});
  });

  test("项目指令注入系统提示", () => {
    const s = manager.createSession({ cwd: workspace, mode: "build", model: "mock", sandbox_level: "workspace" });
    const withSuffix = rebuildContext(store, s, [], "不要改动 src/legacy 目录");
    expect(withSuffix.system).toContain("## 项目指令\n不要改动 src/legacy 目录");
    const without = rebuildContext(store, s, []);
    expect(without.system).not.toContain("## 项目指令");
  });
});

// ---------- P8-6：models.dev 元数据 ----------

describe("P8-6：models.dev 元数据", () => {
  const sample = JSON.stringify({
    deepseek: {
      models: {
        "deepseek-chat": {
          limit: { context: 64000, output: 8192 },
          cost: { input: 0.27, output: 1.1, cache_read: 0.07 },
        },
      },
    },
    openai: {
      models: {
        "gpt-4o": { limit: { context: 128000 }, cost: { input: 2.5, output: 10 } },
      },
    },
  });

  test("解析：扁平映射含裸 id 与 provider/id 两种键", () => {
    const map = parseModelsDev(sample);
    expect(map.get("deepseek-chat")).toEqual({
      contextWindow: 64000,
      pricing: { input: 0.27, output: 1.1, cachedInput: 0.07 },
    });
    expect(map.get("openai/gpt-4o")!.contextWindow).toBe(128000);
  });

  test("enrich：只补空缺，不覆盖用户显式配置", async () => {
    const reg = new RuntimeModelRegistry({
      AGENT_MODELS:
        "ds|https://api.deepseek.com/v1|sk-x|deepseek-chat," +
        "ds2|https://api.deepseek.com/v1|sk-y|deepseek-chat|自定义|99999",
    });
    const n = await enrichFromModelsDev(reg, {
      fetcher: async () => sample,
      cacheFile: path.join(tmp, "modelsdev-cache.json"),
    });
    expect(n).toBe(2);

    const ds = reg.get("ds")!;
    expect(ds.meta.contextWindow).toBe(64000); // 空缺被补全
    expect(ds.meta.pricing).toEqual({ input: 0.27, output: 1.1, cachedInput: 0.07 });

    const ds2 = reg.get("ds2")!;
    expect(ds2.meta.contextWindow).toBe(99999); // 显式窗口不被覆盖
    expect(ds2.meta.pricing).toEqual({ input: 0.27, output: 1.1, cachedInput: 0.07 }); // 空缺定价被补全
  });

  test("enrich：拉取失败静默降级返回 0", async () => {
    const reg = new RuntimeModelRegistry({
      AGENT_MODELS: "x|https://example.com/v1|sk|unknown-model",
    });
    const n = await enrichFromModelsDev(reg, {
      fetcher: async () => {
        throw new Error("网络不可达");
      },
      cacheFile: path.join(tmp, "modelsdev-cache-2.json"),
    });
    expect(n).toBe(0);
    expect(reg.get("x")!.meta.contextWindow).toBe(128000); // 保持默认
  });
});
