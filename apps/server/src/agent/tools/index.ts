/**
 * 内置工具集：read / write / edit / bash / glob / grep。
 * 设计原则：
 * - 外科式编辑（str_replace），禁止整文件重写（write 仅限新建/显式覆盖）
 * - 大文件分页读（带行号窗口）
 * - 每个工具声明权限级别，由权限服务统一裁决
 */
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export interface ToolContext {
  sessionId: string;
  cwd: string;
  /** bash 长输出分片回调（写 tool.call.output_delta 事件） */
  onOutputChunk?: (chunk: string) => void;
  /** memory_write 落盘后回调（写 memory.written 事件） */
  onMemoryWritten?: (file: string, excerpt: string, reason: string) => void;
  /** task 工具：派生子代理（上下文隔离，返回浓缩结论）。由 Loop 注入。 */
  spawnSubagent?: (task: string, parentCallId: string) => Promise<string>;
}

export interface ToolResult {
  result: string;
  truncated: boolean;
  sideEffects?: {
    files_written?: string[];
    diff?: string;
    commit?: string;
  };
}

type Args = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  argsSchema: z.ZodType;
  /** 权限级别：always-allow 放行 / workspace-write 工作区内放行 / always-ask 逐条询问 */
  permission: "always-allow" | "workspace-write" | "always-ask";
  /** 从参数中提取涉及的文件路径（供权限服务判断越界与敏感路径） */
  involvedPaths?: (args: Args) => string[];
  riskSummary?: (args: Args) => string;
  execute: (args: Args, ctx: ToolContext) => Promise<ToolResult>;
}

const MAX_OUTPUT = 32 * 1024; // 32KB，超过则截断（大 payload 策略的简化版）

function truncate(text: string): { result: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT) return { result: text, truncated: false };
  return {
    result: text.slice(0, MAX_OUTPUT) + `\n… [输出过长已截断，共 ${text.length} 字符]`,
    truncated: true,
  };
}

function resolveIn(ctx: ToolContext, p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(ctx.cwd, p);
}

// ---------- read ----------
const readTool: ToolDefinition = {
  name: "read",
  description:
    "读取文件内容，返回带行号的窗口。大文件必须用 offset/limit 分页读取，不要一次读整个文件。",
  permission: "always-allow",
  argsSchema: z.object({
    path: z.string().describe("文件路径（相对工作目录或绝对路径）"),
    offset: z.number().int().min(1).default(1).describe("起始行号（1 起）"),
    limit: z.number().int().min(1).max(500).default(200).describe("读取行数，最多 500"),
  }),
  involvedPaths: (args) => [args.path as string],
  async execute(args, ctx) {
    const p = resolveIn(ctx, args.path as string);
    const content = fs.readFileSync(p, "utf-8");
    const lines = content.split("\n");
    const offset = (args.offset as number) ?? 1;
    const limit = (args.limit as number) ?? 200;
    const window = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = window.map((l, i) => `${offset + i}\t${l}`).join("\n");
    const header = `[${p} 共 ${lines.length} 行，显示 ${offset}-${offset + window.length - 1}]`;
    return truncate(`${header}\n${numbered}`);
  },
};

// ---------- write ----------
const writeTool: ToolDefinition = {
  name: "write",
  description: "创建新文件或完整覆盖已有文件。修改已有文件优先使用 edit（外科式编辑）。",
  permission: "workspace-write",
  argsSchema: z.object({
    path: z.string(),
    content: z.string(),
  }),
  involvedPaths: (args) => [args.path as string],
  riskSummary: (args) => `写入文件 ${args.path}（${(args.content as string).length} 字符）`,
  async execute(args, ctx) {
    const p = resolveIn(ctx, args.path as string);
    const existed = fs.existsSync(p);
    const before = existed ? fs.readFileSync(p, "utf-8") : "";
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, args.content as string, "utf-8");
    return {
      result: `已写入 ${p}（${existed ? "覆盖" : "新建"}）`,
      truncated: false,
      sideEffects: { files_written: [p], diff: simpleDiff(before, args.content as string, p) },
    };
  },
};

