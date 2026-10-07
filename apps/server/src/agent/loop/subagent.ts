/**
 * 子代理（P3）：全新上下文窗口，内部烧掉大量 token 做探索，
 * 只把浓缩结论带回主上下文（Anthropic「隔离」策略）。
 *
 * 安全约束：
 * - 子代理工具面 = 只读工具（read/glob/grep）——写操作由主代理决定后执行
 * - 禁止递归（子代理看不到 task 工具）
 * - 迭代上限 15，超时 3 分钟
 *
 * 事件设计：子代理内部步骤不入事件日志（其上下文是临时的，
 * 主模型只看到摘要，摘要已作为 tool 结果留痕）；开始/结束写
 * subagent.started/completed 事件供 UI 与审计观察。
 */
import type { SessionRecord } from "@shuyi-harness/types";
import { buildSystemPrefix } from "../context/index.js";
import type { ChatMessage, ModelAdapter } from "../model/types.js";
import type { EventStore } from "../store/event-store.js";
import type { ToolRegistry } from "../tools/index.js";

const MAX_ITERATIONS = 15;
const SUBAGENT_TIMEOUT_MS = 180_000;

export async function runSubagent(
	task: string,
	parentCallId: string,
	session: SessionRecord,
	adapter: ModelAdapter,
	tools: ToolRegistry,
	store: EventStore,
	turnId: string
): Promise<string> {
	await store.append({
		actor: "system",
		payload: { parent_call_id: parentCallId, task },
		session_id: session.session_id,
		turn_id: turnId,
		type: "subagent.started",
	});
	const startedAt = Date.now();
	let finalSummary = "(子代理异常结束)";

	try {
		// 子代理工具面：只读
		const readOnlySpecs = tools.toModelSpecs("build").filter((s) => {
			const t = tools.get(s.name);
			return (
				t?.permission === "always-allow" &&
				s.name !== "task" &&
				s.name !== "memory_write"
			);
		});

		const system =
			buildSystemPrefix({ mode: "plan", tools: readOnlySpecs }) +
			"\n\n你是一个子代理。独立完成下面的任务，直接给出浓缩的最终结论（不超过 800 字），不要复述过程。";

		const messages: ChatMessage[] = [{ content: task, role: "user" }];
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), SUBAGENT_TIMEOUT_MS);

		try {
			for (let i = 0; i < MAX_ITERATIONS; i += 1) {
				// biome-ignore lint/performance/noAwaitInLoops: 代理循环天然串行
				const result = await adapter.streamChat(
					{ messages, model: session.model, system, tools: readOnlySpecs },
					{},
					controller.signal
				);

				messages.push({
					content: result.text,
					role: "assistant",
					tool_calls:
						result.toolCalls.length > 0 ? result.toolCalls : undefined,
				});

				if (result.toolCalls.length === 0) {
					finalSummary = result.text || "(子代理未返回内容)";
					return finalSummary;
				}

				for (const call of result.toolCalls) {
					const tool = tools.get(call.name);
					if (tool?.permission !== "always-allow") {
						messages.push({
							content: `[子代理无权使用工具 ${call.name}]`,
							role: "tool",
							tool_call_id: call.id,
						});
						continue;
					}
					try {
						const parsed = tool.argsSchema.parse(call.args) as Record<
							string,
							unknown
						>;
						// biome-ignore lint/performance/noAwaitInLoops: 代理循环天然串行
						const out = await tool.execute(parsed, {
							cwd: session.cwd,
							sessionId: session.session_id,
						});
						messages.push({
							content: out.result,
							role: "tool",
							tool_call_id: call.id,
						});
					} catch (err) {
						messages.push({
							content: `[工具失败] ${err instanceof Error ? err.message : String(err)}`,
							role: "tool",
							tool_call_id: call.id,
						});
					}
				}
			}
			finalSummary = "(子代理达到迭代上限，未得出最终结论)";
			return finalSummary;
		} finally {
			clearTimeout(timer);
		}
	} finally {
		await store.append({
			actor: "system",
			payload: {
				duration_ms: Date.now() - startedAt,
				parent_call_id: parentCallId,
				summary_excerpt: finalSummary.slice(0, 300),
				task,
			},
			session_id: session.session_id,
			turn_id: turnId,
			type: "subagent.completed",
		});
	}
}
