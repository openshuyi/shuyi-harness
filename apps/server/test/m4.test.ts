/**
 * M4 联网能力测试（webfetch / websearch）。
 * 对应文档：《编码智能体-v0.3设计-能力追赶计划.md》§M4 验收：
 * - 单元：HTML→markdown 转换（代码块、表格、链接保留）；SSRF 地址判定矩阵
 * - e2e（mock fetch）：!webfetch https://example.com 通过；内网地址被拒
 * 另覆盖：net.json 配置降级路径（websearch 默认不注册）、deny_builtin 不可被用户规则覆盖、
 * 子代理工具面隐藏联网工具、权限级别（webfetch=always-ask / websearch=always-allow）。
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentEvent, SessionRecord } from "@shuyi/types";
import { EventBus } from "../src/bus/index.js";
import { SqliteEventStore } from "../src/store/event-store.js";
import { createDefaultRegistry, ToolRegistry } from "../src/tools/index.js";
import { RuntimeModelRegistry } from "../src/model/registry.js";
import { SessionManager } from "../src/session/manager.js";
import { AgentRegistry } from "../src/agents/index.js";
import { PermissionService } from "../src/permission/index.js";
import {
  htmlToMarkdown,
  htmlToText,
  urlSafetyDenyReason,
  createWebfetchTool,
  createWebsearchTool,
} from "../src/tools/web.js";
import { loadNetConfig, defaultNetConfig } from "../src/config/net.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-m4-"));
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(workspace, { recursive: true });

// ---------- 单元：HTML → markdown（文档验收：代码块、表格、链接保留） ----------
describe("M4 单元：HTML→markdown", () => {
  test("代码块与行内代码保留", () => {
    const html = `<html><body><p>使用 <code>bun test</code> 运行：</p>
<pre><code>const x = 1 &lt; 2;
if (x) { console.log("ok"); }</code></pre></body></html>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain("`bun test`");
    expect(md).toContain("```");
    expect(md).toContain("const x = 1 < 2;"); // 实体解码且标签不被误处理
    expect(md).toContain('console.log("ok");');
  });

  test("表格转 markdown 表格", () => {
    const html = `<table><tr><th>名称</th><th>版本</th></tr><tr><td>bun</td><td>1.4</td></tr><tr><td>vite</td><td>5</td></tr></table>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain("| 名称 | 版本 |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| bun | 1.4 |");
    expect(md).toContain("| vite | 5 |");
  });

  test("链接保留，javascript: 协议剔除", () => {
    const html = `<p>见 <a href="https://bun.sh/docs">Bun 文档</a> 与 <a href="javascript:alert(1)">恶意</a></p>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain("[Bun 文档](https://bun.sh/docs)");
    expect(md).not.toContain("javascript:");
    expect(md).toContain("恶意"); // 文本保留，链接剥除
  });

  test("script/style/nav/footer 剥离；标题/列表/引用结构保留", () => {
    const html = `<html><head><style>body{color:red}</style><script>track()</script></head>
<body><nav>菜单1 菜单2</nav><main>
<h1>主标题</h1><h3>小节</h3>
<ul><li>第一项</li><li>第二项</li></ul>
<blockquote>引用一句话</blockquote>
</main><footer>版权信息</footer></body></html>`;
    const md = htmlToMarkdown(html);
    expect(md).not.toContain("track()");
    expect(md).not.toContain("color:red");
    expect(md).not.toContain("菜单1");
    expect(md).not.toContain("版权信息");
    expect(md).toContain("# 主标题");
    expect(md).toContain("### 小节");
    expect(md).toContain("- 第一项");
    expect(md).toContain("> 引用一句话");
  });

  test("htmlToText：去标签保留换行", () => {
    const text = htmlToText(`<p>第一段</p><p>第二段<br>折行</p>`);
    expect(text).toContain("第一段");
    expect(text).toContain("第二段\n折行");
    expect(text).not.toContain("<p>");
  });
});

// ---------- 单元：SSRF 地址判定矩阵（文档验收） ----------
describe("M4 单元：SSRF 判定矩阵", () => {
  const denied: [string, string][] = [
    ["file:///etc/passwd", "file 协议"],
    ["ftp://example.com/x", "ftp 协议"],
    ["gopher://x/", "gopher 协议"],
    ["http://127.0.0.1/", "环回 127/8"],
    ["http://127.5.6.7:8080/admin", "环回任意 127.x"],
    ["http://10.0.0.5/", "内网 10/8"],
    ["http://172.16.0.1/", "内网 172.16/12 下界"],
    ["http://172.31.255.255/", "内网 172.16/12 上界"],
    ["http://192.168.1.1/", "内网 192.168/16"],
    ["http://169.254.169.254/latest/meta-data", "链路本地（云元数据）"],
    ["http://0.0.0.0/", "0.0.0.0"],
    ["http://localhost/", "localhost"],
    ["http://app.localhost/", "*.localhost"],
    ["http://[::1]/", "IPv6 环回"],
    ["not-a-url", "无法解析"],
    ["http://999.1.1.1/", "畸形 IP 按内网处理（fail-closed）"],
  ];
  for (const [url, label] of denied) {
    test(`拒绝：${label}（${url}）`, () => {
      expect(urlSafetyDenyReason(url)).not.toBeNull();
    });
  }
  const allowed = [
    "https://example.com/",
    "https://bun.sh/docs?x=1#frag",
    "http://8.8.8.8/dns",
    "http://172.15.0.1/", // 172.16/12 之外
    "http://172.32.0.1/",
    "https://192.167.1.1/", // 192.168/16 之外
    "https://example.com:8443/p",
  ];
  for (const url of allowed) {
    test(`放行：${url}`, () => {
      expect(urlSafetyDenyReason(url)).toBeNull();
    });
  }
});

// ---------- 单元：net.json 配置与注册开关 ----------
describe("M4 单元：net.json 配置与注册开关", () => {
  const home = path.join(tmp, "home");

  test("无配置文件 → 缺省：webfetch 开、websearch 关（默认降级路径）", () => {
    const cfg = loadNetConfig(path.join(tmp, "home-不存在"));
    expect(cfg.webfetch.enabled).toBe(true);
    expect(cfg.websearch.enabled).toBe(false);
  });

  test("配置文件解析 + 数值钳制；坏 JSON → 缺省", () => {
    fs.mkdirSync(path.join(home, ".agent"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".agent", "net.json"),
      JSON.stringify({
        webfetch: { enabled: false, maxBytes: 5, timeoutMs: 999_999 },
        websearch: { enabled: true, maxResults: 999 },
      }),
    );
    const cfg = loadNetConfig(home);
    expect(cfg.webfetch.enabled).toBe(false);
    expect(cfg.webfetch.maxBytes).toBe(1024); // 钳到下界
    expect(cfg.webfetch.timeoutMs).toBe(60_000); // 钳到上界
    expect(cfg.websearch.enabled).toBe(true);
    expect(cfg.websearch.maxResults).toBe(20);

    fs.writeFileSync(path.join(home, ".agent", "net.json"), "{ 坏 json");
    const broken = loadNetConfig(home);
    expect(broken.websearch.enabled).toBe(false); // fail-safe：搜索保持关闭
  });

  test("注册开关：websearch 默认不进工具面；enabled 才注册", async () => {
    const { createFullRegistry } = await import("../src/tools/index.js");
    // 缺省（无 net.json）：webfetch 在、websearch 不在
    const r1 = await createFullRegistry({ home: path.join(tmp, "home-空") });
    expect(r1.get("webfetch")).toBeDefined();
    expect(r1.get("websearch")).toBeUndefined();
    // enabled: true → websearch 注册
    fs.mkdirSync(path.join(tmp, "home-on", ".agent"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "home-on", ".agent", "net.json"),
      JSON.stringify({ websearch: { enabled: true } }),
    );
    const r2 = await createFullRegistry({ home: path.join(tmp, "home-on") });
    expect(r2.get("websearch")).toBeDefined();
    // webfetch enabled: false → 不注册
    fs.mkdirSync(path.join(tmp, "home-off", ".agent"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "home-off", ".agent", "net.json"),
      JSON.stringify({ webfetch: { enabled: false } }),
    );
    const r3 = await createFullRegistry({ home: path.join(tmp, "home-off") });
    expect(r3.get("webfetch")).toBeUndefined();
  });

  test("子代理工具面隐藏联网工具（subagentVisible: false）", () => {
    const r = createDefaultRegistry(); // 含 read/grep 等只读工具
    r.register(createWebfetchTool(defaultNetConfig().webfetch));
    r.register(createWebsearchTool({ ...defaultNetConfig().websearch, enabled: true }));
    // 模拟 subagent.ts 的工具面过滤：always-allow 且 subagentVisible !== false
    const subVisible = r
      .toModelSpecs("build")
      .filter((s) => {
        const t = r.get(s.name);
        return t?.permission === "always-allow" && t.subagentVisible !== false && s.name !== "task" && s.name !== "memory_write";
      })
      .map((s) => s.name);
    expect(subVisible).not.toContain("webfetch"); // always-ask 本就被过滤
    expect(subVisible).not.toContain("websearch"); // always-allow 但被显式隐藏
    expect(subVisible).toContain("read"); // 常规只读工具不受影响
  });
});

// ---------- 单元：权限链中的 deny_builtin ----------
describe("M4 单元：webfetch 权限裁决", () => {
  const r = new ToolRegistry();
  r.register(createWebfetchTool(defaultNetConfig().webfetch));
  const webfetch = r.get("webfetch")!;

  test("内网地址 deny_builtin：用户 allow 规则与全通沙箱都不可覆盖", () => {
    const ps = new PermissionService();
    ps.setUserConfigRules([
      { tool: "*", pattern: "*", patternType: "glob", decision: "allow", source: "user_config" },
    ]);
    const verdict = ps.classify({
      tool: webfetch,
      args: { url: "http://192.168.1.1/admin" },
      cwd: workspace,
      sandboxLevel: "full",
      mode: "build",
    });
    expect(verdict.kind).toBe("deny");
    expect(verdict.reason).toContain("内网");
  });

  test("公网地址 → ask（always-ask：出站必须用户可见）", () => {
    const ps = new PermissionService();
    const verdict = ps.classify({
      tool: webfetch,
      args: { url: "https://example.com" },
      cwd: workspace,
      sandboxLevel: "workspace",
      mode: "build",
    });
    expect(verdict.kind).toBe("ask");
  });
});

// ---------- e2e（mock fetch，不触网）：文档验收 ----------
describe("M4 e2e：webfetch/websearch（mock fetch）", () => {
  let store: SqliteEventStore;
  let manager: SessionManager;
  let events: AgentEvent[] = [];
  let savedKey: string | undefined;

  const FETCHED_HTML = `<html><head><title>Example</title><script>x()</script></head>
<body><nav>导航</nav><main><h1>Example Domain</h1>
<p>详见 <a href="https://example.com/more">更多说明</a>。</p>
<pre><code>curl https://example.com</code></pre></main><footer>页脚</footer></body></html>`;

  function fakeFetch(url: string | URL | Request): Promise<Response> {
    const u = String(url);
    if (u.includes("tavily")) {
      return Promise.resolve(
        Response.json({
          results: [
            { title: "Bun 运行时", url: "https://bun.sh", content: "快速的 JavaScript 运行时" },
            { title: "Bun 文档", url: "https://bun.sh/docs", content: "官方文档" },
          ],
        }),
      );
    }
    return Promise.resolve(
      new Response(FETCHED_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    );
  }

  async function waitForTurnEnd(s: SessionRecord, fromIndex: number, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    for (;;) {
      const done = events.slice(fromIndex).some((e) => e.type === "turn.completed" || e.type === "turn.aborted");
      if (done && manager.getSession(s.session_id)!.status === "idle") return;
      if (Date.now() - start > timeoutMs) throw new Error("等待轮次结束超时");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async function waitForApproval(fromIndex: number, timeoutMs = 8000): Promise<string> {
    const start = Date.now();
    for (;;) {
      const req = events.slice(fromIndex).find((e) => e.type === "approval.requested");
      if (req) return (req.payload as { approval_id: string }).approval_id;
      if (Date.now() - start > timeoutMs) throw new Error("等待审批挂起超时");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  beforeAll(() => {
    savedKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "test-key"; // websearch 执行需要（fake fetch 不校验）
    const bus = new EventBus();
    store = new SqliteEventStore(path.join(tmp, "m4-e2e.db"), bus);
    bus.subscribe((e) => events.push(e));
    const registry = createDefaultRegistry();
    const net = defaultNetConfig();
    registry.register(createWebfetchTool(net.webfetch, { fetchFn: fakeFetch as typeof fetch }));
    // fallback:false——保留 M4 的 fail-closed 语义测试（P1-8 的降级行为由 p1-websearch.test.ts 覆盖）
    registry.register(createWebsearchTool({ ...net.websearch, enabled: true, fallback: false }, { fetchFn: fakeFetch as typeof fetch }));
    manager = new SessionManager(store, registry, new RuntimeModelRegistry({}), new AgentRegistry(path.join(tmp, "home-e2e")));
  });

  afterAll(() => {
    store.close();
    if (savedKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = savedKey;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("!webfetch 公网地址：审批 → 批准 → 返回 markdown（无新增事件类型）", async () => {
    const s = manager.createSession({ cwd: workspace, mode: "build", model: "mock", sandbox_level: "workspace" });
    const mark = events.length;
    manager.postMessage(s.session_id, "!webfetch https://example.com");
    // always-ask：先挂起审批
    const approvalId = await waitForApproval(mark);
    const reqEvent = events.slice(mark).find((e) => e.type === "approval.requested")!;
    expect((reqEvent.payload as { risk_summary: string }).risk_summary).toContain("https://example.com");
    manager.resolveApproval(s.session_id, approvalId, { decision: "approve" });
    await waitForTurnEnd(s, mark);

    const slice = events.slice(mark);
    const completed = slice.find((e) => e.type === "tool.call.completed");
    expect(completed).toBeDefined();
    const result = (completed!.payload as { result: string }).result;
    expect(result).toContain("# Example Domain"); // 标题转换
    expect(result).toContain("[更多说明](https://example.com/more)"); // 链接保留
    expect(result).toContain("curl https://example.com"); // 代码块保留
    expect(result).not.toContain("导航"); // nav 剥离
    expect(result).not.toContain("页脚"); // footer 剥离
  });

  test("!webfetch 内网地址：deny_builtin 直接拒绝，不弹审批、不发请求", async () => {
    const s = manager.createSession({ cwd: workspace, mode: "build", model: "mock", sandbox_level: "workspace" });
    const mark = events.length;
    manager.postMessage(s.session_id, "!webfetch http://192.168.1.1/admin");
    await waitForTurnEnd(s, mark);

    const slice = events.slice(mark);
    expect(slice.map((e) => e.type)).not.toContain("approval.requested");
    const failed = slice.find((e) => e.type === "tool.call.failed");
    expect((failed!.payload as { error: string }).error).toContain("权限拒绝");
  });

  test("!webfetch file:// 协议：SSRF 拦截", async () => {
    const s = manager.createSession({ cwd: workspace, mode: "build", model: "mock", sandbox_level: "workspace" });
    const mark = events.length;
    manager.postMessage(s.session_id, "!webfetch file:///etc/passwd");
    await waitForTurnEnd(s, mark);
    const failed = events.slice(mark).find((e) => e.type === "tool.call.failed");
    expect((failed!.payload as { error: string }).error).toContain("权限拒绝");
  });

  test("!websearch：always-allow 免审批，返回结果列表", async () => {
    const s = manager.createSession({ cwd: workspace, mode: "build", model: "mock", sandbox_level: "workspace" });
    const mark = events.length;
    manager.postMessage(s.session_id, "!websearch bun runtime");
    await waitForTurnEnd(s, mark);

    const slice = events.slice(mark);
    expect(slice.map((e) => e.type)).not.toContain("approval.requested");
    const completed = slice.find((e) => e.type === "tool.call.completed");
    const result = (completed!.payload as { result: string }).result;
    expect(result).toContain("Bun 运行时");
    expect(result).toContain("https://bun.sh/docs");
  });

  test("websearch 缺 API Key：执行期明确报错（fail-closed）", async () => {
    delete process.env.TAVILY_API_KEY;
    try {
      const s = manager.createSession({ cwd: workspace, mode: "build", model: "mock", sandbox_level: "workspace" });
      const mark = events.length;
      manager.postMessage(s.session_id, "!websearch anything");
      await waitForTurnEnd(s, mark);
      const failed = events.slice(mark).find((e) => e.type === "tool.call.failed");
      expect((failed!.payload as { error: string }).error).toContain("TAVILY_API_KEY");
    } finally {
      process.env.TAVILY_API_KEY = "test-key";
    }
  });
});
