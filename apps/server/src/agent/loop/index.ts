/**
 * 核心 Loop：propose → permission → tool → observe 的固定循环。
 * 不含业务逻辑；Plan/Build 模式体现在工具面与系统提示（由上下文模块注入），不在此分支。
 */
import { randomUUID } from "node:crypto";
import type { SessionRecord } from "@shuyi-harness/types";
import { compactSession } from "../context/compaction.js";
import {
	estimateMessagesTokens,
	estimateTokens,
	prefixHash,
	readMemory,
	rebuildContext,
	shouldCompact,
} from "../context/index.js";
import { commitFiles, ensureRepo } from "../git/index.js";
import type { ModelAdapter } from "../model/types.js";
import type { PermissionService } from "../permission/index.js";
import type { EventStore } from "../store/event-store.js";
import type { ToolContext, ToolRegistry } from "../tools/index.js";
import { runSubagent } from "./subagent.js";

export interface LoopDeps {
	store: EventStore;
	tools: ToolRegistry;
	/** 审批挂起/恢复由会话管理器提供 */
	waitForApproval: (
		sessionId: string,
		approvalId: string
	) => Promise<{
		decision: "approve" | "deny";
		remember_rule?: string;
		deny_reason?: string;
	}>;
}

const MAX_TOOL_ITERATIONS = 40; // 单轮工具调用上限，防失控
/** 运行时读取（而非模块常量）：测试可注入小窗口，且不受模块缓存顺序影响 */
function contextWindow(): number {
	return Number(process.env.AGENT_CONTEXT_WINDOW ?? 128_000);
}

/**
 * 记忆注入：放在对话最前面，保证最后一条消息永远是真实用户输入。
 * （插在 messages[0] 之后会在单消息会话中让记忆成为最后一条，
 *  导致模型/适配器把记忆误认为用户请求——已踩坑修复）
 */
