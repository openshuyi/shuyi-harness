import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { appRouter } from "@shuyi-harness/api/routers/index";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import agentApp from "./agent/app";
import { createContext } from "./context";
import { desktopOrigins, ENV } from "./env.server";
import { auth } from "./services";

const app = new Hono();

app.use(logger());
app.use(
	"/*",
	cors({
		allowHeaders: ["Content-Type", "Authorization"],
		allowMethods: ["GET", "POST", "OPTIONS"],
		credentials: true,
		origin: [ENV.CORS_ORIGIN, ...desktopOrigins],
	})
);

app.on(["POST", "GET"], "/api/auth/*", async (c) => auth.handler(c.req.raw));

export const apiHandler = new OpenAPIHandler(appRouter, {
	interceptors: [
		onError((error) => {
			console.error(error);
		}),
	],
	plugins: [
		new OpenAPIReferencePlugin({
			schemaConverters: [new ZodToJsonSchemaConverter()],
		}),
	],
});

export const rpcHandler = new RPCHandler(appRouter, {
	interceptors: [
		onError((error) => {
			console.error(error);
		}),
	],
});

app.use("/*", async (c, next) => {
	const context = await createContext({ context: c });

	const rpcResult = await rpcHandler.handle(c.req.raw, {
		context,
		prefix: "/rpc",
	});

	if (rpcResult.matched) {
		return c.newResponse(rpcResult.response.body, rpcResult.response);
	}

	const apiResult = await apiHandler.handle(c.req.raw, {
		context,
		prefix: "/api-reference",
	});

	if (apiResult.matched) {
		return c.newResponse(apiResult.response.body, apiResult.response);
	}

	await next();
});

// Agent 子应用（REST + SSE + 静态托管），挂在 rpc/auth 之后（--acp/--tui 模式下为 null，不挂载）
if (agentApp) {
	app.route("/", agentApp);
}

app.get("/", (c) => c.text("OK"));

export default {
	fetch: app.fetch,
	// SSE 长连接是核心能力（事件流/聚合流）：禁用 Bun 默认 10s 空闲超时，
	// 否则心跳间隔（15s）内的空闲会被服务器强杀，客户端被迫反复重连。
	idleTimeout: 0,
	port: ENV.AGENT_PORT ?? 4351,
};
