/**
 * 核心 Loop：propose → permission → tool → observe 的固定循环。
 * 不含业务逻辑；Plan/Build 模式体现在工具面与系统提示（由上下文模块注入），不在此分支。
 */
import { randomUUID } from "node:crypto";
import type { SessionRecord } from "@shuyi/types";
import type { EventStore } from "../store/event-store.js";
import type { ToolRegistry, ToolContext } from "../tools/index.js";
import type { PermissionService } from "../permission/index.js";
import type { ModelAdapter } from "../model/types.js";
import { estimateCost } from "../model/types.js";
import {
  rebuildContext,
  estimateMessagesTokens,
  estimateTokens,
  prefixHash,
  readMemory,
  shouldCompact,
} from "../context/index.js";
import { compactSession } from "../context/compaction.js";
import { runSubagent } from "./subagent.js";
import { ensureRepo, commitFiles, headCommit } from "../git/index.js";
import { postEditDiagnostics } from "../lsp/post-edit.js";
import type { AgentRegistry } from "../agents/index.js";
import type { ModelAdapter as ModelAdapterT } from "../model/types.js";
import { loadProjectConfig } from "../config/project.js";

export interface LoopDeps {
  store: EventStore;
  tools: ToolRegistry;
  /** 审批挂起/恢复由会话管理器提供 */
  waitForApproval: (
    sessionId: string,
    approvalId: string,
  ) => Promise<{ decision: "approve" | "deny"; remember_rule?: string; deny_reason?: string }>;
  /** P8-3：代理定义注册表（task 工具的 agent 参数解析） */
  agents?: AgentRegistry;
  /** P8-3：代理定义指定 model 时解析适配器 */
  models?: { get(id: string): ModelAdapterT | undefined };
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
  memory: string | null,
): import("../model/types.js").ChatMessage[] {
  return memory ? [{ role: "user" as const, content: memory }, ...messages] : messages;
}

