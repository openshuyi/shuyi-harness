/**
 * Agent Server 入口：装配各模块，启动 Hono。
 * 环境变量：
 *   AGENT_DB           SQLite 路径（默认 ~/.agent/agent.db）
 *   AGENT_PORT         端口（默认 4291）
 *   AGENT_MODELS       模型配置（见 model/index.ts）
 *   AGENT_MCP_CONFIG   MCP 配置路径（默认 ~/.agent/mcp.json）
 *   AGENT_CONTEXT_WINDOW 上下文窗口 token 数（默认 128000，压缩阈值=75%）
 *   AGENT_WEB_DIST     Web 构建产物目录（默认 apps/web/dist，二进制分发时用）
 */
import path from "node:path";
import fs from "node:fs";
import { serveStatic } from "hono/bun";
import { EventBus } from "./bus/index.js";
import { SqliteEventStore } from "./store/event-store.js";
import { createFullRegistry } from "./tools/index.js";
import { buildModelRegistry } from "./model/index.js";
import { SessionManager } from "./session/manager.js";
import { createApi } from "./api/index.js";
import { connectMcpServers } from "./mcp/index.js";

const HOME = process.env.HOME ?? "/root";
const dbPath = process.env.AGENT_DB ?? path.join(HOME, ".agent", "agent.db");
const port = Number(process.env.AGENT_PORT ?? 4291);

const bus = new EventBus();
const store = new SqliteEventStore(dbPath, bus);
const tools = await createFullRegistry();
const models = buildModelRegistry();
const sessions = new SessionManager(store, tools, models);
const app = createApi({ store, bus, sessions, models });

// MCP：连接外部工具 server（失败只告警，不影响主流程）
const mcp = await connectMcpServers(tools);
if (mcp.connected.length > 0) console.log(`[mcp] 已连接: ${mcp.connected.join(", ")}`);
if (mcp.failed.length > 0) console.warn(`[mcp] 连接失败（已跳过）: ${mcp.failed.join(", ")}`);

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

export default {
  port,
  fetch: app.fetch,
};
