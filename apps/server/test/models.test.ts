/**
 * P5：模型层测试
 * - AGENT_MODELS 扩展字段解析（label/contextWindow/pricing）
 * - 配置文件加载与运行时增删持久化
 * - OpenAI 适配器：429/5xx 指数退避重试、不可重试错误快速失败
 * - 成本估算（含缓存命中价）
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildModelRegistry, estimateCost } from "../src/model/index.js";
import { RuntimeModelRegistry, resolveWithFallback } from "../src/model/registry.js";
import { OpenAICompatAdapter, ModelRequestError } from "../src/model/openai.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-models-"));

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("P5：模型注册表", () => {
  test("AGENT_MODELS 解析扩展字段（label/contextWindow/pricing）", () => {
    const reg = buildModelRegistry({
      AGENT_MODELS:
        "deepseek|https://api.deepseek.com/v1|sk-x|deepseek-chat|DeepSeek V3|64000|0.27|1.10|0.07",
    });
    const ds = reg.adapters.get("deepseek")!;
    expect(ds).toBeDefined();
    expect(ds.label).toBe("DeepSeek V3");
    expect(ds.meta.provider).toBe("openai-compatible");
    expect(ds.meta.contextWindow).toBe(64000);
    expect(ds.meta.pricing).toEqual({ input: 0.27, output: 1.1, cachedInput: 0.07 });
    expect(reg.defaultModel).toBe("deepseek"); // 首个真实模型为默认
  });

  test("旧格式（4 字段）向后兼容", () => {
    const reg = buildModelRegistry({
      AGENT_MODELS: "openai|https://api.openai.com/v1|sk-y|gpt-4o",
    });
    const m = reg.adapters.get("openai")!;
    expect(m.label).toBe("openai (gpt-4o)");
    expect(m.meta.contextWindow).toBe(128_000); // 默认
    expect(m.meta.pricing).toBeUndefined();
  });

  test("运行时增删 + 持久化到配置文件", () => {
    const configFile = path.join(tmp, "models.json");
    const reg = new RuntimeModelRegistry({}, configFile);
    expect(reg.list().map((m) => m.id)).toEqual(["mock"]);

    reg.add({
      id: "deepseek",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      model: "deepseek-chat",
      pricing: { input: 0.27, output: 1.1 },
      makeDefault: true,
    });
    expect(reg.defaultModel).toBe("deepseek");
    expect(fs.existsSync(configFile)).toBe(true);

    // 新实例从配置文件恢复
    const reg2 = new RuntimeModelRegistry({}, configFile);
    const item = reg2.list().find((m) => m.id === "deepseek")!;
    expect(item).toBeDefined();
    expect(item.provider).toBe("openai-compatible");
    expect(item.pricing?.input).toBe(0.27);
    expect(item.source).toBe("file");

    // 删除并持久化
    reg2.remove("deepseek");
    const reg3 = new RuntimeModelRegistry({}, configFile);
    expect(reg3.list().find((m) => m.id === "deepseek")).toBeUndefined();
  });

  test("env 来源模型不可删除；mock 不可删除", () => {
    const reg = new RuntimeModelRegistry({
      AGENT_MODELS: "openai|https://api.openai.com/v1|sk-y|gpt-4o",
    });
    expect(() => reg.remove("openai")).toThrow(/环境变量/);
    expect(() => reg.remove("mock")).toThrow(/内置/);
  });

  test("fallback：首选缺失时顺延到链上下一个", () => {
    const reg = new RuntimeModelRegistry({}, path.join(tmp, "m2.json"));
    reg.add({ id: "backup", baseURL: "https://x/v1", apiKey: "k", model: "m" });
    const adapter = resolveWithFallback(reg, "nonexistent", ["backup"]);
    expect(adapter.id).toBe("backup");
    // 全缺失时回退 mock
    expect(resolveWithFallback(reg, "a", ["b"]).id).toBe("mock");
  });
});

describe("P5：成本估算", () => {
  test("按定价计算（含缓存命中价）", () => {
    const pricing = { input: 1.0, output: 2.0, cachedInput: 0.1 };
    // 100 万输入（其中 50 万缓存命中）+ 50 万输出
    const cost = estimateCost(
      { prompt_tokens: 1_000_000, completion_tokens: 500_000, cached_tokens: 500_000 },
      pricing,
    );
    // 0.5M*1.0 + 0.5M*0.1 + 0.5M*2.0 = 0.5 + 0.05 + 1.0
    expect(cost).toBeCloseTo(1.55, 6);
  });

  test("无定价返回 undefined", () => {
    expect(estimateCost({ prompt_tokens: 1, completion_tokens: 1 }, undefined)).toBeUndefined();
  });
});

describe("P5：OpenAI 适配器重试", () => {
  let server: ReturnType<typeof Bun.serve>;
  let port: number;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("not implemented", { status: 404 });
      },
    });
    port = server.port;
  });

  afterAll(() => {
    server.stop();
  });

  function makeAdapter(): OpenAICompatAdapter {
    return new OpenAICompatAdapter({
      id: "t",
      label: "t",
      baseURL: `http://127.0.0.1:${port}`,
      apiKey: "k",
      model: "m",
    });
  }

  test("429 限流：按指数退避重试后成功", async () => {
    let calls = 0;
    const srv = Bun.serve({
      port: 0,
      async fetch() {
        calls++;
        if (calls < 3) return new Response("rate limited", { status: 429 });
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const adapter = new OpenAICompatAdapter({
        id: "t",
        label: "t",
        baseURL: `http://127.0.0.1:${srv.port}`,
        apiKey: "k",
        model: "m",
      });
      const result = await adapter.streamChat(
        { model: "m", system: "s", messages: [{ role: "user", content: "hi" }], tools: [] },
        {},
        new AbortController().signal,
      );
      expect(result.text).toBe("ok");
      expect(calls).toBe(3); // 两次 429 后第三次成功
    } finally {
      srv.stop();
    }
  });

  test("401 认证错误：不可重试，立即失败", async () => {
    let calls = 0;
    const srv = Bun.serve({
      port: 0,
      fetch() {
        calls++;
        return new Response("unauthorized", { status: 401 });
      },
    });
    try {
      const adapter = new OpenAICompatAdapter({
        id: "t",
        label: "t",
        baseURL: `http://127.0.0.1:${srv.port}`,
        apiKey: "bad",
        model: "m",
      });
      await expect(
        adapter.streamChat(
          { model: "m", system: "s", messages: [{ role: "user", content: "hi" }], tools: [] },
          {},
          new AbortController().signal,
        ),
      ).rejects.toThrow(ModelRequestError);
      expect(calls).toBe(1); // 不重试
    } finally {
      srv.stop();
    }
  });

  // 退避总耗时约 7s，显式放宽超时
  test("持续 500：重试到上限后抛出", { timeout: 15000 }, async () => {
    let calls = 0;
    const srv = Bun.serve({
      port: 0,
      fetch() {
        calls++;
        return new Response("boom", { status: 500 });
      },
    });
    try {
      const adapter = new OpenAICompatAdapter({
        id: "t",
        label: "t",
        baseURL: `http://127.0.0.1:${srv.port}`,
        apiKey: "k",
        model: "m",
      });
      await expect(
        adapter.streamChat(
          { model: "m", system: "s", messages: [{ role: "user", content: "hi" }], tools: [] },
          {},
          new AbortController().signal,
        ),
      ).rejects.toThrow(/500/);
      expect(calls).toBe(4); // MAX_ATTEMPTS
    } finally {
      srv.stop();
    }
  });

  test("ModelRequestError 携带 retryable 标记", async () => {
    const adapter = makeAdapter();
    try {
      await adapter.streamChat(
        { model: "m", system: "s", messages: [{ role: "user", content: "hi" }], tools: [] },
        {},
        new AbortController().signal,
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ModelRequestError);
      expect((err as ModelRequestError).status).toBe(404);
      expect((err as ModelRequestError).retryable).toBe(false);
    }
  });
});
