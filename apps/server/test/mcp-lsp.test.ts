/**
 * P3：MCP 客户端与 LSP 代码智能。
 * MCP：连接 echo fixture server → 工具桥接 → 调用返回 pong。
 * LSP：typescript-language-server 存在时跑真诊断；不存在则验证优雅降级。
 */
import { describe, expect, test, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDefaultRegistry } from "../src/tools/index.js";
import { connectMcpServers } from "../src/mcp/index.js";
import { detectTsServer, lspFor } from "../src/lsp/client.js";
import { lspDiagnosticsTool } from "../src/lsp/tools.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mcplsp-"));

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("P3：MCP 客户端", () => {
  test("连接 echo server，工具桥接并可调用", async () => {
    const configPath = path.join(tmp, "mcp.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        servers: [
          {
            name: "echo",
            command: process.execPath, // bun 自身
            args: [path.join(import.meta.dir, "fixtures", "mcp-echo-server.ts")],
          },
        ],
      }),
    );

    const registry = createDefaultRegistry();
    const { connected, failed } = await connectMcpServers(registry, configPath);
    expect(failed).toEqual([]);
    expect(connected.length).toBe(1);

    const tool = registry.get("mcp_echo_ping");
    expect(tool).toBeDefined();
    expect(tool!.permission).toBe("always-ask"); // MCP 默认逐条确认

    const out = await tool!.execute({ text: "hello-mcp" }, { sessionId: "t", cwd: tmp });
    expect(out.result).toContain("pong: hello-mcp");
  }, 30000);

  test("配置不存在时优雅降级（返回空）", async () => {
    const registry = createDefaultRegistry();
    const { connected, failed } = await connectMcpServers(registry, path.join(tmp, "nonexistent.json"));
    expect(connected).toEqual([]);
    expect(failed).toEqual([]);
  });
});

describe("P3：LSP 代码智能", () => {
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const hasServer = detectTsServer(repoRoot) !== null;

  test("诊断：有类型错误的文件返回 error，干净文件返回无诊断", async () => {
    if (!hasServer) {
      console.log("跳过：typescript-language-server 不可用");
      return;
    }
    const badFile = path.join(tmp, "bad.ts");
    fs.writeFileSync(badFile, "const x: number = 'not a number';\nexport default x;\n");

    const client = lspFor(repoRoot)!;
    const diags = await client.diagnostics(badFile, 15000);
    expect(diags).not.toBeNull();
    expect(diags!.some((d) => d.severity === "error" && d.message.includes("string"))).toBe(true);

    const goodFile = path.join(tmp, "good.ts");
    fs.writeFileSync(goodFile, "export const y: number = 42;\n");
    const diags2 = await client.diagnostics(goodFile, 15000);
    expect(diags2).not.toBeNull();
    expect(diags2!.filter((d) => d.severity === "error").length).toBe(0);
  }, 60000);

  test("工具层：不可用环境返回明确提示而非崩溃", async () => {
    // 用一个没有语言服务器的目录
    const emptyDir = path.join(tmp, "empty-ws");
    fs.mkdirSync(emptyDir, { recursive: true });
    const out = await lspDiagnosticsTool.execute(
      { path: "x.ts" },
      { sessionId: "t", cwd: emptyDir },
    );
    // 无服务器 → 提示文案；有服务器（全局安装）→ 也可能跑通，两者都不得抛异常
    expect(typeof out.result).toBe("string");
  }, 30000);
});
