/**
 * P8-2：bash 强化测试
 * - 输出压缩管线（ANSI 剥离 / 重复行折叠 / git/npm/cargo 压缩器）
 * - 后台任务（派生 → status → kill）
 */
import { describe, expect, test } from "bun:test";
import { compressOutput, backgroundTasks } from "../src/tools/bash.js";

describe("P8：bash 输出压缩", () => {
  test("ANSI 转义序列剥离", () => {
    const raw = "[32m✓ green[0m normal [1;31mred[0m";
    expect(compressOutput(raw, "echo")).toBe("✓ green normal red");
  });

  test("连续重复行折叠并标注次数", () => {
    const raw = ["start", ...Array(50).fill("Downloading package..."), "end"].join("\n");
    const out = compressOutput(raw, "bash x");
    expect(out).toContain("重复 49 次");
    expect(out.split("\n").length).toBeLessThan(8);
  });

  test("git 命令砍掉 hint/remote 行", () => {
    const raw = "remote: Enumerating objects\nhint: Some advice\nOn branch main\nnothing to commit";
    const out = compressOutput(raw, "git status");
    expect(out).not.toContain("hint:");
    expect(out).not.toContain("remote:");
    expect(out).toContain("On branch main");
  });

  test("npm install 保留摘要砍掉进度", () => {
    const raw = [
      ...Array(100).fill("⠋ idealTree:timing"),
      "added 152 packages in 8s",
      "npm warn deprecated foo@1.0.0",
      "npm error some failure",
    ].join("\n");
    const out = compressOutput(raw, "npm install");
    expect(out).toContain("added 152 packages");
    expect(out.length).toBeLessThan(raw.length / 2);
  });

  test("cargo 砍 Compiling 刷屏", () => {
    const raw = [...Array(30).fill("   Compiling serde v1.0"), "error[E0308]: mismatch", "    Finished dev"].join("\n");
    const out = compressOutput(raw, "cargo build");
    expect(out).not.toContain("Compiling");
    expect(out).toContain("error[E0308]");
  });

  test("普通命令输出只做基础清理，不丢内容", () => {
    const raw = "line1\nline2\nline3";
    expect(compressOutput(raw, "echo hi")).toBe(raw);
  });
});

describe("P8：bash 后台任务", () => {
  test("派生 → 输出累积 → 状态 → kill", async () => {
    const task = backgroundTasks.spawn("for i in 1 2 3; do echo tick-$i; sleep 0.2; done; sleep 60", "/tmp");
    expect(task.id).toBeTruthy();

    await new Promise((r) => setTimeout(r, 1200));
    expect(task.output).toContain("tick-1");
    expect(task.output).toContain("tick-3");
    expect(task.exitCode).toBeNull(); // sleep 60 还活着

    expect(backgroundTasks.kill(task.id)).toBe(true);
    // SIGTERM 后 close 事件有延迟，轮询等待退出码落定
    const deadline = Date.now() + 3000;
    while (task.exitCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(task.exitCode).not.toBeNull(); // 被杀后记录退出
    expect(backgroundTasks.get(task.id)?.command).toContain("tick");
  });

  test("kill 不存在的任务返回 false", () => {
    expect(backgroundTasks.kill("nonexist")).toBe(false);
  });
});
