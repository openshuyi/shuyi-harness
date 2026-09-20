/**
 * P1-5：Hook 机制（对齐 OpenCode 插件钩子 tool.execute.before / event，本地优先实现）。
 *
 * Hook = 可执行文件（脚本语言不限，首行 shebang）：
 *   全局  ~/.agent/hooks/<hook-point>
 *   项目  <cwd>/.agent/hooks/<hook-point>   （两者都执行：先全局后项目）
 *
 * 挂载点：
 *   tool.execute.before  stdin 收 {session_id, tool, args, cwd} JSON；
 *                        退出码 0 = 放行；非 0 = 阻止（stderr 作为原因折回模型）。fail-closed。
 *   tool.execute.after   stdin 收 {session_id, tool, args, ok, duration_ms, result_excerpt}；
 *                        纯观测，输出忽略，失败不阻塞。
 *   event                stdin 收完整事件 JSON；纯观测，异步触发不等待。
 *
 * 安全门（fail-closed 默认关）：shuyi.json 需显式 "hooks": true 才会执行任何 hook
 * （防止克隆的仓库自带可执行文件被静默运行）。单 hook 超时 10s 强制终止。
 * 每次 hook 执行落 hook.executed 事件（事件溯源可审计）。
 */
import fs from "node:fs";
import path from "node:path";

export type HookPoint = "tool.execute.before" | "tool.execute.after" | "event";

export interface HookRunResult {
  hook: string;
  point: HookPoint;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const HOOK_TIMEOUT_MS = 10_000;

/** 找到某挂载点的全部 hook 文件（先全局后项目；要求是可读文件，执行位由 spawn 检查）。 */
export function findHooks(
  point: HookPoint,
  cwd: string,
  home: string = process.env.HOME ?? "/root",
): string[] {
  const out: string[] = [];
  for (const dir of [path.join(home, ".agent", "hooks"), path.join(cwd, ".agent", "hooks")]) {
    const file = path.join(dir, point);
    try {
      if (fs.statSync(file).isFile()) out.push(file);
    } catch {
      // 不存在则跳过
    }
  }
  return out;
}

/** 是否有任何 hook 被启用（供快速短路，避免每次 spawn 探测）。 */
export function hooksPresent(cwd: string, home?: string): boolean {
  return (
    findHooks("tool.execute.before", cwd, home).length > 0 ||
    findHooks("tool.execute.after", cwd, home).length > 0 ||
    findHooks("event", cwd, home).length > 0
  );
}

/** 执行单个 hook：stdin 喂 JSON，限时 10s。任何执行错误归一为非零退出（不抛出）。 */
export async function runHook(
  hookPath: string,
  point: HookPoint,
  payload: unknown,
): Promise<HookRunResult> {
  const started = Date.now();
  try {
    const proc = Bun.spawn([hookPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SHUYI_HOOK_POINT: point },
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
    const timedOut = await Promise.race([
      proc.exited.then(() => false),
      new Promise<true>((r) => setTimeout(() => r(true), HOOK_TIMEOUT_MS)),
    ]);
    if (timedOut) {
      proc.kill("SIGKILL");
      return {
        hook: hookPath, point, exitCode: -1, stdout: "",
        stderr: `hook 超时（>${HOOK_TIMEOUT_MS / 1000}s）已终止`,
        durationMs: Date.now() - started, timedOut: true,
      };
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      hook: hookPath, point, exitCode,
      stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000),
      durationMs: Date.now() - started, timedOut: false,
    };
  } catch (err) {
    return {
      hook: hookPath, point, exitCode: -1, stdout: "",
      stderr: `hook 无法执行：${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - started, timedOut: false,
    };
  }
}

/**
 * tool.execute.before：任一 hook 非零退出即阻止（fail-closed，stderr 为原因）。
 * 返回 { runs, blocked? }——runs 供落 hook.executed 事件（即使未阻止也记录）。
 */
export async function runBeforeHooks(
  cwd: string,
  payload: unknown,
  home?: string,
): Promise<{ runs: HookRunResult[]; blocked?: string }> {
  const runs: HookRunResult[] = [];
  for (const hook of findHooks("tool.execute.before", cwd, home)) {
    const r = await runHook(hook, "tool.execute.before", payload);
    runs.push(r);
    if (r.exitCode !== 0) {
      return { runs, blocked: r.stderr.trim() || `hook ${path.basename(hook)} 退出码 ${r.exitCode}` };
    }
  }
  return { runs };
}

/** tool.execute.after / event：纯观测，逐个执行但结果仅供审计事件。 */
export async function runObserveHooks(
  point: "tool.execute.after" | "event",
  cwd: string,
  payload: unknown,
  home?: string,
): Promise<HookRunResult[]> {
  const runs: HookRunResult[] = [];
  for (const hook of findHooks(point, cwd, home)) {
    runs.push(await runHook(hook, point, payload));
  }
  return runs;
}
