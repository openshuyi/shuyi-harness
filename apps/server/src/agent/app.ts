/**
 * Agent 组合根：装配各模块并导出 Hono 子应用（由 src/index.ts 挂载到 BTS 宿主）。
 * 环境变量：
 *   AGENT_DB           SQLite 路径（默认 ~/.agent/agent.db）
 *   AGENT_MODELS       模型配置（见 model/index.ts）
 *   AGENT_MODELS_CONFIG 模型持久化配置路径（默认 ~/.agent/models.json，模型管理 API 写入）
 *   AGENT_MCP_CONFIG   MCP 配置路径（默认 ~/.agent/mcp.json）
 *   AGENT_CONTEXT_WINDOW 上下文窗口 token 数（默认 128000，压缩阈值=75%）
 *   AGENT_WEB_DIST     Web 构建产物目录（默认 apps/web/dist，二进制分发时用）
 *
 * M6：`agent-bin --acp` 进入 ACP stdio 模式（IDE 子进程协议，见 acp/stdio.ts），
 * 不启动 HTTP 服务；stdout 是协议通道。必须在做任何端口绑定/日志输出之前分流。
 * P1-7：`--tui` 启动内嵌 TUI 终端客户端（连接常驻服务端，不启动 HTTP）。
 */

import fs from "node:fs";
import path from "node:path";
import "../env.server.js";
import type { AgentEvent } from "@shuyi-harness/types";
import type { Hono } from "hono";

const acpMode = process.argv.includes("--acp");
const tuiMode = process.argv.includes("--tui");

if (acpMode) {
	// M6：ACP stdio 模式（IDE 子进程协议，stdout 是协议通道）
	const { runAcpStdio } = await import("./acp/stdio.js");
	await runAcpStdio();
} else if (tuiMode) {
	// P1-7：TUI 终端客户端
	const { runTui } = await import("./tui/entry.js");
	await runTui(process.argv);
}

const composed = acpMode || tuiMode ? null : await compose();

async function compose(): Promise<Hono> {
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
	const modelsConfigFile =
		process.env.AGENT_MODELS_CONFIG ?? path.join(HOME, ".agent", "models.json");

	const bus = new EventBus();
	const store = new SqliteEventStore(dbPath, bus);
	const tools = await createFullRegistry();
	const models = new RuntimeModelRegistry(process.env, modelsConfigFile);
	const agents = new AgentRegistry();
	const sessions = new SessionManager(store, tools, models, agents);
	const app = createApi({ agents, bus, models, sessions, store });

	// P8-6：启动时用 models.dev 元数据补全缺失的上下文窗口/定价（后台异步，失败静默）
	// biome-ignore lint/complexity/noVoid: 启动期后台任务，故意 fire-and-forget
	void enrichFromModelsDev(models)
		.then((n) => {
			if (n > 0) {
				console.log(`[model] models.dev 元数据已补全 ${n} 个模型的窗口/定价`);
			}
		})
		// biome-ignore lint/suspicious/noEmptyBlockStatements: 元数据补全失败静默（离线场景正常）
		.catch(() => {});

	// MCP：连接外部工具 server（失败只告警，不影响主流程）
	const mcp = await connectMcpServers(tools);
	if (mcp.connected.length > 0) {
		console.log(`[mcp] 已连接: ${mcp.connected.join(", ")}`);
	}
	if (mcp.failed.length > 0) {
		console.warn(`[mcp] 连接失败（已跳过）: ${mcp.failed.join(", ")}`);
	}

	// P1-5：event 观测钩子——每个事件异步喂给 .agent/hooks/event（需 shuyi.json hooks:true；
	// 纯观测、不 await、不回写事件流，避免 hook 产出再触发 hook 的回环）
	const observeEvent = async (e: AgentEvent) => {
		try {
			if (e.type === "hook.executed") {
				return; // 自身产出的事件不转发（防回环）
			}
			const session = await store.getSession(e.session_id);
			if (!session) {
				return;
			}
			const cfg = loadProjectConfig(session.cwd);
			if (cfg.hooks !== true) {
				return;
			}
			await runObserveHooks("event", session.cwd, e);
		} catch {
			// 观测钩子永不影响主流程
		}
	};
	bus.subscribe((e) => {
		// biome-ignore lint/complexity/noVoid: 事件观测钩子异步执行不阻塞事件总线，故意 fire-and-forget
		void observeEvent(e);
	});

	// 生产模式：若 web 已构建，由服务端直接托管静态文件（单进程单端口）
	// 兼容两种运行位置：dev（src/agent/）与 tsdown bundle（dist/index.mjs）
	const webDistCandidates = [
		process.env.AGENT_WEB_DIST,
		path.resolve(import.meta.dir, "../../../web/dist"), // dev: src/agent → apps/web/dist
		path.resolve(import.meta.dir, "../../web/dist"), // bundle: dist → apps/web/dist
	].filter((p): p is string => Boolean(p));
	const webDist = webDistCandidates.find((p) =>
		fs.existsSync(path.join(p, "index.html"))
	);
	if (webDist) {
		app.use("/*", serveStatic({ root: webDist }));
		app.get("*", serveStatic({ path: "/index.html", root: webDist }));
		console.log(`[agent] 托管 Web 界面: ${webDist}`);
	}

	console.log(`[agent] 数据库: ${dbPath}`);
	console.log(
		`[agent] 可用模型: ${[...models.adapters.keys()].join(", ")}（默认 ${models.defaultModel}）`
	);
	console.log(`[agent] 工具数: ${tools.list().length}`);

	return app;
}

export default composed;
