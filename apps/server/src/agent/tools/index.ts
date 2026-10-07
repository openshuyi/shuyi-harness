/**
 * 内置工具集：read / write / edit / bash / glob / grep。
 * 设计原则：
 * - 外科式编辑（str_replace），禁止整文件重写（write 仅限新建/显式覆盖）
 * - 大文件分页读（带行号窗口）
 * - 每个工具声明权限级别，由权限服务统一裁决
 */

import fs from "node:fs";
import path from "node:path";
import type { TodoItem } from "@shuyi-harness/types";
import { z } from "zod";
import { bashKillTool, bashStatusTool, bashTool } from "./bash.js";
import { todoreadTool, todowriteTool } from "./todo.js";

export interface ToolContext {
	cwd: string;
	/** memory_write 落盘后回调（写 memory.written 事件） */
	onMemoryWritten?: (
		file: string,
		excerpt: string,
		reason: string
	) => void | Promise<void>;
	/** bash 长输出分片回调（写 tool.call.output_delta 事件） */
	onOutputChunk?: (chunk: string) => void | Promise<void>;
	sessionId: string;
	/** task 工具：派生子代理（上下文隔离，返回浓缩结论）。由 Loop 注入；agentName 指定代理定义。 */
	spawnSubagent?: (
		task: string,
		parentCallId: string,
		agentName?: string
	) => Promise<string>;
	/**
	 * M1：会话级任务清单。由 Loop 注入（write 时落 todo.list_updated 事件）；
	 * 子代理上下文不注入——子代理不继承父 todo 列表。
	 */
	todos?: {
		read: () => TodoItem[];
		/** 全量覆盖 */
		write: (todos: TodoItem[]) => void | Promise<void>;
	};
}

export interface ToolResult {
	result: string;
	sideEffects?: {
		files_written?: string[];
		diff?: string;
		commit?: string;
		/** bash background 派生的后台任务 id */
		background_task?: string;
	};
	truncated: boolean;
}

type Args = Record<string, unknown>;

export interface ToolDefinition {
	argsSchema: z.ZodType;
	description: string;
	execute: (args: Args, ctx: ToolContext) => Promise<ToolResult>;
	/** 从参数中提取涉及的文件路径（供权限服务判断越界与敏感路径） */
	involvedPaths?: (args: Args) => string[];
	/** M4：从参数中提取出站 URL（供权限服务做 SSRF deny_builtin 检查） */
	involvedUrls?: (args: Args) => string[];
	name: string;
	/** 权限级别：always-allow 放行 / workspace-write 工作区内放行 / always-ask 逐条询问 */
	permission: "always-allow" | "workspace-write" | "always-ask";
	riskSummary?: (args: Args) => string;
	/** M4：false 时对子代理隐藏（子代理直接执行、无审批流，联网工具默认不进子代理工具面） */
	subagentVisible?: boolean;
}

const MAX_OUTPUT = 32 * 1024; // 32KB，超过则截断（大 payload 策略的简化版）

function truncate(text: string): { result: string; truncated: boolean } {
	if (text.length <= MAX_OUTPUT) {
		return { result: text, truncated: false };
	}
	return {
		result:
			text.slice(0, MAX_OUTPUT) +
			`\n… [输出过长已截断，共 ${text.length} 字符]`,
		truncated: true,
	};
}

function resolveIn(ctx: ToolContext, p: string): string {
	return path.isAbsolute(p) ? path.normalize(p) : path.resolve(ctx.cwd, p);
}

// ---------- read ----------
const readTool: ToolDefinition = {
	argsSchema: z.object({
		limit: z
			.number()
			.int()
			.min(1)
			.max(500)
			.default(200)
			.describe("读取行数，最多 500"),
		offset: z.number().int().min(1).default(1).describe("起始行号（1 起）"),
		path: z.string().describe("文件路径（相对工作目录或绝对路径）"),
	}),
	description:
		"读取文件内容，返回带行号的窗口。大文件必须用 offset/limit 分页读取，不要一次读整个文件。",
	execute(args, ctx) {
		const p = resolveIn(ctx, args.path as string);
		const content = fs.readFileSync(p, "utf-8");
		const lines = content.split("\n");
		const offset = (args.offset ?? 1) as number;
		const limit = (args.limit ?? 200) as number;
		const window = lines.slice(offset - 1, offset - 1 + limit);
		const numbered = window.map((l, i) => `${offset + i}\t${l}`).join("\n");
		const header = `[${p} 共 ${lines.length} 行，显示 ${offset}-${offset + window.length - 1}]`;
		return Promise.resolve(truncate(`${header}\n${numbered}`));
	},
	involvedPaths: (args) => [args.path as string],
	name: "read",
	permission: "always-allow",
};

