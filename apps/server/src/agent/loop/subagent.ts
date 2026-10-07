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
import type { AgentDefinition } from "../agents/index.js";
import { buildSystemPrefix } from "../context/index.js";
import type { ChatMessage, ModelAdapter } from "../model/types.js";
import type { EventStore } from "../store/event-store.js";
import type { ToolRegistry } from "../tools/index.js";

const MAX_ITERATIONS = 15;
const SUBAGENT_TIMEOUT_MS = 180_000;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: 子代理消息循环，平移自 v0.x 成熟实现，保持 1:1
export async function runSubagent(
	task: string,
	parentCallId: string,
	session: SessionRecord,
	adapter: ModelAdapter,
	tools: ToolRegistry,
	store: EventStore,
	turnId: string,
	/** P8-3：代理定义（系统提示 + 工具面）；缺省等同内置 explore */
	agent?: AgentDefinition,
	/** P8-3：代理定义指定 model 时，从注册表解析对应适配器 */
	models?: { get: (id: string) => ModelAdapter | undefined }
): Promise<string> {
	const subAdapter =
		(agent?.model ? models?.get(agent.model) : undefined) ?? adapter;
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
		// 子代理工具面：默认只读；代理定义可收窄到显式名单。
		// 安全约束不变：无论定义如何声明，写工具都不会进入子代理工具面
		// （子代理直接执行工具、无审批流，写操作必须由主代理决定后执行）。
		let subSpecs = tools.toModelSpecs("build").filter((s) => {
			const t = tools.get(s.name);
			return (
				t?.permission === "always-allow" &&
				t.subagentVisible !== false && // M4：联网工具对子代理默认隐藏
				s.name !== "task" &&
				s.name !== "memory_write"
			);
		});
		if (agent && Array.isArray(agent.tools)) {
			const allow = new Set(agent.tools);
			subSpecs = subSpecs.filter((s) => allow.has(s.name));
		}

		const rolePrompt =
			agent?.system ??
			"你是一个子代理。独立完成下面的任务，直接给出浓缩的最终结论（不超过 800 字），不要复述过程。";
		const system =
			buildSystemPrefix({ mode: "plan", tools: subSpecs }) +
			"\n\n" +
			rolePrompt;

		const messages: ChatMessage[] = [{ content: task, role: "user" }];
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), SUBAGENT_TIMEOUT_MS);

		try {
			for (let i = 0; i < MAX_ITERATIONS; i += 1) {
				// biome-ignore lint/performance/noAwaitInLoops: 子代理消息循环每轮依赖上一轮结果，天然顺序不可并行
				const result = await subAdapter.streamChat(
					{
						messages,
						model: agent?.model ?? session.model,
						system,
						tools: subSpecs,
					},
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
						// biome-ignore lint/performance/noAwaitInLoops: 工具结果需按序回填消息队列，不可并行
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
