/**
 * MCP 客户端（P3）：外部工具接入，与内置工具同一权限模型。
 *
 * 配置：~/.agent/mcp.json（或 AGENT_MCP_CONFIG 指定路径）
 * {
 *   "servers": [
 *     { "name": "fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"] }
 *   ]
 * }
 *
 * 行为：
 * - 启动时并行连接所有 server，listTools 后桥接进 ToolRegistry
 * - MCP 工具默认 always-ask（外部系统行为不可预知，逐条确认）
 * - 单个 server 连接失败只告警，不影响其他 server 与主流程（优雅降级）
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition, ToolRegistry } from "../tools/index.js";

const McpServerConfig = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  /** 默认 always-ask；信任度高的 server 可显式设为 workspace-write */
  permission: z.enum(["always-ask", "workspace-write"]).default("always-ask"),
});
const McpConfig = z.object({ servers: z.array(McpServerConfig).default([]) });

export function loadMcpConfig(configPath?: string): z.infer<typeof McpConfig> {
  const p = configPath ?? process.env.AGENT_MCP_CONFIG ?? path.join(process.env.HOME ?? "/root", ".agent", "mcp.json");
  try {
    const raw = fs.readFileSync(p, "utf-8");
    return McpConfig.parse(JSON.parse(raw));
  } catch {
    return { servers: [] };
  }
}

export async function connectMcpServers(
  registry: ToolRegistry,
  configPath?: string,
): Promise<{ connected: string[]; failed: string[] }> {
  const config = loadMcpConfig(configPath);
  const connected: string[] = [];
  const failed: string[] = [];

  await Promise.all(
    config.servers.map(async (server) => {
      try {
        const transport = new StdioClientTransport({
          command: server.command,
          args: server.args,
          env: server.env ? { ...process.env, ...server.env } as Record<string, string> : undefined,
          stderr: "pipe",
        });
        const client = new Client({ name: "agent-mcp-client", version: "0.1.0" });
        await client.connect(transport);

        const { tools } = await client.listTools();
        for (const t of tools) {
          const bridged: ToolDefinition = {
            name: `mcp_${server.name}_${t.name}`,
            description: `[MCP:${server.name}] ${t.description ?? t.name}`,
            argsSchema: jsonSchemaToZod(t.inputSchema as Record<string, unknown>),
            permission: server.permission,
            riskSummary: (args) => `MCP ${server.name}.${t.name}(${JSON.stringify(args).slice(0, 150)})`,
            async execute(args) {
              const result = await client.callTool({ name: t.name, arguments: args });
              const text = (result.content as Array<{ type: string; text?: string }>)
                .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
                .join("\n");
              return { result: text || "(MCP 工具无文本输出)", truncated: false };
            },
          };
          registry.register(bridged);
        }
        connected.push(`${server.name}(${tools.length} 工具)`);
      } catch (err) {
        console.warn(`[mcp] 连接 ${server.name} 失败:`, err instanceof Error ? err.message : err);
        failed.push(server.name);
      }
    }),
  );

  return { connected, failed };
}

/** JSON Schema → Zod 的实用子集转换（覆盖 MCP 工具常见的 object/string/number/boolean/array/enum） */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  const type = schema.type as string | undefined;
  switch (type) {
    case "string": {
      let s = z.string();
      if (Array.isArray(schema.enum)) return z.enum(schema.enum as [string, ...string[]]);
      if (schema.description) s = s.describe(schema.description as string);
      return s;
    }
    case "number":
    case "integer": {
      let n = z.number();
      if (type === "integer") n = n.int();
      if (schema.description) n = n.describe(schema.description as string);
      return n;
    }
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(jsonSchemaToZod((schema.items as Record<string, unknown>) ?? {}));
    case "object":
    default: {
      const props = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
      const required = new Set((schema.required as string[]) ?? []);
      const shape: Record<string, z.ZodType> = {};
      for (const [k, v] of Object.entries(props)) {
        let field = jsonSchemaToZod(v);
        if (!required.has(k)) field = field.optional();
        shape[k] = field;
      }
      return z.object(shape).passthrough();
    }
  }
}