// ---------- edit ----------
const editTool: ToolDefinition = {
  name: "edit",
  description: "外科式编辑：将文件中的 old_string 替换为 new_string。old_string 必须在文件中唯一（除非 replace_all）。",
  permission: "workspace-write",
  argsSchema: z.object({
    path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().default(false),
  }),
  involvedPaths: (args) => [args.path as string],
  riskSummary: (args) => `编辑文件 ${args.path}`,
  async execute(args, ctx) {
    const p = resolveIn(ctx, args.path as string);
    const before = fs.readFileSync(p, "utf-8");
    const oldStr = args.old_string as string;
    const newStr = args.new_string as string;
    const occurrences = before.split(oldStr).length - 1;
    if (occurrences === 0) throw new Error(`old_string 在 ${p} 中未找到`);
    if (occurrences > 1 && !args.replace_all) {
      throw new Error(`old_string 在 ${p} 中出现 ${occurrences} 次，请提供更多上下文使其唯一，或设 replace_all=true`);
    }
    const after = args.replace_all ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);
    fs.writeFileSync(p, after, "utf-8");
    return {
      result: `已编辑 ${p}（替换 ${args.replace_all ? occurrences : 1} 处）`,
      truncated: false,
      sideEffects: { files_written: [p], diff: simpleDiff(before, after, p) },
    };
  },
};

// ---------- bash ----------
const bashTool: ToolDefinition = {
  name: "bash",
  description: "在工作目录中执行 shell 命令。默认需要用户逐条批准。",
  permission: "always-ask",
  argsSchema: z.object({
    command: z.string(),
    timeout_ms: z.number().int().max(120000).default(30000),
  }),
  riskSummary: (args) => `执行命令: ${args.command}`,
  async execute(args, ctx) {
    const command = args.command as string;
    const timeout = (args.timeout_ms as number) ?? 30000;
    return new Promise<ToolResult>((resolvePromise, reject) => {
      const proc = spawn("bash", ["-c", command], { cwd: ctx.cwd });
      let out = "";
      const onData = (chunk: Buffer) => {
        const s = chunk.toString();
        out += s;
        ctx.onOutputChunk?.(s);
      };
      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`命令超时（${timeout}ms）`));
      }, timeout);
      proc.on("close", (code) => {
        clearTimeout(timer);
        const { result, truncated } = truncate(out || "(无输出)");
        resolvePromise({
          result: `[退出码 ${code}]\n${result}`,
          truncated,
        });
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  },
};

// ---------- glob ----------
const globTool: ToolDefinition = {
  name: "glob",
  description: "按 glob 模式匹配文件路径（如 **/*.ts）。",
  permission: "always-allow",
  argsSchema: z.object({
    pattern: z.string(),
    path: z.string().default("."),
  }),
  async execute(args, ctx) {
    const base = resolveIn(ctx, args.path as string);
    const glob = new Bun.Glob(args.pattern as string);
    const matches: string[] = [];
    for await (const f of glob.scan({ cwd: base, onlyFiles: true })) {
      matches.push(f);
      if (matches.length >= 200) break;
    }
    return truncate(matches.join("\n") || "(无匹配)");
  },
};

// ---------- grep ----------
const grepTool: ToolDefinition = {
  name: "grep",
  description: "在文件中搜索正则模式，返回 文件:行号:内容。",
  permission: "always-allow",
  argsSchema: z.object({
    pattern: z.string(),
    path: z.string().default("."),
    glob: z.string().optional(),
    max_results: z.number().int().max(100).default(30),
  }),
  async execute(args, ctx) {
    const base = resolveIn(ctx, args.path as string);
    const re = new RegExp(args.pattern as string);
    const g = new Bun.Glob((args.glob as string) ?? "**/*");
    const hits: string[] = [];
    const max = (args.max_results as number) ?? 30;
    for await (const f of g.scan({ cwd: base, onlyFiles: true })) {
      if (hits.length >= max) break;
      if (f.includes("node_modules") || f.includes("/.git/")) continue;
      try {
        const content = fs.readFileSync(path.join(base, f), "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push(`${f}:${i + 1}:${lines[i].slice(0, 200)}`);
            if (hits.length >= max) break;
          }
        }
      } catch {
        // 二进制或不可读文件跳过
      }
    }
    return truncate(hits.join("\n") || "(无匹配)");
  },
};

