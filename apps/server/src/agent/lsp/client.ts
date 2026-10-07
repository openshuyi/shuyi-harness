/**
 * 最小 LSP stdio 客户端（P3）：代码智能走语言服务器，不靠模型猜。
 * 参考 OpenCode：复用项目环境里已装的语言服务器，就像 IDE 一样。
 *
 * 当前支持：typescript-language-server（ts/tsx/js/jsx）。
 * 服务器不可用时所有方法优雅降级（返回 null），工具层给模型明确提示。
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface JsonRpcMessage {
	error?: { code: number; message: string };
	id?: number;
	jsonrpc: "2.0";
	method?: string;
	params?: unknown;
	result?: unknown;
}

export interface Diagnostic {
	character: number;
	line: number;
	message: string;
	severity: "error" | "warning" | "info";
	source?: string;
}

export interface Location {
	character: number;
	file: string;
	line: number;
}

/** 探测 typescript-language-server 是否可用（当前目录逐级向上到仓库根，再退回全局 PATH） */
export function detectTsServer(cwd: string): string[] | null {
	// monorepo/workspace 布局下 bin 常被提升到祖先目录的 node_modules/.bin
	let dir: string | undefined = cwd;
	while (dir) {
		const local = path.join(
			dir,
			"node_modules",
			".bin",
			"typescript-language-server"
		);
		const r = spawnSync(local, ["--version"], {
			encoding: "utf-8",
			timeout: 8000,
		});
		if (r.status === 0) {
			return [local, "--stdio"];
		}
		const parent = path.dirname(dir);
		dir = parent === dir ? undefined : parent;
	}
	const r = spawnSync("which", ["typescript-language-server"], {
		encoding: "utf-8",
		timeout: 8000,
	});
	if (r.status === 0) {
		return ["typescript-language-server", "--stdio"];
	}
	return null;
}

const TS_LIKE_RE = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;
const CONTENT_LENGTH_RE = /Content-Length: (\d+)/i;

function languageIdFor(file: string): string {
	if (file.endsWith(".tsx")) {
		return "typescriptreact";
	}
	if (file.endsWith(".jsx")) {
		return "javascriptreact";
	}
	if (file.endsWith(".js")) {
		return "javascript";
	}
	return "typescript";
}

/** LSP 响应可能是单位置或位置数组，统一成数组 */
function toLocationArray(result: unknown): Record<string, unknown>[] {
	const arr = Array.isArray(result) ? result : result ? [result] : [];
	return arr as Record<string, unknown>[];
}

export function isTsLike(file: string): boolean {
	return TS_LIKE_RE.test(file);
}

export class LspClient {
	private proc: ChildProcess | null = null;
	private nextId = 1;
	private buffer = Buffer.alloc(0);
	private readonly pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	private readonly diagnosticsWaiters = new Map<
		string,
		(d: Diagnostic[]) => void
	>();
	private readonly latestDiagnostics = new Map<string, Diagnostic[]>();
	private readonly openedFiles = new Set<string>();
	private ready: Promise<boolean> | null = null;

	private readonly cwd: string;
	private readonly serverCmd: string[];

	constructor(cwd: string, serverCmd: string[]) {
		this.cwd = cwd;
		this.serverCmd = serverCmd;
	}

	/** 懒启动 + initialize 握手；失败返回 false（优雅降级） */
	ensureReady(): Promise<boolean> {
		if (!this.ready) {
			this.ready = this.start().catch(() => false);
		}
		return this.ready;
	}

	private async start(): Promise<boolean> {
		const [cmd, ...args] = this.serverCmd;
		if (!cmd) {
			return false;
		}
		const proc = spawn(cmd, args, {
			cwd: this.cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc = proc;
		proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
		proc.on("exit", () => {
			this.ready = null;
			this.proc = null;
			for (const p of this.pending.values()) {
				p.reject(new Error("语言服务器退出"));
			}
			this.pending.clear();
		});

		const init = await this.request("initialize", {
			capabilities: {
				textDocument: {
					definition: {},
					publishDiagnostics: {},
					references: {},
				},
			},
			processId: process.pid,
			rootUri: `file://${this.cwd}`,
			workspaceFolders: [
				{ name: path.basename(this.cwd), uri: `file://${this.cwd}` },
			],
		});
		if (!init) {
			return false;
		}
		this.notify("initialized", {});
		return true;
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) {
				return;
			}
			const header = this.buffer.subarray(0, headerEnd).toString("utf-8");
			const len = Number(header.match(CONTENT_LENGTH_RE)?.[1] ?? 0);
			if (len <= 0 || this.buffer.length < headerEnd + 4 + len) {
				return;
			}
			const body = this.buffer
				.subarray(headerEnd + 4, headerEnd + 4 + len)
				.toString("utf-8");
			this.buffer = this.buffer.subarray(headerEnd + 4 + len);
			try {
				this.onMessage(JSON.parse(body) as JsonRpcMessage);
			} catch {
				// 忽略残缺帧
			}
		}
	}