// ---------- write ----------
const writeTool: ToolDefinition = {
	argsSchema: z.object({
		content: z.string(),
		path: z.string(),
	}),
	description:
		"创建新文件或完整覆盖已有文件。修改已有文件优先使用 edit（外科式编辑）。",
	execute(args, ctx) {
		const p = resolveIn(ctx, args.path as string);
		const existed = fs.existsSync(p);
		const before = existed ? fs.readFileSync(p, "utf-8") : "";
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, args.content as string, "utf-8");
		return Promise.resolve({
			result: `已写入 ${p}（${existed ? "覆盖" : "新建"}）`,
			sideEffects: {
				diff: simpleDiff(before, args.content as string, p),
				files_written: [p],
			},
			truncated: false,
		});
	},
	involvedPaths: (args) => [args.path as string],
	name: "write",
	permission: "workspace-write",
	riskSummary: (args) =>
		`写入文件 ${args.path}（${(args.content as string).length} 字符）`,
};

// ---------- edit ----------
const editTool: ToolDefinition = {
	argsSchema: z.object({
		new_string: z.string(),
		old_string: z.string(),
		path: z.string(),
		replace_all: z.boolean().default(false),
	}),
	description:
		"外科式编辑：将文件中的 old_string 替换为 new_string。old_string 必须在文件中唯一（除非 replace_all）。",
	execute(args, ctx) {
		const p = resolveIn(ctx, args.path as string);
		const before = fs.readFileSync(p, "utf-8");
		const oldStr = args.old_string as string;
		const newStr = args.new_string as string;
		const occurrences = before.split(oldStr).length - 1;
		if (occurrences === 0) {
			throw new Error(`old_string 在 ${p} 中未找到`);
		}
		if (occurrences > 1 && !args.replace_all) {
			throw new Error(
				`old_string 在 ${p} 中出现 ${occurrences} 次，请提供更多上下文使其唯一，或设 replace_all=true`
			);
		}
		const after = args.replace_all
			? before.split(oldStr).join(newStr)
			: before.replace(oldStr, newStr);
		fs.writeFileSync(p, after, "utf-8");
		return Promise.resolve({
			result: `已编辑 ${p}（替换 ${args.replace_all ? occurrences : 1} 处）`,
			sideEffects: { diff: simpleDiff(before, after, p), files_written: [p] },
			truncated: false,
		});
	},
	involvedPaths: (args) => [args.path as string],
	name: "edit",
	permission: "workspace-write",
	riskSummary: (args) => `编辑文件 ${args.path}`,
};

// ---------- glob ----------
const globTool: ToolDefinition = {
	argsSchema: z.object({
		path: z.string().default("."),
		pattern: z.string(),
	}),
	description: "按 glob 模式匹配文件路径（如 **/*.ts）。",
	async execute(args, ctx) {
		const base = resolveIn(ctx, args.path as string);
		const glob = new Bun.Glob(args.pattern as string);
		const matches: string[] = [];
		for await (const f of glob.scan({ cwd: base, onlyFiles: true })) {
			matches.push(f);
			if (matches.length >= 200) {
				break;
			}
		}
		return truncate(matches.join("\n") || "(无匹配)");
	},
	name: "glob",
	permission: "always-allow",
};

// ---------- grep ----------
const grepTool: ToolDefinition = {
	argsSchema: z.object({
		glob: z.string().optional(),
		max_results: z.number().int().max(100).default(30),
		path: z.string().default("."),
		pattern: z.string(),
	}),
	description: "在文件中搜索正则模式，返回 文件:行号:内容。",
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: grep 逐文件扫描与过滤，平移自 v0.x 成熟实现，保持 1:1
	async execute(args, ctx) {
		const base = resolveIn(ctx, args.path as string);
		const re = new RegExp(args.pattern as string);
		const g = new Bun.Glob((args.glob ?? "**/*") as string);
		const hits: string[] = [];
		const max = (args.max_results ?? 30) as number;
		for await (const f of g.scan({ cwd: base, onlyFiles: true })) {
			if (hits.length >= max) {
				break;
			}
			if (f.includes("node_modules") || f.includes("/.git/")) {
				continue;
			}
			try {
				const content = fs.readFileSync(path.join(base, f), "utf-8");
				const lines = content.split("\n");
				for (let i = 0; i < lines.length; i += 1) {
					const line = lines[i];
					if (line !== undefined && re.test(line)) {
						hits.push(`${f}:${i + 1}:${line.slice(0, 200)}`);
						if (hits.length >= max) {
							break;
						}
					}
				}
			} catch {
				// 二进制或不可读文件跳过
			}
		}
		return truncate(hits.join("\n") || "(无匹配)");
	},
	name: "grep",
	permission: "always-allow",
};

