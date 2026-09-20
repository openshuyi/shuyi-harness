/**
 * Agent Server 入口：装配各模块，启动 Hono。
 * 环境变量：
 *   AGENT_DB           SQLite 路径（默认 ~/.agent/agent.db）
 *   AGENT_PORT         端口（默认 4291）
 *   AGENT_MODELS       模型配置（见 model/index.ts）
 *   AGENT_MODELS_CONFIG 模型持久化配置路径（默认 ~/.agent/models.json，模型管理 API 写入）
 *   AGENT_MCP_CONFIG   MCP 配置路径（默认 ~/.agent/mcp.json）
 *   AGENT_CONTEXT_WINDOW 上下文窗口 token 数（默认 128000，压缩阈值=75%）
 *   AGENT_WEB_DIST     Web 构建产物目录（默认 apps/web/dist，二进制分发时用）
 *
 * M6：`agent-bin --acp` 进入 ACP stdio 模式（IDE 子进程协议，见 acp/stdio.ts），
 * 不启动 HTTP 服务；stdout 是协议通道。必须在做任何端口绑定/日志输出之前分流。
 */
import path from "node:path";
import fs from "node:fs";

let serverExport: { port: number; fetch: unknown; idleTimeout: number } | undefined;

if (process.argv.includes("--acp")) {
  // M6：ACP stdio 模式（IDE 子进程协议，stdout 是协议通道）
  const { runAcpStdio } = await import("./acp/stdio.js");
  await runAcpStdio();
} else if (process.argv.includes("--tui")) {
  // P1-7：TUI 终端客户端（连接常驻服务端，不启动 HTTP）
  const { runTui } = await import("./tui/entry.js");
  await runTui(process.argv);
} else {
  serverExport = await main();
}

// Bun.serve 入口导出（ACP 模式下为 undefined，Bun 不会启动监听）
export default serverExport;

async function main() {
  const { serveStatic } = await import("hono/bun");
  const { EventBus } = await import("./bus/index.js");
  const { SqliteEventStore } = await import("./store/event-store.js");
  const { createFullRegistry } = await import("./tools/index.js");
  const { RuntimeModelRegistry } = await import("./model/registry.js");
  const { SessionManager } = await import("./session/manager.js");
  const { createApi } = await import("./api/index.js");
  const { connectMcpServers } = await import("./mcp/index.js");
  const { AgentRegistry } = await import("./agents/index.js");
  const { enrichFromModelsDev } = await import("./model/modelsdev.js");
  const { loadProjectConfig } = await import("./config/project.js");
  const { runObserveHooks } = await import("./hooks/index.js");

  const HOME = process.env.HOME ?? "/root";
  const dbPath = process.env.AGENT_DB ?? path.join(HOME, ".agent", "agent.db");
  const port = Number(process.env.AGENT_PORT ?? 4291);
  const modelsConfigFile =
    process.env.AGENT_MODELS_CONFIG ?? path.join(HOME, ".agent", "models.json");

  const bus = new EventBus();
  const store = new SqliteEventStore(dbPath, bus);
  const tools = await createFullRegistry();
  const models = new RuntimeModelRegistry(process.env, modelsConfigFile);
  const agents = new AgentRegistry();
  const sessions = new SessionManager(store, tools, models, agents);
  const app = createApi({ store, bus, sessions, models, agents });

  // P8-6：启动时用 models.dev 元数据补全缺失的上下文窗口/定价（后台异步，失败静默）
  void enrichFromModelsDev(models).then((n) => {
    if (n > 0) console.log(`[model] models.dev 元数据已补全 ${n} 个模型的窗口/定价`);
  }).catch(() => {});

  // MCP：连接外部工具 server（失败只告警，不影响主流程）
  const mcp = await connectMcpServers(tools);
  if (mcp.connected.length > 0) console.log(`[mcp] 已连接: ${mcp.connected.join(", ")}`);
  if (mcp.failed.length > 0) console.warn(`[mcp] 连接失败（已跳过）: ${mcp.failed.join(", ")}`);

  // P1-5：event 观测钩子——每个事件异步喂给 .agent/hooks/event（需 shuyi.json hooks:true；
  // 纯观测、不 await、不回写事件流，避免 hook 产出再触发 hook 的回环）
  bus.subscribe((e) => {
    try {
      if (e.type === "hook.executed") return; // 自身产出的事件不转发（防回环）
      const session = store.getSession(e.session_id);
      if (!session) return;
      const cfg = loadProjectConfig(session.cwd);
      if (cfg.hooks !== true) return;
      void runObserveHooks("event", session.cwd, e).catch(() => {});
    } catch {
      // 观测钩子永不影响主流程
    }
  });

  // 生产模式：若 web 已构建，由服务端直接托管静态文件（单进程单端口）
  const webDist = process.env.AGENT_WEB_DIST ?? path.resolve(import.meta.dir, "../../web/dist");
  if (fs.existsSync(path.join(webDist, "index.html"))) {
    app.use("/*", serveStatic({ root: webDist }));
    app.get("*", serveStatic({ path: "/index.html", root: webDist }));
    console.log(`[agent] 托管 Web 界面: ${webDist}`);
  }

  console.log(`[agent] 数据库: ${dbPath}`);
  console.log(`[agent] 可用模型: ${[...models.adapters.keys()].join(", ")}（默认 ${models.defaultModel}）`);
  console.log(`[agent] 工具数: ${tools.list().length}`);
  console.log(`[agent] 监听: http://localhost:${port}`);

  return {
    port,
    fetch: app.fetch,
    // SSE 长连接是核心能力（事件流/聚合流）：禁用 Bun 默认 10s 空闲超时，
    // 否则心跳间隔（15s）内的空闲会被服务器强杀，客户端被迫反复重连。
    idleTimeout: 0,
  };
}
