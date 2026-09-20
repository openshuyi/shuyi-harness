/**
 * M6：ACP stdio 入口——IDE（Zed 等）以子进程方式拉起本进程，通过 stdin/stdout
 * 交换换行分隔 JSON（ndjson）。
 *
 * 注意：stdout 是协议通道，一切日志必须走 stderr。
 * 装配与 HTTP 服务端同源（同一 SessionManager 语义），但不监听端口。
 */
import path from "node:path";
import readline from "node:readline";
import { EventBus } from "../bus/index.js";
import { SqliteEventStore } from "../store/event-store.js";
import { createFullRegistry } from "../tools/index.js";
import { RuntimeModelRegistry } from "../model/registry.js";
import { SessionManager } from "../session/manager.js";
import { AgentRegistry } from "../agents/index.js";
import { connectMcpServers } from "../mcp/index.js";
import { AcpServer } from "./index.js";

export async function runAcpStdio(): Promise<void> {
  const HOME = process.env.HOME ?? "/root";
  const dbPath = process.env.AGENT_DB ?? path.join(HOME, ".agent", "agent.db");
  const modelsConfigFile =
    process.env.AGENT_MODELS_CONFIG ?? path.join(HOME, ".agent", "models.json");

  const bus = new EventBus();
  const store = new SqliteEventStore(dbPath, bus);
  const tools = await createFullRegistry();
  const models = new RuntimeModelRegistry(process.env, modelsConfigFile);
  const agents = new AgentRegistry();
  const sessions = new SessionManager(store, tools, models, agents);

  // MCP：与 HTTP 服务端一致地接入外部工具（失败静默到 stderr）
  const mcp = await connectMcpServers(tools);
  if (mcp.failed.length > 0) {
    console.error(`[acp] MCP 连接失败（已跳过）: ${mcp.failed.join(", ")}`);
  }

  const server = new AcpServer({ store, bus, sessions, models }, (msg) => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // 无法解析的行不回包（无法确定 id），记 stderr
      console.error(`[acp] 无法解析的输入行: ${trimmed.slice(0, 120)}`);
      return;
    }
    void server.handleMessage(msg).catch((err) => {
      console.error(`[acp] 消息处理错误: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  console.error(`[acp] 就绪：db=${dbPath} 模型=${[...models.adapters.keys()].join(",")}`);
}
