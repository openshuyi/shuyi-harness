/**
 * bash 工具强化（P8-2，对齐 OpenCode shell 工具的社区打磨）：
 * 1. 输出压缩管线：ANSI 剥离 → 空白归一 → 连续重复行去重 → 命令专用压缩器
 *    （git/npm/cargo 等啰嗦输出先压一遍，再吃兜底截断）
 * 2. 后台任务：background: true 派生长驻进程（dev server / 长测试），
 *    bash_status 查看输出、bash_kill 终止
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./index.js";

// ---------- 输出压缩管线 ----------

/** 剥离 ANSI 转义序列（颜色/光标控制） */
export function stripAnsi(s: string): string {
	const ESC = "\u001b";
	const csi = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g"); // CSI 序列（颜色/光标）
	const osc = new RegExp(`${ESC}\\][^\u0007]*\u0007`, "g"); // OSC 序列（标题等）
	const charset = new RegExp(`${ESC}\\(B`, "g"); // 字符集切换
	return s
		.replace(osc, "")
		.replace(csi, "")
		.replace(charset, "")
		.replace(/\r/g, "");
}

const TRAILING_WS_RE = /\s+$/;
const TAB_RE = /\t/g;

/** 空白归一：连续空行压成一个、行尾空格去除、tab 转双空格 */
export function normalizeWhitespace(s: string): string {
	return s
		.split("\n")
		.map((l) => l.replace(TRAILING_WS_RE, "").replace(TAB_RE, "  "))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
}

/** 连续重复行去重（进度条、 spinner、构建日志的刷屏输出） */
export function dedupeRepeatedLines(s: string): string {
	const lines = s.split("\n");
	const out: string[] = [];
	let runLine = "";
	let runCount = 0;
	const flush = () => {
		if (runCount === 0) {
			return;
		}
		out.push(runLine);
		if (runCount > 1) {
			out.push(`  …（上一行重复 ${runCount - 1} 次，已折叠）`);
		}
		runCount = 0;
	};
	for (const line of lines) {
		// 进度条类：同一行被 \r 覆写后已并入，按内容相同判定
		if (line === runLine && line.trim() !== "") {
			runCount += 1;
		} else {
			flush();
			runLine = line;
			runCount = 1;
		}
	}
	flush();
	return out.join("\n");
}

/** 命令专用压缩器：按命令前缀匹配啰嗦输出的已知模式 */
const HINT_OR_REMOTE_RE = /^(hint|remote):/;
const NPM_KEPT_RE =
	/error|ERR!|warn|WARN|failed|passed|Tests:|Suites:|added \d+|removed \d+|up to date|✓|✗|FAIL|PASS/i;
const CARGO_NOISE_RE = /^\s*(Compiling|Downloading|Downloaded|Updating)\s/;
const COMMAND_COMPACTERS: {
	pattern: RegExp;
	compact: (s: string) => string;
}[] = [
	{
		compact: (s) =>
			s
				.split("\n")
				.filter((l) => !HINT_OR_REMOTE_RE.test(l.trim()))
				.join("\n"),
		// git：砍掉 hint/advice 段落和 remote 进度行
		pattern: /^\s*git\s/,
	},
	{
		compact: (s) => {
			const lines = s.split("\n");
			const kept = lines.filter((l) => NPM_KEPT_RE.test(l));
			// 保留的太少（说明命令输出本来就不啰嗦）→ 返回原文
			return kept.length >= 3 && kept.length < lines.length * 0.7
				? kept.join("\n")
				: s;
		},
		// npm/pnpm/yarn：只保留错误、警告与结尾摘要
		pattern: /^\s*(npm|pnpm|yarn|bun)\s+(install|i|add|remove|test|run)/,
	},
	{
		compact: (s) =>
			s
				.split("\n")
				.filter((l) => !CARGO_NOISE_RE.test(l))
				.join("\n"),
		// cargo：砍 Compiling/Downloading 刷屏，留 error/warning/Finished
		pattern: /^\s*cargo\s/,
	},
];

/** 完整压缩管线：依次应用各阶段，返回压缩后文本 */
export function compressOutput(raw: string, command: string): string {
	let s = stripAnsi(raw);
	s = normalizeWhitespace(s);
	s = dedupeRepeatedLines(s);
	for (const { pattern, compact } of COMMAND_COMPACTERS) {
		if (pattern.test(command)) {
			s = compact(s);
			break;
		}
	}
	return s;
}