// ---------- 极简 unified diff（展示用，非严格 patch 格式） ----------
function simpleDiff(before: string, after: string, filePath: string): string {
	const a = before.split("\n");
	const b = after.split("\n");
	const out: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
	const max = Math.max(a.length, b.length);
	let shown = 0;
	for (let i = 0; i < max && shown < 200; i += 1) {
		if (a[i] === b[i]) {
			continue;
		}
		if (a[i] !== undefined && (b[i] === undefined || a[i] !== b[i])) {
			if (a[i] !== undefined) {
				out.push(`-${a[i]}`);
				shown += 1;
			}
			if (b[i] !== undefined && b[i] !== a[i]) {
				out.push(`+${b[i]}`);
				shown += 1;
			}
		}
	}
	if (out.length === 2) {
		out.push("(无文本差异)");
	}
	return out.join("\n");
}

// ---------- memory_write ----------
const memoryWriteTool: ToolDefinition = {
	argsSchema: z.object({
		entry: z.string().describe("要记住的事实，一两句话"),
		reason: z.string().describe("为什么值得记住"),
	}),
	description:
		"把长期事实写入项目记忆（.agent/memory.md）：架构决策、用户偏好、环境常量。事实产生时立即写入，不要等压缩。只写值得跨会话保留的内容。",
	execute(args, ctx) {
		const memPath = path.join(ctx.cwd, ".agent", "memory.md");
		fs.mkdirSync(path.dirname(memPath), { recursive: true });
		const date = new Date().toISOString().slice(0, 10);
		const line = `\n- [${date}] ${args.entry as string}（${args.reason as string}）\n`;
		fs.appendFileSync(memPath, line, "utf-8");
		ctx.onMemoryWritten?.(
			memPath,
			(args.entry as string).slice(0, 120),
			args.reason as string
		);
		return Promise.resolve({
			result: `已写入记忆 ${memPath}`,
			truncated: false,
		});
	},
	involvedPaths: () => [".agent/memory.md"],
	name: "memory_write",
	permission: "always-allow", // 写入位置被严格限制在 .agent/memory.md，无越界风险
};

// ---------- task（子代理） ----------
const taskTool: ToolDefinition = {
	argsSchema: z.object({
		agent: z
			.string()
			.optional()
			.describe("代理定义名（如 explore），缺省为 explore"),
		prompt: z
			.string()
			.describe("给子代理的完整任务描述（它看不到当前对话，必须自包含）"),
	}),
	description:
		"把独立的子任务派给子代理：它拥有全新上下文窗口，内部完成多步探索，只把浓缩结论带回。适合大范围搜索、阅读多个文件后的归纳。可用 agent 参数指定代理定义（默认 explore，可用 ~/.agent/agents/*.md 自定义）。禁止在子任务中再派生子代理。",
	async execute(args, ctx) {
		if (!ctx.spawnSubagent) {
			throw new Error("子代理不可用");
		}
		const summary = await ctx.spawnSubagent(
			args.prompt as string,
			"",
			args.agent as string | undefined
		);
		return truncate(summary);
	},
	name: "task",
	permission: "always-allow",
};

// ---------- 注册表 ----------
export class ToolRegistry {
	private readonly tools = new Map<string, ToolDefinition>();

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
	 *
	 * M2：agentTools 为代理定义的工具面声明，在模式过滤之后叠加：
	 *   - "readonly"：只保留只读工具
	 *   - string[]：显式白名单（取交集）
	 *   - "all" / undefined：不再收窄
	 */
	toModelSpecs(
		mode: "plan" | "build" = "build",
		agentTools?: "readonly" | "all" | string[]
	): {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	}[] {
		let tools = this.list().filter(
			(t) => mode === "build" || t.permission === "always-allow"
		);
		if (agentTools === "readonly") {
			tools = tools.filter((t) => t.permission === "always-allow");
		} else if (Array.isArray(agentTools)) {
			const allow = new Set(agentTools);
			tools = tools.filter((t) => allow.has(t.name));
		}
		return tools.map((t) => ({
			description: t.description,
			name: t.name,
			parameters: z.toJSONSchema(t.argsSchema) as Record<string, unknown>,
		}));
	}
}

