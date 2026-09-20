/**
 * P1-8：websearch 多 provider（tavily / exa / duckduckgo 免密）+ 主源失败自动降级。
 */
import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWebsearchTool } from "../src/tools/web.js";
import { loadNetConfig, defaultNetConfig } from "../src/config/net.js";

const DDG_HTML = `<html><body>
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=xyz">Example A</a>
<a class="result__snippet" href="#">Snippet &amp; A</a>
<a rel="nofollow" class="result__a" href="https://example.com/b">Example B</a>
<a class="result__snippet">Snippet B 摘要</a>
</body></html>`;

function fakeFetchFor(handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    for (const [prefix, h] of Object.entries(handlers)) {
      if (u.startsWith(prefix)) return await h(init);
    }
    throw new Error(`fakeFetch 未覆盖: ${u}`);
  }) as typeof fetch;
}

describe("P1-8 websearch 多 provider", () => {
  test("tavily 主路径", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    const fetchFn = fakeFetchFor({
      "https://api.tavily.com/search": (init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.api_key).toBe("test-key");
        return new Response(
          JSON.stringify({ results: [{ title: "T", url: "https://t.dev", content: "内容" }] }),
          { status: 200 },
        );
      },
    });
    const tool = createWebsearchTool(
      { enabled: true, provider: "tavily", apiKeyEnv: "TAVILY_API_KEY", maxResults: 5, fallback: false },
      { fetchFn },
    );
    const r = await tool.execute({ query: "test" }, { sessionId: "s", cwd: "/tmp" });
    expect(r.result).toContain("T");
    expect(r.result).toContain("https://t.dev");
  });

  test("exa 主路径（x-api-key 头）", async () => {
    process.env.EXA_API_KEY = "exa-key";
    const fetchFn = fakeFetchFor({
      "https://api.exa.ai/search": (init) => {
        expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("exa-key");
        return new Response(
          JSON.stringify({ results: [{ title: "E", url: "https://e.dev", text: "摘要" }] }),
          { status: 200 },
        );
      },
    });
    const tool = createWebsearchTool(
      { enabled: true, provider: "exa", apiKeyEnv: "EXA_API_KEY", maxResults: 5, fallback: false },
      { fetchFn },
    );
    const r = await tool.execute({ query: "test" }, { sessionId: "s", cwd: "/tmp" });
    expect(r.result).toContain("https://e.dev");
  });

  test("duckduckgo 免密源：HTML 解析 + uddg 跳转解码", async () => {
    const fetchFn = fakeFetchFor({
      "https://html.duckduckgo.com/html/": () => new Response(DDG_HTML, { status: 200 }),
    });
    const tool = createWebsearchTool(
      { enabled: true, provider: "duckduckgo", apiKeyEnv: "", maxResults: 5, fallback: true },
      { fetchFn },
    );
    const r = await tool.execute({ query: "test" }, { sessionId: "s", cwd: "/tmp" });
    expect(r.result).toContain("Example A");
    expect(r.result).toContain("https://example.com/a"); // uddg 已解码，不含跳转壳
    expect(r.result).not.toContain("uddg=");
    expect(r.result).toContain("https://example.com/b");
    expect(r.result).toContain("Snippet B 摘要");
  });

  test("降级：tavily 缺 key → duckduckgo，附降级说明", async () => {
    delete process.env.TAVILY_API_KEY;
    const fetchFn = fakeFetchFor({
      "https://html.duckduckgo.com/html/": () => new Response(DDG_HTML, { status: 200 }),
    });
    const tool = createWebsearchTool(
      { enabled: true, provider: "tavily", apiKeyEnv: "TAVILY_API_KEY", maxResults: 5, fallback: true },
      { fetchFn },
    );
    const r = await tool.execute({ query: "test" }, { sessionId: "s", cwd: "/tmp" });
    expect(r.result).toContain("已降级 DuckDuckGo 免密源");
    expect(r.result).toContain("Example A");
  });

  test("降级：主源 HTTP 500 → duckduckgo；fallback=false 则抛错", async () => {
    process.env.TAVILY_API_KEY = "k";
    const fetchFn = fakeFetchFor({
      "https://api.tavily.com/search": () => new Response("boom", { status: 500 }),
      "https://html.duckduckgo.com/html/": () => new Response(DDG_HTML, { status: 200 }),
    });
    const withFallback = createWebsearchTool(
      { enabled: true, provider: "tavily", apiKeyEnv: "TAVILY_API_KEY", maxResults: 5, fallback: true },
      { fetchFn },
    );
    const r = await withFallback.execute({ query: "q" }, { sessionId: "s", cwd: "/tmp" });
    expect(r.result).toContain("HTTP 500");
    expect(r.result).toContain("Example A");

    const noFallback = createWebsearchTool(
      { enabled: true, provider: "tavily", apiKeyEnv: "TAVILY_API_KEY", maxResults: 5, fallback: false },
      { fetchFn },
    );
    await expect(noFallback.execute({ query: "q" }, { sessionId: "s", cwd: "/tmp" })).rejects.toThrow("HTTP 500");
  });

  test("net.json 解析 fallback 字段；缺省 true；损坏 JSON 回退缺省", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "p1-net-"));
    fs.mkdirSync(path.join(home, ".agent"), { recursive: true });
    // 缺省
    expect(loadNetConfig(home).websearch.fallback).toBe(true);
    // 显式 false
    fs.writeFileSync(
      path.join(home, ".agent", "net.json"),
      JSON.stringify({ websearch: { enabled: true, provider: "exa", apiKeyEnv: "EXA_API_KEY", fallback: false } }),
    );
    const cfg = loadNetConfig(home).websearch;
    expect(cfg.provider).toBe("exa");
    expect(cfg.fallback).toBe(false);
    // 损坏
    fs.writeFileSync(path.join(home, ".agent", "net.json"), "{broken");
    expect(loadNetConfig(home).websearch.enabled).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("defaultNetConfig 形状", () => {
    const cfg = defaultNetConfig();
    expect(cfg.websearch.provider).toBe("tavily");
    expect(cfg.websearch.fallback).toBe(true);
    expect(cfg.webfetch.enabled).toBe(true);
  });
});