// ---------- 后台任务管理 ----------

export interface BackgroundTask {
	command: string;
	cwd: string;
	exitCode: number | null;
	id: string;
	output: string;
	proc: ChildProcess;
	/** 被信号终止时的信号名（如 SIGTERM），正常退出为 null */
	signal: string | null;
	startedAt: number;
}

const MAX_BG_OUTPUT = 200_000; // 后台任务输出环形缓冲上限

class BackgroundRegistry {
	private readonly tasks = new Map<string, BackgroundTask>();

	spawn(
		command: string,
		cwd: string,
		onChunk?: (s: string) => void
	): BackgroundTask {
		// detached: 让 bash 成为进程组组长，kill(-pid) 可连带杀掉它的子进程
		const proc = spawn("bash", ["-c", command], { cwd, detached: true });
		const task: BackgroundTask = {
			command,
			cwd,
			exitCode: null,
			id: randomUUID().slice(0, 8),
			output: "",
			proc,
			signal: null,
			startedAt: Date.now(),
		};
		const onData = (chunk: Buffer) => {
			const s = chunk.toString();
			// 环形缓冲：超出上限保留尾部
			task.output = (task.output + s).slice(-MAX_BG_OUTPUT);
			onChunk?.(s);
		};
		proc.stdout.on("data", onData);
		proc.stderr.on("data", onData);
		proc.on("close", (code, signal) => {
			// 被信号杀死时 code 为 null：记录信号并以 -1 标记“被终止”，避免永远显示“运行中”
			task.signal = signal ?? null;
			task.exitCode = code ?? (signal ? -1 : 0);
		});
		this.tasks.set(task.id, task);
		return task;
	}

	get(id: string): BackgroundTask | undefined {
		return this.tasks.get(id);
	}

	list(): BackgroundTask[] {
		return [...this.tasks.values()];
	}

	kill(id: string): boolean {
		const t = this.tasks.get(id);
		if (!t) {
			return false;
		}
		if (t.exitCode === null) {
			// 优先杀整个进程组（bash -c 的子进程如 sleep 也会收到信号）；
			// Bun spawn 默认不建进程组时退化到单进程 SIGTERM→SIGKILL 升级
			const { pid } = t.proc;
			try {
				if (pid) {
					process.kill(-pid, "SIGTERM");
				} else {
					t.proc.kill("SIGTERM");
				}
			} catch {
				t.proc.kill("SIGTERM");
			}
			// 3 秒仍未退出则升级 SIGKILL
			setTimeout(() => {
				if (t.exitCode === null) {
					try {
						if (pid) {
							process.kill(-pid, "SIGKILL");
						} else {
							t.proc.kill("SIGKILL");
						}
					} catch {
						t.proc.kill("SIGKILL");
					}
				}
			}, 3000).unref?.();
		}
		return true;
	}
}

/** 全局后台任务注册表（server 进程级共享） */
export const backgroundTasks = new BackgroundRegistry();

/** 状态文本：运行中 / 已退出 N / 已被 SIGxxx 终止 */
function statusText(t: BackgroundTask): string {
	if (t.exitCode === null) {
		return "运行中";
	}
	if (t.signal) {
		return `已被 ${t.signal} 终止`;
	}
	return `已退出 ${t.exitCode}`;
}

// ---------- 工具定义 ----------

function truncate(
	s: string,
	max = 30_000
): { result: string; truncated: boolean } {
	if (s.length <= max) {
		return { result: s, truncated: false };
	}
	const head = s.slice(0, Math.floor(max * 0.3));
	const tail = s.slice(-Math.floor(max * 0.7));
	return {
		result: `${head}\n\n…（中间 ${s.length - head.length - tail.length} 字符已截断）…\n\n${tail}`,
		truncated: true,
	};
}

