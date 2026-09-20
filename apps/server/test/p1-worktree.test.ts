/**
 * P1-6：worktree 隔离并行会话。
 * - createSession(worktree:true) → cwd 指向 <repo>/.agent/worktrees/<short>（分支 agent/<short>）
 * - 会话内写入落在隔离工作区；mergeSessionWorktree 合并回主分支并清理
 * - discardSessionWorktree 放弃（改动随分支删除）
 * - 非 git 仓库：自动降级为普通会话
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createWorktree, mergeWorktree, discardWorktree, repoRoot } from "../src/git/index.js";
import { SqliteEventStore } from "../src/store/event-store.js";
import { EventBus } from "../src/bus/index.js";
import { SessionManager } from "../src/session/manager.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { RuntimeModelRegistry } from "../src/model/registry.js";
import type { AgentEvent } from "@shuyi/types";

let tmp: string;
let repo: string;

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p1-wt-"));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  git(repo, "init");
  fs.writeFileSync(path.join(repo, "base.txt"), "base");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "init");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("P1-6 worktree 单元", () => {
  test("createWorktree：目录/分支就位；repoRoot 正确；非仓库返回 null", () => {
    expect(repoRoot(repo)).toBe(repo);
    expect(repoRoot(path.join(tmp, "not-a-repo"))).toBeNull();
    const wt = createWorktree(repo, "abcd1234-xxxx-yyyy");
    expect(wt).not.toBeNull();
    expect(wt!.branch).toBe("agent/abcd1234");
    expect(fs.existsSync(path.join(wt!.worktree_path, "base.txt"))).toBe(true);
    // 分支存在
    const branches = spawnSync("git", ["-C", repo, "branch"], { encoding: "utf-8" }).stdout;
    expect(branches).toContain("agent/abcd1234");
    // .git/info/exclude 含 .agent/worktrees
    expect(fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf-8")).toContain(".agent/worktrees");
  });

  test("mergeWorktree：分支改动合并回主分支并清理；discardWorktree：改动丢失", () => {
    // merge 路径
    const wt1 = createWorktree(repo, "11111111-aaaa")!;
    fs.writeFileSync(path.join(wt1.worktree_path, "feat.txt"), "feat");
    git(wt1.worktree_path, "add", ".");
    git(wt1.worktree_path, "commit", "-m", "feat");
    const m = mergeWorktree(wt1);
    expect(m.ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, "feat.txt"), "utf-8")).toBe("feat");
    expect(fs.existsSync(wt1.worktree_path)).toBe(false);
    let branches = spawnSync("git", ["-C", repo, "branch"], { encoding: "utf-8" }).stdout;
    expect(branches).not.toContain("agent/11111111");

    // discard 路径
    const wt2 = createWorktree(repo, "22222222-bbbb")!;
    fs.writeFileSync(path.join(wt2.worktree_path, "lost.txt"), "lost");
    git(wt2.worktree_path, "add", ".");
    git(wt2.worktree_path, "commit", "-m", "lost");
    const d = discardWorktree(wt2);
    expect(d.ok).toBe(true);
    expect(fs.existsSync(path.join(repo, "lost.txt"))).toBe(false);
    branches = spawnSync("git", ["-C", repo, "branch"], { encoding: "utf-8" }).stdout;
    expect(branches).not.toContain("agent/22222222");
  });
});

describe("P1-6 worktree e2e", () => {
  test("隔离会话写入不污染主工作区 → 合并后主工作区可见，cwd 切回仓库根", async () => {
    const bus = new EventBus();
    const store = new SqliteEventStore(path.join(tmp, "events.db"), bus);
    const events: AgentEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const manager = new SessionManager(store, createDefaultRegistry(), new RuntimeModelRegistry({}));
    const session = manager.createSession({
      cwd: repo, mode: "build", model: "mock", sandbox_level: "workspace-write", worktree: true,
    });
    expect(session.worktree).toBeDefined();
    expect(session.cwd).toBe(session.worktree!.worktree_path);
    expect(session.cwd).not.toBe(repo);

    // 会话内写文件（mock !write；worktree 内已是 git 仓库，沙箱 workspace-write 放行）
    manager.postMessage(session.session_id, "!write feat.txt 隔离写入");
    const start = Date.now();
    while (!events.some((e) => e.type === "turn.completed")) {
      if (Date.now() - start > 8000) throw new Error("超时");
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(fs.existsSync(path.join(session.cwd, "feat.txt"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "feat.txt"))).toBe(false); // 主工作区未污染

    // 合并
    const m = manager.mergeSessionWorktree(session.session_id);
    expect(m.ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, "feat.txt"), "utf-8")).toBe("隔离写入");
    const after = store.getSession(session.session_id)!;
    expect(after.cwd).toBe(repo);
    expect(after.worktree).toBeUndefined();
  });

  test("非 worktree 会话调用合并返回错误；非仓库降级为普通会话", async () => {
    const bus = new EventBus();
    const store = new SqliteEventStore(path.join(tmp, "e2.db"), bus);
    const manager = new SessionManager(store, createDefaultRegistry(), new RuntimeModelRegistry({}));
    const plain = manager.createSession({
      cwd: repo, mode: "build", model: "mock", sandbox_level: "workspace-write",
    });
    expect(manager.mergeSessionWorktree(plain.session_id).ok).toBe(false);

    const noRepo = path.join(tmp, "plain-dir");
    fs.mkdirSync(noRepo);
    const degraded = manager.createSession({
      cwd: noRepo, mode: "build", model: "mock", sandbox_level: "workspace-write", worktree: true,
    });
    expect(degraded.worktree).toBeUndefined();
    expect(degraded.cwd).toBe(noRepo);
  });
});
