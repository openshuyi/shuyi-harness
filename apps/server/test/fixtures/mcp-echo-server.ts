/**
 * MCP 测试夹具：最小 echo server（stdio）。
 * 提供 ping 工具：原样返回输入文本。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-fixture", version: "0.1.0" });

server.registerTool(
  "ping",
  {
    description: "原样返回输入",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: "text", text: `pong: ${text}` }],
  }),
);

await server.connect(new StdioServerTransport());
