/**
 * 会话回放导出：把事件日志渲染成单文件、零依赖、可分享的 HTML。
 * 渲染规则与前端 reducer 同构（消息/工具/标记三类条目）。
 */
import type { AgentEvent, SessionRecord } from "@shuyi/types";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface ToolAcc {
  callId: string;
  tool: string;
  args: string;
  status: string;
  detail: string;
}

export function renderReplayHtml(session: SessionRecord, events: AgentEvent[]): string {
  const tools = new Map<string, ToolAcc>();
  const parts: string[] = [];

  const flushTool = (t: ToolAcc) => {
    parts.push(`
      <div class="item tool">
        <div class="tool-head"><span class="tool-name">${esc(t.tool)}</span>
        <span class="badge ${esc(t.status)}">${esc(t.status)}</span></div>
        <details><summary>参数与结果</summary>
        <pre>${esc(t.args)}</pre>${t.detail ? `<pre>${esc(t.detail)}</pre>` : ""}</details>
      </div>`);
  };

  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case "message.user":
        parts.push(`<div class="item user"><div class="label">用户</div><div class="bubble">${esc(p.text as string)}</div></div>`);
        break;
      case "message.assistant.completed":
        if ((p.text as string)?.length) {
          parts.push(`<div class="item assistant"><div class="label">助手</div><div class="bubble">${esc(p.text as string)}</div></div>`);
        }
        break;
      case "tool.call.proposed":
        tools.set(p.call_id as string, {
          callId: p.call_id as string,
          tool: p.tool as string,
          args: JSON.stringify(p.args, null, 2),
          status: "proposed",
          detail: "",
        });
        break;
      case "tool.call.completed": {
        const t = tools.get(p.call_id as string);
        if (t) {
          t.status = "done";
          t.detail = `${p.result as string}${(p.side_effects as { diff?: string })?.diff ? "\n" + (p.side_effects as { diff: string }).diff : ""}`;
          flushTool(t);
          tools.delete(t.callId);
        }
        break;
      }
      case "tool.call.failed": {
        const t = tools.get(p.call_id as string);
        if (t) {
          t.status = "failed";
          t.detail = p.error as string;
          flushTool(t);
          tools.delete(t.callId);
        }
        break;
      }
      case "context.compacted":
        parts.push(`<div class="item marker">— 上下文已压缩（${p.tokens_before} → ${p.tokens_after} tokens）—</div>`);
        break;
      case "turn.aborted":
        parts.push(`<div class="item marker warn">— 轮次中断：${esc(p.reason as string)} —</div>`);
        break;
      case "error.occurred":
        parts.push(`<div class="item marker error">— 错误：${esc(p.message as string)} —</div>`);
        break;
      case "subagent.started":
        parts.push(`<div class="item marker">— 子代理开始：${esc((p.task as string).slice(0, 120))} —</div>`);
        break;
      case "subagent.completed":
        parts.push(`<div class="item marker">— 子代理完成（${p.duration_ms}ms）—</div>`);
        break;
      case "memory.written":
        parts.push(`<div class="item marker">— 写入记忆：${esc(p.excerpt as string)} —</div>`);
        break;
      case "session.config_changed": {
        const changes = Object.entries(p).map(([k, v]) => `${k} → ${v}`).join(", ");
        parts.push(`<div class="item marker">— 配置变更：${esc(changes)} —</div>`);
        break;
      }
    }
  }
  // 未闭合的工具调用（崩溃中断场景）
  for (const t of tools.values()) flushTool(t);

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>会话回放 — ${esc(session.title)}</title>
<style>
  :root { color-scheme: dark; }
  body { background: #14161c; color: #d5d9e0; font: 14px/1.6 -apple-system, "PingFang SC", sans-serif;
         max-width: 760px; margin: 0 auto; padding: 32px 16px; }
  h1 { font-size: 18px; } .meta { color: #8a91a0; font-size: 12px; margin-bottom: 24px; }
  .item { margin-bottom: 14px; } .label { font-size: 11px; color: #8a91a0; margin-bottom: 3px; }
  .bubble { background: #1c1f27; border-radius: 8px; padding: 10px 14px; white-space: pre-wrap; word-break: break-word; }
  .user .bubble { border-left: 3px solid #4c8dff; }
  .assistant .bubble { border-left: 3px solid #a9dc76; }
  .tool { background: #1c1f27; border-radius: 8px; padding: 8px 14px; }
  .tool-head { display: flex; gap: 8px; align-items: center; }
  .tool-name { font-family: ui-monospace, monospace; color: #ffd866; }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 4px; background: #2d333f; }
  .badge.done { color: #a9dc76; } .badge.failed { color: #ff6b6b; }
  pre { font: 12px/1.5 ui-monospace, monospace; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  details summary { cursor: pointer; color: #8a91a0; font-size: 12px; }
  .marker { text-align: center; color: #8a91a0; font-size: 12px; padding: 6px 0; }
  .marker.warn { color: #ffd866; } .marker.error { color: #ff6b6b; }
</style></head><body>
<h1>${esc(session.title)}</h1>
<div class="meta">
  模式 ${esc(session.mode)} · 模型 ${esc(session.model)} · ${new Date(session.created_at).toLocaleString("zh-CN")}
  ${session.usage ? ` · tokens ${(session.usage.prompt_tokens + session.usage.completion_tokens).toLocaleString()}` : ""}
  ${session.usage?.cost_usd != null ? ` · $${session.usage.cost_usd.toFixed(4)}` : ""}
</div>
${parts.join("\n")}
<div class="meta" style="margin-top:32px">由 shuyi-harness 导出 · ${events.length} 个事件 · ${new Date().toLocaleString("zh-CN")}</div>
</body></html>`;
}