export const bashTool: ToolDefinition = {
	argsSchema: z.object({
		background: z
			.boolean()
			.default(false)
			.describe("后台派生长驻进程，返回任务 id"),
		command: z.string(),
		timeout_ms: z.number().int().max(120_000).default(30_000),
	}),
	description:
		"在工作目录中执行 shell 命令。默认需要用户逐条批准。输出会经压缩管线（ANSI 剥离/重复行折叠/命令专用压缩）。长驻进程（dev server 等）用 background: true 派生后用 bash_status 查看。",
	execute(args, ctx) {
		const command = args.command as string;
		const timeout = (args.timeout_ms ?? 30_000) as number;

		// 后台派生：立即返回任务 id
		if (args.background) {
			const task = backgroundTasks.spawn(command, ctx.cwd);
			return Promise.resolve({
				result: `已后台启动（任务 id: ${task.id}）。用 bash_status 查看输出、bash_kill 终止。`,
				sideEffects: { background_task: task.id },
				truncated: false,
			});
		}

		return new Promise<ToolResult>((resolvePromise, reject) => {
			const proc = spawn("bash", ["-c", command], { cwd: ctx.cwd });
			let out = "";
			// 串行化分片回调（onOutputChunk 现可为异步），保证 output_delta 顺序
			let chunkChain = Promise.resolve();
			const onData = (chunk: Buffer) => {
				const s = chunk.toString();
				out += s;
				chunkChain = chunkChain.then(() => ctx.onOutputChunk?.(s));
			};
			proc.stdout.on("data", onData);
			proc.stderr.on("data", onData);
			const timer = setTimeout(() => {
				proc.kill("SIGTERM");
				reject(new Error(`命令超时（${timeout}ms）`));
			}, timeout);
			proc.on("close", (code) => {
				clearTimeout(timer);
				// 等所有分片事件落库后再完成，保证 output_delta 先于 completed
				// biome-ignore lint/complexity/noVoid: close 回调内分片链式落库后完成 promise，故意 fire-and-forget
				void chunkChain
					.then(() => {
						const compressed = compressOutput(out || "(无输出)", command);
						const { result, truncated } = truncate(compressed);
						resolvePromise({
							result: `[退出码 ${code}]\n${result}`,
							truncated,
						});
					})
					.catch(() => {
						const compressed = compressOutput(out || "(无输出)", command);
						const { result, truncated } = truncate(compressed);
						resolvePromise({
							result: `[退出码 ${code}]\n${result}`,
							truncated,
						});
					});
			});
			proc.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		});
	},
	name: "bash",
	permission: "always-ask",
	riskSummary: (args) =>
		`执行命令: ${args.command}${args.background ? "（后台）" : ""}`,
};

export const bashStatusTool: ToolDefinition = {
	argsSchema: z.object({
		id: z.string().optional().describe("后台任务 id；缺省列出全部"),
		tail_chars: z
			.number()
			.int()
			.max(30_000)
			.default(8000)
			.describe("只看输出尾部 N 字符"),
	}),
	description:
		"查看后台任务（bash background 派生）的输出与状态；不传 id 则列出全部。",
	execute(args) {
		const tail = (args.tail_chars ?? 8000) as number;
		if (!args.id) {
			const all = backgroundTasks.list();
			if (all.length === 0) {
				return Promise.resolve({ result: "(无后台任务)", truncated: false });
			}
			const lines = all.map(
				(task) =>
					`${task.id}  [${statusText(task)}]  ${task.command.slice(0, 80)}（启动于 ${new Date(task.startedAt).toLocaleTimeString("zh-CN")}）`
			);
			return Promise.resolve({ result: lines.join("\n"), truncated: false });
		}
		const t = backgroundTasks.get(args.id as string);
		if (!t) {
			return Promise.resolve({
				result: `后台任务不存在: ${args.id}`,
				truncated: false,
			});
		}
		const output = compressOutput(t.output.slice(-tail), t.command);
		return Promise.resolve({
			result: `任务 ${t.id} [${statusText(t)}] ${t.command}\n--- 输出（尾部）---\n${output || "(暂无输出)"}`,
			truncated: false,
		});
	},
	name: "bash_status",
	permission: "always-allow",
};

export const bashKillTool: ToolDefinition = {
	argsSchema: z.object({
		id: z.string().describe("后台任务 id"),
	}),
	description: "终止后台任务（bash background 派生的进程）。",
	execute(args) {
		const ok = backgroundTasks.kill(args.id as string);
		return Promise.resolve({
			result: ok
				? `已发送 SIGTERM 到任务 ${args.id}`
				: `后台任务不存在: ${args.id}`,
			truncated: false,
		});
	},
	name: "bash_kill",
	permission: "always-ask",
	riskSummary: (args) => `终止后台任务: ${args.id}`,
};
