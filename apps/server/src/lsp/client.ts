/**
 * 最小 LSP stdio 客户端（P3）：代码智能走语言服务器，不靠模型猜。
 * 参考 OpenCode：复用项目环境里已装的语言服务器，就像 IDE 一样。
 *
 * 当前支持：typescript-language-server（ts/tsx/js/jsx）。
 * 服务器不可用时所有方法优雅降级（返回 null），工具层给模型明确提示。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface Diagnostic {
  line: number;
  character: number;
  severity: "error" | "warning" | "info";
  message: string;
  source?: string;
}

export interface Location {
  file: string;
  line: number;
  character: number;
}

/** 探测 typescript-language-server 是否可用（项目 node_modules 或全局 PATH） */
export function detectTsServer(cwd: string): string[] | null {
  const local = path.join(cwd, "node_modules", ".bin", "typescript-language-server");
  const candidates = [local, "typescript-language-server"];
  for (const bin of candidates) {
    const r = spawnSync(bin === local ? bin : "which", bin === local ? ["--version"] : [bin], {
      encoding: "utf-8",
      timeout: 8000,
    });
    if (r.status === 0) return [bin, "--stdio"];
  }
  return null;
}

export function isTsLike(file: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(file);
}

export class LspClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private diagnosticsWaiters = new Map<string, (d: Diagnostic[]) => void>();
  private latestDiagnostics = new Map<string, Diagnostic[]>();
  private openedFiles = new Set<string>();
  private ready: Promise<boolean> | null = null;

  constructor(
    private cwd: string,
    private serverCmd: string[],
  ) {}

  /** 懒启动 + initialize 握手；失败返回 false（优雅降级） */
  async ensureReady(): Promise<boolean> {
    if (!this.ready) this.ready = this.start().catch(() => false);
    return this.ready;
  }

  private async start(): Promise<boolean> {
    const [cmd, ...args] = this.serverCmd;
    this.proc = spawn(cmd, args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.on("exit", () => {
      this.ready = null;
      this.proc = null;
      for (const p of this.pending.values()) p.reject(new Error("语言服务器退出"));
      this.pending.clear();
    });

    const init = await this.request("initialize", {
      processId: process.pid,
      rootUri: `file://${this.cwd}`,
      capabilities: {
        textDocument: {
          publishDiagnostics: {},
          definition: {},
          references: {},
        },
      },
      workspaceFolders: [{ uri: `file://${this.cwd}`, name: path.basename(this.cwd) }],
    });
    if (!init) return false;
    this.notify("initialized", {});
    return true;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf-8");
      const len = Number(header.match(/Content-Length: (\d+)/i)?.[1] ?? 0);
      if (len <= 0 || this.buffer.length < headerEnd + 4 + len) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + len).toString("utf-8");
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
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as { uri: string; diagnostics: unknown[] };
      const file = uriToPath(params.uri);
      const diags = (params.diagnostics as Array<Record<string, unknown>>).map((d) => ({
        line: ((d.range as { start: { line: number } }).start.line ?? 0) + 1,
        character: ((d.range as { start: { character: number } }).start.character ?? 0) + 1,
        severity: (["error", "warning", "info"] as const)[((d.severity as number) ?? 3) - 1] ?? "info",
        message: String(d.message ?? ""),
        source: d.source as string | undefined,
      }));
      this.latestDiagnostics.set(file, diags);
      this.diagnosticsWaiters.get(file)?.(diags);
    }
  }

  private send(msg: JsonRpcMessage): void {
    const body = JSON.stringify(msg);
    this.proc?.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`LSP 请求超时: ${method}`));
      }, 15000);
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private openDocument(file: string): void {
    if (this.openedFiles.has(file)) return;
    this.openedFiles.add(file);
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: `file://${file}`,
        languageId: file.endsWith(".tsx") ? "typescriptreact" : file.endsWith(".jsx") ? "javascriptreact" : file.endsWith(".js") ? "javascript" : "typescript",
        version: 1,
        text: fs.readFileSync(file, "utf-8"),
      },
    });
  }

  /** 诊断：打开文档并等待 publishDiagnostics（超时则返回当前缓存） */
  async diagnostics(file: string, waitMs = 4000): Promise<Diagnostic[] | null> {
    if (!(await this.ensureReady())) return null;
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

  private async locations(method: string, file: string, line: number, character: number): Promise<Location[] | null> {
    if (!(await this.ensureReady())) return null;
    this.openDocument(file);
    try {
      const result = await this.request(method, {
        textDocument: { uri: `file://${file}` },
        position: { line: line - 1, character: character - 1 },
        ...(method.includes("references") ? { context: { includeDeclaration: true } } : {}),
      });
      const arr = Array.isArray(result) ? result : result ? [result] : [];
      return arr.map((l: Record<string, unknown>) => {
        const uri = (l.uri ?? (l.targetUri as string)) as string;
        const range = (l.range ?? l.targetRange) as { start: { line: number; character: number } };
        return { file: uriToPath(uri), line: range.start.line + 1, character: range.start.character + 1 };
      });
    } catch {
      return null;
    }
  }

  definition(file: string, line: number, character: number): Promise<Location[] | null> {
    return this.locations("textDocument/definition", file, line, character);
  }

  references(file: string, line: number, character: number): Promise<Location[] | null> {
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

function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}

/** 每个工作目录复用一个客户端 */
const clients = new Map<string, LspClient>();

export function lspFor(cwd: string): LspClient | null {
  const cached = clients.get(cwd);
  if (cached) return cached;
  const cmd = detectTsServer(cwd);
  if (!cmd) return null;
  const client = new LspClient(cwd, cmd);
  clients.set(cwd, client);
  return client;
}