function assembleWithMemory(
	messages: import("../model/types.js").ChatMessage[],
	memory: string | null
): import("../model/types.js").ChatMessage[] {
	return memory
		? [{ content: memory, role: "user" as const }, ...messages]
		: messages;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: 固定的 propose→permission→tool→observe 循环，v0.2 内核 1:1 平移
export async function runTurn(
	session: SessionRecord,
	userText: string,
	adapter: ModelAdapter,
	permission: PermissionService,
	deps: LoopDeps,
	signal: AbortSignal
): Promise<void> {
	const { store, tools } = deps;
	const sid = session.session_id;
	const turnId = randomUUID();
	const repoReady = ensureRepo(session.cwd); // git 撤销机制（不可用时静默降级）

	await store.append({
		actor: "system",
		payload: {},
		session_id: sid,
		turn_id: turnId,
		type: "turn.started",
	});
	await store.append({
		actor: "user",
		payload: { text: userText },
		session_id: sid,
		turn_id: turnId,
		type: "message.user",
	});
	await store.setSessionStatus(sid, "running");

	const totalUsage = { completion_tokens: 0, prompt_tokens: 0 };
	let iterations = 0;

	try {
		for (;;) {
			if (signal.aborted) {
				return abortTurn(store, sid, turnId, "用户中断");
			}

			// ---- 组装上下文（每次迭代重新 fold，保证工具结果已折回） ----
			// 模式决定工具面（Loop 不变）：plan 模式只暴露只读工具
			const specs = tools.toModelSpecs(session.mode);
			const memory = readMemory(session.cwd);
			// biome-ignore lint/performance/noAwaitInLoops: 每次迭代必须先重建上下文（fold 串行）
			let { system, messages } = await rebuildContext(store, session, specs);
			let allMessages = assembleWithMemory(messages, memory);
			let tokenEstimate =
				estimateTokens(system) + estimateMessagesTokens(allMessages);

			// ---- 压缩：填充 ~75% 触发，压缩后重建再继续 ----
			if (shouldCompact(tokenEstimate, contextWindow())) {
				await compactSession(store, sid, turnId, allMessages, adapter);
				({ system, messages } = await rebuildContext(store, session, specs));
				allMessages = assembleWithMemory(messages, memory);
				tokenEstimate =
					estimateTokens(system) + estimateMessagesTokens(allMessages);
			}

			await store.append({
				actor: "system",
				payload: {
					message_count: allMessages.length,
					model: session.model,
					prefix_hash: prefixHash(system),
					token_estimate: tokenEstimate,
				},
				session_id: sid,
				turn_id: turnId,
				type: "context.request.assembled",
			});

			// ---- 调用模型（流式） ----
			const result = await adapter.streamChat(
				{ messages: allMessages, model: session.model, system, tools: specs },
				{
					onTextDelta: async (d) => {
						await store.append({
							actor: "agent",
							payload: { text_delta: d },
							session_id: sid,
							turn_id: turnId,
							type: "message.assistant.delta",
						});
					},
					onThinkingDelta: async (d) => {
						await store.append({
							actor: "agent",
							payload: { thinking_delta: d },
							session_id: sid,
							turn_id: turnId,
							type: "message.assistant.thinking_delta",
						});
					},
				},
				signal
			);

			totalUsage.prompt_tokens += result.usage.prompt_tokens;
			totalUsage.completion_tokens += result.usage.completion_tokens;

			await store.append({
				actor: "agent",
				payload: { finish_reason: result.finishReason, text: result.text },
				session_id: sid,
				turn_id: turnId,
				type: "message.assistant.completed",
			});

			// ---- 无工具调用 → 轮次结束 ----
			if (result.toolCalls.length === 0) {
				await store.append({
					actor: "system",
					payload: { model: session.model, usage: totalUsage },
					session_id: sid,
					turn_id: turnId,
					type: "turn.completed",
				});
				await store.setSessionStatus(sid, "idle");
				return;
			}

			// ---- 逐个处理工具调用 ----
			for (const call of result.toolCalls) {
				if (signal.aborted) {
					return abortTurn(store, sid, turnId, "用户中断");
				}
				iterations += 1;
				if (iterations > MAX_TOOL_ITERATIONS) {
					// biome-ignore lint/performance/noAwaitInLoops: 中断事件先落库再返回
					await store.append({
						actor: "system",
						payload: {
							message: `单轮工具调用超过上限 ${MAX_TOOL_ITERATIONS}`,
							retryable: false,
							scope: "loop",
						},
						session_id: sid,
						turn_id: turnId,
						type: "error.occurred",
					});
					return abortTurn(store, sid, turnId, "工具调用超限");
				}

				const tool = tools.get(call.name);
				if (!tool) {
					await store.append({
						actor: "system",
						payload: {
							call_id: call.id,
							duration_ms: 0,
							error: `未知工具: ${call.name}`,
						},
						session_id: sid,
						turn_id: turnId,
						type: "tool.call.failed",
					});
					continue;
				}

				// 参数校验
				const parsed = tool.argsSchema.safeParse(call.args);
				if (!parsed.success) {
					await store.append({
						actor: "system",
						payload: {
							call_id: call.id,
							duration_ms: 0,
							error: `参数校验失败: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
						},
						session_id: sid,
						turn_id: turnId,
						type: "tool.call.failed",
					});
					continue;
				}
				const args = parsed.data as Record<string, unknown>;

				// ---- 权限裁决 ----
				const verdict = permission.classify({
					args,
					cwd: session.cwd,
					mode: session.mode,
					sandboxLevel: session.sandbox_level,
					tool,
				});

				const proposedEvent = await store.append({
					actor: "agent",
					payload: {
						args,
						call_id: call.id,
						permission_hint: verdict.kind,
						tool: call.name,
					},
					session_id: sid,
					turn_id: turnId,
					type: "tool.call.proposed",
				});

				if (verdict.kind === "deny") {
					await store.append({
						actor: "system",
						causation_id: proposedEvent.event_id,
						payload: {
							call_id: call.id,
							duration_ms: 0,
							error: `[权限拒绝] ${verdict.reason}`,
						},
						session_id: sid,
						turn_id: turnId,
						type: "tool.call.failed",
					});
					continue;
				}

				if (verdict.kind === "ask") {
					const approvalId = randomUUID();
					await store.append({
						actor: "system",
						causation_id: proposedEvent.event_id,
						payload: {
							approval_id: approvalId,
							args,
							call_id: call.id,
							risk_summary: verdict.reason,
							tool: call.name,
						},
						session_id: sid,
						turn_id: turnId,
						type: "approval.requested",
					});
					await store.setSessionStatus(sid, "awaiting_approval");

					const resolution = await deps.waitForApproval(sid, approvalId);
					await store.setSessionStatus(sid, "running");
					await store.append({
						actor: "user",
						causation_id: proposedEvent.event_id,
						payload: {
							approval_id: approvalId,
							decision: resolution.decision,
							deny_reason: resolution.deny_reason,
							remember_rule: resolution.remember_rule,
						},
						session_id: sid,
						turn_id: turnId,
						type: "approval.resolved",
					});

					if (resolution.decision === "deny") {
						await store.append({
							actor: "system",
							causation_id: proposedEvent.event_id,
							payload: {
								call_id: call.id,
								duration_ms: 0,
								error: `[用户拒绝] ${resolution.deny_reason ?? "未提供理由"}。请尊重用户决定。`,
							},
							session_id: sid,
							turn_id: turnId,
							type: "tool.call.failed",
						});
						continue;
					}
					if (resolution.remember_rule) {
						permission.rememberRule(call.name, "allow");
					}
				}

				// ---- 执行工具 ----
				await store.append({
					actor: "system",
					causation_id: proposedEvent.event_id,
					payload: { call_id: call.id },
					session_id: sid,
					turn_id: turnId,
					type: "tool.call.started",
				});
				const startedAt = Date.now();
				const toolCtx: ToolContext = {
					cwd: session.cwd,
					onMemoryWritten: async (file, excerpt, reason) => {
						await store.append({
							actor: "system",
							causation_id: proposedEvent.event_id,
							payload: { excerpt, file, reason },
							session_id: sid,
							turn_id: turnId,
							type: "memory.written",
						});
					},
					onOutputChunk: async (chunk) => {
						await store.append({
							actor: "system",
							causation_id: proposedEvent.event_id,
							payload: { call_id: call.id, chunk },
							session_id: sid,
							turn_id: turnId,
							type: "tool.call.output_delta",
						});
					},
					sessionId: sid,
					spawnSubagent: (task, parentCallId) =>
						runSubagent(
							task,
							parentCallId || call.id,
							session,
							adapter,
							tools,
							store,
							turnId
						),
				};
				try {
					const out = await tool.execute(args, toolCtx);
					// git 原子提交（撤销机制）：写入类工具成功后提交
					let commit: string | undefined;
					if (repoReady && out.sideEffects?.files_written?.length) {
						commit =
							commitFiles(
								session.cwd,
								out.sideEffects.files_written,
								`agent(${call.name}): ${out.sideEffects.files_written.length} 个文件`
							) ?? undefined;
					}
					await store.append({
						actor: "system",
						causation_id: proposedEvent.event_id,
						payload: {
							call_id: call.id,
							duration_ms: Date.now() - startedAt,
							result: out.result,
							side_effects: { ...out.sideEffects, commit },
							truncated: out.truncated,
						},
						session_id: sid,
						turn_id: turnId,
						type: "tool.call.completed",
					});
				} catch (err) {
					await store.append({
						actor: "system",
						causation_id: proposedEvent.event_id,
						payload: {
							call_id: call.id,
							duration_ms: Date.now() - startedAt,
							error: err instanceof Error ? err.message : String(err),
						},
						session_id: sid,
						turn_id: turnId,
						type: "tool.call.failed",
					});
				}
			}
			// 工具结果已通过事件落库，下一轮迭代 rebuild 时自动折回上下文
		}
	} catch (err) {
		if (signal.aborted) {
			return abortTurn(store, sid, turnId, "用户中断");
		}
		await store.append({
			actor: "system",
			payload: {
				message: err instanceof Error ? err.message : String(err),
				retryable: true,
				scope: "loop",
			},
			session_id: sid,
			turn_id: turnId,
			type: "error.occurred",
		});
		await store.setSessionStatus(sid, "idle");
	}
}

async function abortTurn(
	store: EventStore,
	sid: string,
	turnId: string,
	reason: string
): Promise<void> {
	await store.append({
		actor: "user",
		payload: { reason },
		session_id: sid,
		turn_id: turnId,
		type: "turn.aborted",
	});
	await store.setSessionStatus(sid, "idle");
}