export async function runTurn(
  session: SessionRecord,
  userText: string,
  adapter: ModelAdapter,
  permission: PermissionService,
  deps: LoopDeps,
  signal: AbortSignal,
): Promise<void> {
  const { store, tools } = deps;
  const sid = session.session_id;
  const turnId = randomUUID();
  const repoReady = ensureRepo(session.cwd); // git 撤销机制（不可用时静默降级）

  store.append({
    session_id: sid,
    type: "turn.started",
    actor: "system",
    turn_id: turnId,
    // 记录轮次开始时的 git HEAD：回滚到此轮 = reset 到 base_commit
    payload: { base_commit: repoReady ? (headCommit(session.cwd) ?? undefined) : undefined },
  });
  store.append({
    session_id: sid,
    type: "message.user",
    actor: "user",
    turn_id: turnId,
    payload: { text: userText },
  });
  store.setSessionStatus(sid, "running");

  let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };
  let iterations = 0;
  // P8-5：项目级指令（shuyi.json）注入系统提示尾部，每轮加载一次
  const projectInstructions = loadProjectConfig(session.cwd).instructions;

  try {
    for (;;) {
      if (signal.aborted) return abortTurn(store, sid, turnId, "用户中断");

      // ---- 组装上下文（每次迭代重新 fold，保证工具结果已折回） ----
      // 模式决定工具面（Loop 不变）：plan 模式只暴露只读工具
      const specs = tools.toModelSpecs(session.mode);
      const memory = readMemory(session.cwd);
      let { system, messages } = rebuildContext(store, session, specs, projectInstructions);
      let allMessages = assembleWithMemory(messages, memory);
      let tokenEstimate =
        estimateTokens(system) + estimateMessagesTokens(allMessages);

      // ---- 压缩：填充 ~75% 触发，压缩后重建再继续 ----
      if (shouldCompact(tokenEstimate, contextWindow())) {
        await compactSession(store, sid, turnId, allMessages, adapter);
        ({ system, messages } = rebuildContext(store, session, specs, projectInstructions));
        allMessages = assembleWithMemory(messages, memory);
        tokenEstimate = estimateTokens(system) + estimateMessagesTokens(allMessages);
      }

      store.append({
        session_id: sid,
        type: "context.request.assembled",
        actor: "system",
        turn_id: turnId,
        payload: {
          prefix_hash: prefixHash(system),
          message_count: allMessages.length,
          token_estimate: tokenEstimate,
          model: session.model,
        },
      });

      // ---- 调用模型（流式） ----
      const result = await adapter.streamChat(
        { model: session.model, system, messages: allMessages, tools: specs },
        {
          onTextDelta: (d) =>
            store.append({
              session_id: sid,
              type: "message.assistant.delta",
              actor: "agent",
              turn_id: turnId,
              payload: { text_delta: d },
            }),
          onThinkingDelta: (d) =>
            store.append({
              session_id: sid,
              type: "message.assistant.thinking_delta",
              actor: "agent",
              turn_id: turnId,
              payload: { thinking_delta: d },
            }),
        },
        signal,
      );

      totalUsage.prompt_tokens += result.usage.prompt_tokens;
      totalUsage.completion_tokens += result.usage.completion_tokens;

      store.append({
        session_id: sid,
        type: "message.assistant.completed",
        actor: "agent",
        turn_id: turnId,
        payload: { text: result.text, finish_reason: result.finishReason },
      });

      // ---- 无工具调用 → 轮次结束 ----
      if (result.toolCalls.length === 0) {
        store.append({
          session_id: sid,
          type: "turn.completed",
          actor: "system",
          turn_id: turnId,
          payload: {
            usage: totalUsage,
            model: session.model,
            cost_estimate: estimateCost(totalUsage, adapter.meta.pricing),
          },
        });
        store.setSessionStatus(sid, "idle");
        return;
      }

      // ---- 逐个处理工具调用 ----
      for (const call of result.toolCalls) {
        if (signal.aborted) return abortTurn(store, sid, turnId, "用户中断");
        if (++iterations > MAX_TOOL_ITERATIONS) {
          store.append({
            session_id: sid,
            type: "error.occurred",
            actor: "system",
            turn_id: turnId,
            payload: { scope: "loop", message: `单轮工具调用超过上限 ${MAX_TOOL_ITERATIONS}`, retryable: false },
          });
          return abortTurn(store, sid, turnId, "工具调用超限");
        }

        const tool = tools.get(call.name);
        if (!tool) {
          // 非法 tool_call 纠错：附可用工具清单，模型下一轮据此自我修正
          const visible = specs.map((t) => t.name).join(", ");
          store.append({
            session_id: sid,
            type: "tool.call.failed",
            actor: "system",
            turn_id: turnId,
            payload: {
              call_id: call.id,
              error: `未知工具: ${call.name}。可用工具：${visible}。请检查工具名后重试。`,
              duration_ms: 0,
            },
          });
          continue;
        }

        // 参数校验（纠错：附字段级错误详情，模型下一轮补齐/修正参数）
        const parsed = tool.argsSchema.safeParse(call.args);
        if (!parsed.success) {
          const details = parsed.error.issues
            .map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`)
            .join("; ");
          store.append({
            session_id: sid,
            type: "tool.call.failed",
            actor: "system",
            turn_id: turnId,
            payload: {
              call_id: call.id,
              error: `参数校验失败: ${details}。请按工具参数说明修正后重新调用 ${call.name}。`,
              duration_ms: 0,
            },
          });
          continue;
        }
        const args = parsed.data as Record<string, unknown>;

        // ---- 权限裁决 ----
        const verdict = permission.classify({
          tool,
          args,
          cwd: session.cwd,
          sandboxLevel: session.sandbox_level,
          mode: session.mode,
        });

        const proposedEvent = store.append({
          session_id: sid,
          type: "tool.call.proposed",
          actor: "agent",
          turn_id: turnId,
          payload: { call_id: call.id, tool: call.name, args, permission_hint: verdict.kind },
        });

        if (verdict.kind === "deny") {
          store.append({
            session_id: sid,
            type: "tool.call.failed",
            actor: "system",
            turn_id: turnId,
            causation_id: proposedEvent.event_id,
            payload: { call_id: call.id, error: `[权限拒绝] ${verdict.reason}`, duration_ms: 0 },
          });
          continue;
        }

        if (verdict.kind === "ask") {
          const approvalId = randomUUID();
          store.append({
            session_id: sid,
            type: "approval.requested",
            actor: "system",
            turn_id: turnId,
            causation_id: proposedEvent.event_id,
            payload: {
              approval_id: approvalId,
              call_id: call.id,
              tool: call.name,
              args,
              risk_summary: verdict.reason,
            },
          });
          store.setSessionStatus(sid, "awaiting_approval");

          const resolution = await deps.waitForApproval(sid, approvalId);
          store.setSessionStatus(sid, "running");
          store.append({
            session_id: sid,
            type: "approval.resolved",
            actor: "user",
            turn_id: turnId,
            causation_id: proposedEvent.event_id,
            payload: {
              approval_id: approvalId,
              decision: resolution.decision,
              remember_rule: resolution.remember_rule,
              deny_reason: resolution.deny_reason,
            },
          });

          if (resolution.decision === "deny") {
            store.append({
              session_id: sid,
              type: "tool.call.failed",
              actor: "system",
              turn_id: turnId,
              causation_id: proposedEvent.event_id,
              payload: {
                call_id: call.id,
                error: `[用户拒绝] ${resolution.deny_reason ?? "未提供理由"}。请尊重用户决定。`,
                duration_ms: 0,
              },
            });
            continue;
          }
          if (resolution.remember_rule) {
            permission.rememberRule(call.name, "allow");
          }
        }

        // ---- 执行工具 ----
        store.append({
          session_id: sid,
          type: "tool.call.started",
          actor: "system",
          turn_id: turnId,
          causation_id: proposedEvent.event_id,
          payload: { call_id: call.id },
        });
        const startedAt = Date.now();
        const toolCtx: ToolContext = {
          sessionId: sid,
          cwd: session.cwd,
          onOutputChunk: (chunk) =>
            store.append({
              session_id: sid,
              type: "tool.call.output_delta",
              actor: "system",
              turn_id: turnId,
              causation_id: proposedEvent.event_id,
              payload: { call_id: call.id, chunk },
            }),
          onMemoryWritten: (file, excerpt, reason) =>
            store.append({
              session_id: sid,
              type: "memory.written",
              actor: "system",
              turn_id: turnId,
              causation_id: proposedEvent.event_id,
              payload: { file, excerpt, reason },
            }),
          spawnSubagent: (task, parentCallId, agentName) =>
            runSubagent(
              task,
              parentCallId || call.id,
              session,
              adapter,
              tools,
              store,
              turnId,
              deps.agents?.get(agentName ?? "explore", session.cwd),
              deps.models,
            ),
        };
        try {
          const out = await tool.execute(args, toolCtx);
          // git 原子提交（撤销机制）：写入类工具成功后提交
          let commit: string | undefined;
          let result = out.result;
          if (repoReady && out.sideEffects?.files_written?.length) {
            commit =
              commitFiles(
                session.cwd,
                out.sideEffects.files_written,
                `agent(${call.name}): ${out.sideEffects.files_written.length} 个文件`,
              ) ?? undefined;
          }
          // 编辑后 LSP 诊断折回（OpenCode 同款）：写入 ts/js 文件后自动检查，
          // 诊断随工具结果当轮折回，模型立即看到自己写出的类型错误
          if (out.sideEffects?.files_written?.length) {
            const diagNote = await postEditDiagnostics(session.cwd, out.sideEffects.files_written);
            if (diagNote) result += diagNote;
          }
          store.append({
            session_id: sid,
            type: "tool.call.completed",
            actor: "system",
            turn_id: turnId,
            causation_id: proposedEvent.event_id,
            payload: {
              call_id: call.id,
              result,
              truncated: out.truncated,
              duration_ms: Date.now() - startedAt,
              side_effects: { ...out.sideEffects, commit },
            },
          });
        } catch (err) {
          store.append({
            session_id: sid,
            type: "tool.call.failed",
            actor: "system",
            turn_id: turnId,
            causation_id: proposedEvent.event_id,
            payload: {
              call_id: call.id,
              error: err instanceof Error ? err.message : String(err),
              duration_ms: Date.now() - startedAt,
            },
          });
        }
      }
      // 工具结果已通过事件落库，下一轮迭代 rebuild 时自动折回上下文
    }
  } catch (err) {
    if (signal.aborted) return abortTurn(store, sid, turnId, "用户中断");
    store.append({
      session_id: sid,
      type: "error.occurred",
      actor: "system",
      turn_id: turnId,
      payload: {
        scope: "loop",
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      },
    });
    store.setSessionStatus(sid, "idle");
  }
}

function abortTurn(store: EventStore, sid: string, turnId: string, reason: string): void {
  store.append({
    session_id: sid,
    type: "turn.aborted",
    actor: "user",
    turn_id: turnId,
    payload: { reason },
  });
  store.setSessionStatus(sid, "idle");
}
