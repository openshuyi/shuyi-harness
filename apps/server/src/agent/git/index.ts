/**
 * git 集成（P1 遗留项）：本地场景的「撤销机制」。
 * - 会话创建时确保工作区是 git 仓库（缺则 init）
 * - 每次写入工具成功后原子提交（Aider 风格：提交在当前分支）
 * - 提交 hash 记入 tool.call.completed 的 side_effects.commit，可审阅可回滚
 *
 * 设计说明：不强制切换会话分支——切换分支会搬动用户工作树，对未提交的
 * 既有改动不友好。个人版采取 Aider 同款策略：提交落在当前分支，用户
 * 可用 `git log`/`git revert` 审阅与撤销。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.name=agent", "-c", "user.email=agent@local", ...args], {
    encoding: "utf-8",
    timeout: 10000,
  });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim() };
}

/** 确保 cwd 是 git 仓库；返回是否可用（git 不存在或初始化失败时静默降级） */
export function ensureRepo(cwd: string): boolean {
  try {
    if (fs.existsSync(path.join(cwd, ".git"))) return true;
    const r = git(cwd, ["init"]);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * 原子提交指定文件。返回 commit hash；无改动/非仓库/git 缺失时返回 null。
 */
export function commitFiles(cwd: string, files: string[], message: string): string | null {
  try {
    const rel = files.map((f) => path.relative(cwd, f));
    if (!git(cwd, ["add", "--", ...rel]).ok) return null;
    // 无暂存改动则跳过
    const diff = git(cwd, ["diff", "--cached", "--name-only"]);
    if (!diff.ok || diff.stdout.length === 0) return null;
    if (!git(cwd, ["commit", "-m", message]).ok) return null;
    const head = git(cwd, ["rev-parse", "--short", "HEAD"]);
    return head.ok ? head.stdout : null;
  } catch {
    return null;
  }
}
