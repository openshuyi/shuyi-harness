/**
 * P3：MCP 客户端与 LSP 代码智能。
 * MCP：连接 echo fixture server → 工具桥接 → 调用返回 pong。
 * LSP：typescript-language-server 存在时跑真诊断；不存在则验证优雅降级。
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectTsServer, lspFor } from "../src/agent/lsp/client.js";
import { lspDiagnosticsTool } from "../src/agent/lsp/tools.js";
import { connectMcpServers } from "../src/agent/mcp/index.js";
import { createDefaultRegistry } from "../src/agent/tools/index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mcplsp-"));

afterAll(() => {
	fs.rmSync(tmp, { force: true, recursive: true });
});

describe("P3：MCP 客户端", () => {
	test("连接 echo server，工具桥接并可调用", async () => {
		const configPath = path.join(tmp, "mcp.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				servers: [
					{
						args: [
							path.join(import.meta.dir, "fixtures", "mcp-echo-server.ts"),
						],
						command: process.execPath, // bun 自身
						name: "echo",
					},
				],
			})
		);

		const registry = createDefaultRegistry();
		const { connected, failed } = await connectMcpServers(registry, configPath);
		expect(failed).toEqual([]);
		expect(connected.length).toBe(1);

		const tool = registry.get("mcp_echo_ping");
		expect(tool).toBeDefined();
		expect(tool?.permission).toBe("always-ask"); // MCP 默认逐条确认

		const out = await tool?.execute(
			{ text: "hello-mcp" },
			{ cwd: tmp, sessionId: "t" }
		);
		if (!out) throw new Error("MCP 工具执行无返回");
		expect(out.result).toContain("pong: hello-mcp");
	}, 30_000);

	test("配置不存在时优雅降级（返回空）", async () => {
		const registry = createDefaultRegistry();
		const { connected, failed } = await connectMcpServers(
			registry,
			path.join(tmp, "nonexistent.json")
		);
		expect(connected).toEqual([]);
		expect(failed).toEqual([]);
	});
});

describe("P3：LSP 代码智能", () => {
	// apps/server 自带 typescript-language-server（workspace typescript@6 提供其 JS API）
	const serverDir = path.resolve(import.meta.dir, "..");
	const hasServer = detectTsServer(serverDir) !== null;

	test("诊断：有类型错误的文件返回 error，干净文件返回无诊断", async () => {
		if (!hasServer) {
			console.log("跳过：typescript-language-server 不可用");
			return;
		}
		const badFile = path.join(tmp, "bad.ts");
		fs.writeFileSync(
			badFile,
			"const x: number = 'not a number';\nexport default x;\n"
		);

		const client = lspFor(serverDir);
		if (!client) {
			throw new Error("LSP 客户端不可用");
		}
		const diags = await client.diagnostics(badFile, 15_000);
		expect(diags).not.toBeNull();
		expect(
			(diags ?? []).some(
				(d) => d.severity === "error" && d.message.includes("string")
			)
		).toBe(true);

		const goodFile = path.join(tmp, "good.ts");
		fs.writeFileSync(goodFile, "export const y: number = 42;\n");
		const diags2 = await client.diagnostics(goodFile, 15_000);
		expect(diags2).not.toBeNull();
		expect((diags2 ?? []).filter((d) => d.severity === "error").length).toBe(0);
	}, 60_000);

	test("工具层：不可用环境返回明确提示而非崩溃", async () => {
		// 用一个没有语言服务器的目录
		const emptyDir = path.join(tmp, "empty-ws");
		fs.mkdirSync(emptyDir, { recursive: true });
		const out = await lspDiagnosticsTool.execute(
			{ path: "x.ts" },
			{ cwd: emptyDir, sessionId: "t" }
		);
		// 无服务器 → 提示文案；有服务器（全局安装）→ 也可能跑通，两者都不得抛异常
		expect(typeof out.result).toBe("string");
	}, 30_000);
});