// ---------- 极简 unified diff（展示用，非严格 patch 格式） ----------
function simpleDiff(before: string, after: string, filePath: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
  const max = Math.max(a.length, b.length);
  let shown = 0;
  for (let i = 0; i < max && shown < 200; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined && (b[i] === undefined || a[i] !== b[i])) {
      if (a[i] !== undefined) { out.push(`-${a[i]}`); shown++; }
      if (b[i] !== undefined && b[i] !== a[i]) { out.push(`+${b[i]}`); shown++; }
    }
  }
  if (out.length === 2) out.push("(无文本差异)");
  return out.join("\n");
}

// ---------- memory_write ----------
const memoryWriteTool: ToolDefinition = {
  name: "memory_write",
  description:
    "把长期事实写入项目记忆（.agent/memory.md）：架构决策、用户偏好、环境常量。事实产生时立即写入，不要等压缩。只写值得跨会话保留的内容。",
  permission: "always-allow", // 写入位置被严格限制在 .agent/memory.md，无越界风险
  argsSchema: z.object({
    entry: z.string().describe("要记住的事实，一两句话"),
    reason: z.string().describe("为什么值得记住"),
  }),
  involvedPaths: (args) => [".agent/memory.md"],
  async execute(args, ctx) {
    const memPath = path.join(ctx.cwd, ".agent", "memory.md");
    fs.mkdirSync(path.dirname(memPath), { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const line = `\n- [${date}] ${args.entry as string}（${args.reason as string}）\n`;
    fs.appendFileSync(memPath, line, "utf-8");
    ctx.onMemoryWritten?.(memPath, (args.entry as string).slice(0, 120), args.reason as string);
    return { result: `已写入记忆 ${memPath}`, truncated: false };
  },
};

// ---------- task（子代理） ----------
const taskTool: ToolDefinition = {
  name: "task",
  description:
    "把独立的子任务派给子代理：它拥有全新上下文窗口，内部完成多步探索，只把浓缩结论带回。适合大范围搜索、阅读多个文件后的归纳。禁止在子任务中再派生子代理。",
  permission: "always-allow",
  argsSchema: z.object({
    prompt: z.string().describe("给子代理的完整任务描述（它看不到当前对话，必须自包含）"),
  }),
  async execute(args, ctx) {
    if (!ctx.spawnSubagent) throw new Error("子代理不可用");
    const summary = await ctx.spawnSubagent(args.prompt as string, "");
    return truncate(summary);
  },
};

// ---------- 注册表 ----------
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * 转成模型适配层用的工具描述。
   * 模式决定工具面（Loop 不变，工具面变）：
   * plan 模式只暴露只读工具，从模型侧杜绝「还没想清楚就改文件」。
   */
  toModelSpecs(mode: "plan" | "build" = "build"): { name: string; description: string; parameters: Record<string, unknown> }[] {
    return this.list()
      .filter((t) => mode === "build" || t.permission === "always-allow")
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: z.toJSONSchema(t.argsSchema) as Record<string, unknown>,
      }));
  }
}

export function createDefaultRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of [readTool, writeTool, editTool, bashTool, globTool, grepTool, memoryWriteTool, taskTool]) {
    r.register(t);
  }
  return r;
}

/** 完整工具集：默认工具 + LSP 代码智能工具（语言服务器不可用时优雅降级） */
export async function createFullRegistry(): Promise<ToolRegistry> {
  const r = createDefaultRegistry();
  const { lspDiagnosticsTool, lspDefinitionTool, lspReferencesTool } = await import("../lsp/tools.js");
  r.register(lspDiagnosticsTool);
  r.register(lspDefinitionTool);
  r.register(lspReferencesTool);
  return r;
}