	private onMessage(msg: JsonRpcMessage): void {
		if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
			const p = this.pending.get(msg.id);
			if (p) {
				this.pending.delete(msg.id);
				if (msg.error) {
					p.reject(new Error(msg.error.message));
				} else {
					p.resolve(msg.result);
				}
			}
			return;
		}
		if (msg.method === "textDocument/publishDiagnostics") {
			const params = msg.params as { uri: string; diagnostics: unknown[] };
			const file = uriToPath(params.uri);
			const diags = (params.diagnostics as Record<string, unknown>[]).map(
				(d) => {
					const { start } = d.range as {
						start: { character: number; line: number };
					};
					const severity = (d.severity ?? 3) as number;
					return {
						character: start.character + 1,
						line: start.line + 1,
						message: String(d.message ?? ""),
						severity:
							(["error", "warning", "info"] as const)[severity - 1] ?? "info",
						source: d.source as string | undefined,
					};
				}
			);
			this.latestDiagnostics.set(file, diags);
			this.diagnosticsWaiters.get(file)?.(diags);
		}
	}

	private send(msg: JsonRpcMessage): void {
		const body = JSON.stringify(msg);
		this.proc?.stdin?.write(
			`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
		);
	}

	private request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId;
		this.nextId += 1;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { reject, resolve });
			this.send({ id, jsonrpc: "2.0", method, params });
			setTimeout(() => {
				if (this.pending.delete(id)) {
					reject(new Error(`LSP 请求超时: ${method}`));
				}
			}, 15_000);
		});
	}

	private notify(method: string, params: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	private openDocument(file: string): void {
		if (this.openedFiles.has(file)) {
			return;
		}
		this.openedFiles.add(file);
		this.notify("textDocument/didOpen", {
			textDocument: {
				languageId: languageIdFor(file),
				text: fs.readFileSync(file, "utf-8"),
				uri: `file://${file}`,
				version: 1,
			},
		});
	}

	/** 诊断：打开文档并等待 publishDiagnostics（超时则返回当前缓存） */
	async diagnostics(file: string, waitMs = 4000): Promise<Diagnostic[] | null> {
		if (!(await this.ensureReady())) {
			return null;
		}
		this.openDocument(file);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.diagnosticsWaiters.delete(file);
				resolve(this.latestDiagnostics.get(file) ?? []);
			}, waitMs);
			this.diagnosticsWaiters.set(file, (d) => {
				clearTimeout(timer);
				this.diagnosticsWaiters.delete(file);
				resolve(d);
			});
		});
	}

	private async locations(
		method: string,
		file: string,
		line: number,
		character: number
	): Promise<Location[] | null> {
		if (!(await this.ensureReady())) {
			return null;
		}
		this.openDocument(file);
		try {
			const result = await this.request(method, {
				position: { character: character - 1, line: line - 1 },
				textDocument: { uri: `file://${file}` },
				...(method.includes("references")
					? { context: { includeDeclaration: true } }
					: {}),
			});
			const arr = toLocationArray(result);
			return arr.map((l: Record<string, unknown>) => {
				const uri = (l.uri ?? (l.targetUri as string)) as string;
				const range = (l.range ?? l.targetRange) as {
					start: { line: number; character: number };
				};
				return {
					character: range.start.character + 1,
					file: uriToPath(uri),
					line: range.start.line + 1,
				};
			});
		} catch {
			return null;
		}
	}

	definition(
		file: string,
		line: number,
		character: number
	): Promise<Location[] | null> {
		return this.locations("textDocument/definition", file, line, character);
	}

	references(
		file: string,
		line: number,
		character: number
	): Promise<Location[] | null> {
		return this.locations("textDocument/references", file, line, character);
	}

	shutdown(): void {
		try {
			this.proc?.kill();
		} catch {
			// 已退出
		}
	}
}

const FILE_URI_PREFIX_RE = /^file:\/\//;

function uriToPath(uri: string): string {
	return decodeURIComponent(uri.replace(FILE_URI_PREFIX_RE, ""));
}

/** 每个工作目录复用一个客户端 */
const clients = new Map<string, LspClient>();

export function lspFor(cwd: string): LspClient | null {
	const cached = clients.get(cwd);
	if (cached) {
		return cached;
	}
	const cmd = detectTsServer(cwd);
	if (!cmd) {
		return null;
	}
	const client = new LspClient(cwd, cmd);
	clients.set(cwd, client);
	return client;
}