// ---------- question（P0：模型主动向用户提问） ----------
/**
 * 对齐 OpenCode question / Claude Code AskUserQuestion：
 * 模型在 turn 中遇到关键歧义时主动提问，而不是猜。
 * 特殊执行路径：Loop 拦截此工具，复用审批通道（approval.requested/resolved）
 * 把问题推给前端，answer 随 approval.resolved 落库；execute 仅兜底（不应到达）。
 */
const questionTool: ToolDefinition = {
	argsSchema: z.object({
		options: z
			.array(z.string())
			.max(4)
			.optional()
			.describe("可选答案（最多 4 个），用户也可自由作答"),
		question: z.string().describe("要问用户的问题，一句话说清背景与分歧点"),
	}),
	description:
		"向用户提问以澄清关键歧义。仅在答案会实质改变执行方案时使用（如多种合理实现路径、破坏性操作确认）；能自行判断的不要问。",
	execute() {
		return Promise.resolve({
			result: "[内部错误] question 工具应由 Loop 拦截处理",
			truncated: false,
		});
	},
	name: "question",
	permission: "always-allow",
	riskSummary: (args) => `模型提问：${args.question}`,
	subagentVisible: false, // 子代理无审批流，不能提问
};

// ---------- skill（P0-3：按需加载技能正文） ----------
const skillTool: ToolDefinition = {
	argsSchema: z.object({
		name: z.string().describe("技能名（系统提示「可用技能」清单中的名称）"),
	}),
	description:
		"加载指定技能的完整操作指令（技能清单见系统提示「可用技能」节）。仅当任务与技能描述匹配时调用；同一技能加载一次即可。",
	async execute(args, ctx) {
		const { loadSkills } = await import("../skills/index.js");
		const skills = loadSkills(ctx.cwd);
		const def = skills.find((s) => s.name === (args.name as string));
		if (!def) {
			const visible = skills.map((s) => s.name).join(", ") || "（无）";
			throw new Error(`技能不存在: ${String(args.name)}。可用技能：${visible}`);
		}
		// 列出技能目录中的附属文件（脚本/模板），供 read/bash 按正文指引使用
		let extras: string[] = [];
		try {
			extras = fs.readdirSync(def.dir).filter((f) => f !== "SKILL.md");
		} catch {
			// 目录不可读时忽略附属清单
		}
		const header = `[技能 ${def.name}（${def.source === "project" ? "项目" : "全局"}）已加载，目录 ${def.dir}]`;
		const footer = extras.length
			? `\n\n[技能目录附属文件：${extras.join(", ")}，可用 read/bash 使用]`
			: "";
		return truncate(`${header}\n${def.body}${footer}`);
	},
	name: "skill",
	permission: "always-allow",
};

export function createDefaultRegistry(): ToolRegistry {
	const r = new ToolRegistry();
	for (const t of [
		readTool,
		writeTool,
		editTool,
		bashTool,
		bashStatusTool,
		bashKillTool,
		globTool,
		grepTool,
		memoryWriteTool,
		taskTool,
		todowriteTool,
		todoreadTool,
		questionTool,
		skillTool,
	]) {
		r.register(t);
	}
	return r;
}

/**
 * 完整工具集：默认工具 + LSP 代码智能工具（语言服务器不可用时优雅降级）
 * + M4 联网工具（按 ~/.agent/net.json：webfetch 默认启用，websearch 默认不注册）。
 */
export async function createFullRegistry(
	opts: { home?: string; fetchFn?: typeof fetch } = {}
): Promise<ToolRegistry> {
	const r = createDefaultRegistry();
	const { lspDiagnosticsTool, lspDefinitionTool, lspReferencesTool } =
		await import("../lsp/tools.js");
	r.register(lspDiagnosticsTool);
	r.register(lspDefinitionTool);
	r.register(lspReferencesTool);
	// M4：联网工具注册开关（缺省 = 本地优先降级路径：webfetch 可用、websearch 不出现）
	const { loadNetConfig } = await import("../config/net.js");
	const { createWebfetchTool, createWebsearchTool } = await import("./web.js");
	const net = loadNetConfig(opts.home);
	if (net.webfetch.enabled) {
		r.register(createWebfetchTool(net.webfetch, { fetchFn: opts.fetchFn }));
	}
	if (net.websearch.enabled) {
		r.register(createWebsearchTool(net.websearch, { fetchFn: opts.fetchFn }));
	}
	return r;
}
