/**
 * 压缩端到端（P2）：小窗口强制触发，验证
 * context.compacted 事件 + 重建边界 + 摘要参与后续上下文。
 * 注意：AGENT_CONTEXT_WINDOW 必须在 loop 模块加载前设置 → 顶部赋值 + 动态 import。
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_CONTEXT_WINDOW = "150"; // 阈值 = 112 token，前几轮必触发

const { EventBus } = await import("../src/agent/bus/index.js");
const { SqliteEventStore } = await import("../src/agent/store/event-store.js");
const { createDefaultRegistry } = await import("../src/agent/tools/index.js");
const { MockAdapter } = await import("../src/agent/model/mock.js");
const { SessionManager } = await import("../src/agent/session/manager.js");
const { rebuildContext } = await import("../src/agent/context/index.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-compact-"));
const workspace = path.join(tmp, "ws");
fs.mkdirSync(workspace, { recursive: true });

const bus = new EventBus();
const store = new SqliteEventStore(path.join(tmp, "t.db"), bus);
const events: import("@shuyi-harness/types").AgentEvent[] = [];
bus.subscribe((e) => events.push(e));
const manager = new SessionManager(store, createDefaultRegistry(), {
	adapters: new Map([["mock", new MockAdapter()]]),
	defaultModel: "mock",
});

afterAll(() => {
	store.close();
	fs.rmSync(tmp, { force: true, recursive: true });
	delete process.env.AGENT_CONTEXT_WINDOW; // 恢复，避免污染同进程其他测试文件
});

describe("P2：压缩触发与重建", () => {
	test("小窗口下触发 context.compacted，重建使用结构化摘要", async () => {
		const s = await manager.createSession({
			cwd: workspace,
			mode: "build",
			model: "mock",
			sandbox_level: "workspace",
		});
		await manager.postMessage(
			s.session_id,
			"!write compact-test.txt 一些内容用于撑大上下文"
		);

		const start = Date.now();
		const doneBase = events.filter(
			(e) => e.type === "turn.completed" || e.type === "turn.aborted"
		).length;
		for (;;) {
			if (
				events.filter(
					(e) => e.type === "turn.completed" || e.type === "turn.aborted"
				).length > doneBase
			) {
				// biome-ignore lint/performance/noAwaitInLoops: 轮询等待轮次收尾，必须逐次 await
				const cur = await manager.getSession(s.session_id);
				if (cur?.status === "idle") {
					break;
				}
			}
			if (Date.now() - start > 15_000) {
				throw new Error("等待 idle 超时");
			}
			await new Promise((r) => setTimeout(r, 20));
		}

		// 压缩事件已写入（系统前缀+消息在 112 token 阈值下必触发）
		const compacted = events.find((e) => e.type === "context.compacted");
		expect(compacted).toBeDefined();
		if (!compacted) {
			throw new Error("未触发压缩事件");
		}
		const p = compacted.payload as {
			summary: {
				session_intent: string;
				next_steps: string;
				files_modified: string[];
			};
			covers_until_seq: number;
			tokens_before: number;
			tokens_after: number;
		};
		expect(p.covers_until_seq).toBeGreaterThan(0);
		// 结构化模板五段必须存在（toy 场景下不比较前后大小：短会话摘要可能长于原文）
		expect(typeof p.summary.session_intent).toBe("string");
		expect(typeof p.summary.next_steps).toBe("string");
		expect(Array.isArray(p.summary.files_modified)).toBe(true);
		expect(p.tokens_before).toBeGreaterThan(0);

		// 重建：摘要作为首条消息，且边界之后的事件仍参与 fold
		const session = await manager.getSession(s.session_id);
		if (!session) {
			throw new Error("会话丢失");
		}
		const { messages, compacted: wasCompacted } = await rebuildContext(
			store,
			session,
			createDefaultRegistry().toModelSpecs()
		);
		expect(wasCompacted).toBe(true);
		expect(messages[0]?.content).toContain("压缩摘要");
		expect(messages[0]?.content).toContain("Session Intent");

		// 轮次正常完成（压缩不破坏流程）
		expect(events.some((e) => e.type === "turn.completed")).toBe(true);
	});
});
