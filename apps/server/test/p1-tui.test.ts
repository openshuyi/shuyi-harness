/**
 * P1-7：TUI 终端客户端——同一服务端的投影。
 * e2e：真实 HTTP 服务（Bun.serve port 0）+ 真实 SSE 流 + 脚本化输入行。
 * 覆盖：会话复用/新建、消息流式渲染、question 作答、审批 y/n、/mode、/sessions、/new。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBus } from "../src/bus/index.js";
import { SqliteEventStore } from "../src/store/event-store.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { RuntimeModelRegistry } from "../src/model/registry.js";
import { SessionManager } from "../src/session/manager.js";
import { AgentRegistry } from "../src/agents/index.js";
import { createApi } from "../src/api/index.js";
import { TuiApp } from "../src/tui/index.js";

let tmp: string;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let apps: TuiApp[] = [];

/** 剥离 ANSI 转义（断言不受颜色码干扰） */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** 脚本化 IO：输入行队列 + 输出收集 */
class ScriptedIo {
  output = "";
  private lineCb: ((line: string) => void) | null = null;
  private queue: string[] = [];
  private waiting: (() => void) | null = null;

  write(s: string): void {
    this.output += s;
  }
  onLine(cb: (line: string) => void): void {
    this.lineCb = cb;
    // 补发积压行
    const lines = this.queue.splice(0);
    for (const l of lines) cb(l);
  }
  /** 注入一行用户输入 */
  type(line: string): void {
    if (this.lineCb) this.lineCb(line);
    else this.queue.push(line);
  }
  /** 等待输出中出现某子串 */
  async waitFor(substr: string, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (this.output.includes(substr)) return;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`等待输出超时: ${substr}\n当前输出:\n${this.output.slice(-800)}`);
      }
      if (this.waiting) this.waiting();
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p1-tui-"));
  apps = [];
  const bus = new EventBus();
  const store = new SqliteEventStore(path.join(tmp, "events.db"), bus);
  const models = new RuntimeModelRegistry({});
  const sessions = new SessionManager(store, createDefaultRegistry(), models, new AgentRegistry());
  const app = createApi({ store, bus, sessions, models, agents: new AgentRegistry() });
  server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 0 });
  baseUrl = `http://localhost:${server.port}`;
});

afterEach(() => {
  for (const a of apps) a.stop(); // 先断 SSE，再停服务，避免悬空的 keep-alive 连接
  apps = [];
  server.stop(true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeTui(io: ScriptedIo): TuiApp {
  const app = new TuiApp({ baseUrl, cwd: tmp, io });
  apps.push(app);
  return app;
}

describe("P1-7 TUI", () => {
  test("启动新建会话 → 发消息 → 流式渲染 → 轮次完成提示", async () => {
    const io = new ScriptedIo();
    const app = makeTui(io);
    await app.run();
    app.startEventLoop();
    expect(plain(io.output)).toContain("新会话");

    io.type("你好，TUI");
    await io.waitFor("轮次完成", 10000);
    // mock 回退回复被流式渲染出来
    expect(plain(io.output)).toContain("Mock 回复：收到「你好，TUI」");
    expect(plain(io.output)).toContain("tokens");
  });

  test("question 工具：TUI 渲染问题与选项，输入编号作答", async () => {
    const io = new ScriptedIo();
    const app = makeTui(io);
    await app.run();
    app.startEventLoop();

    io.type("!question 选哪种数据库？=SQLite|Postgres");
    await io.waitFor("模型提问：选哪种数据库？");
    expect(plain(io.output)).toContain("1) SQLite");
    expect(plain(io.output)).toContain("2) Postgres");
    io.type("1");
    await io.waitFor("轮次完成", 10000);
    expect(io.output).not.toContain("审批提交失败");
  });

  test("内建命令：/mode plan、/sessions、/new", async () => {
    const io = new ScriptedIo();
    const app = makeTui(io);
    await app.run();
    app.startEventLoop();

    io.type("/mode plan");
    await io.waitFor("已切换到 plan 模式");

    io.type("/sessions");
    await io.waitFor("plan·mock");

    io.type("/new");
    await io.waitFor("新会话：", 8000);
  }, 15000);

  test("复用同 cwd 的最新会话（不新建）", async () => {
    // 先建一个会话
    await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: tmp }),
    });
    const io = new ScriptedIo();
    const app = makeTui(io);
    await app.run();
    app.startEventLoop();
    expect(plain(io.output)).toContain("复用会话");
    expect(plain(io.output)).not.toContain("新会话：");
  });
});
