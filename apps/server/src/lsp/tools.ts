/**
 * LSP 工具：诊断 / 跳转定义 / 查引用。
 * 语言服务器不可用时返回明确提示（优雅降级，不影响其他工具）。
 */
import { z } from "zod";
import path from "node:path";
import type { ToolDefinition } from "../tools/index.js";
import { lspFor, isTsLike } from "./client.js";

function resolve(ctx: { cwd: string }, p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(ctx.cwd, p);
}

const UNAVAILABLE =
  "LSP 不可用：未检测到 typescript-language-server。安装：npm i -g typescript-language-server typescript（或在项目 devDependencies 中加入）。";

export const lspDiagnosticsTool: ToolDefinition = {
  name: "lsp_diagnostics",
  description: "获取 TypeScript/JavaScript 文件的语言服务器诊断（类型错误、未定义符号等）。修改代码后用它验证，而不是猜测。",
  permission: "always-allow",
  argsSchema: z.object({
    path: z.string().describe("ts/js 文件路径"),
  }),
  involvedPaths: (args) => [args.path as string],
  async execute(args, ctx) {
    const file = resolve(ctx, args.path as string);
    if (!isTsLike(file)) return { result: "(仅支持 ts/tsx/js/jsx 文件)", truncated: false };
    const client = lspFor(ctx.cwd);
    if (!client) return { result: UNAVAILABLE, truncated: false };
    const diags = await client.diagnostics(file);
    if (diags === null) return { result: UNAVAILABLE, truncated: false };
    if (diags.length === 0) return { result: `${file}: 无诊断（干净）`, truncated: false };
    const lines = diags.map(
      (d) => `${d.severity.toUpperCase()} ${d.line}:${d.character} ${d.message}${d.source ? ` [${d.source}]` : ""}`,
    );
    return { result: `${file} 共 ${diags.length} 条诊断:\n${lines.join("\n")}`, truncated: false };
  },
};

export const lspDefinitionTool: ToolDefinition = {
  name: "lsp_definition",
  description: "跳转到符号的定义位置。",
  permission: "always-allow",
  argsSchema: z.object({
    path: z.string(),
    line: z.number().int().min(1),
    character: z.number().int().min(1),
  }),
  involvedPaths: (args) => [args.path as string],
  async execute(args, ctx) {
    const file = resolve(ctx, args.path as string);
    const client = lspFor(ctx.cwd);
    if (!client || !isTsLike(file)) return { result: UNAVAILABLE, truncated: false };
    const locs = await client.definition(file, args.line as number, args.character as number);
    if (!locs) return { result: UNAVAILABLE, truncated: false };
    if (locs.length === 0) return { result: "(未找到定义)", truncated: false };
    return { result: locs.map((l) => `${l.file}:${l.line}:${l.character}`).join("\n"), truncated: false };
  },
};

export const lspReferencesTool: ToolDefinition = {
  name: "lsp_references",
  description: "查找符号的所有引用位置。",
  permission: "always-allow",
  argsSchema: z.object({
    path: z.string(),
    line: z.number().int().min(1),
    character: z.number().int().min(1),
  }),
  involvedPaths: (args) => [args.path as string],
  async execute(args, ctx) {
    const file = resolve(ctx, args.path as string);
    const client = lspFor(ctx.cwd);
    if (!client || !isTsLike(file)) return { result: UNAVAILABLE, truncated: false };
    const locs = await client.references(file, args.line as number, args.character as number);
    if (!locs) return { result: UNAVAILABLE, truncated: false };
    if (locs.length === 0) return { result: "(未找到引用)", truncated: false };
    const shown = locs.slice(0, 50).map((l) => `${l.file}:${l.line}:${l.character}`);
    return {
      result: `${locs.length} 处引用:\n${shown.join("\n")}`,
      truncated: locs.length > 50,
    };
  },
};
