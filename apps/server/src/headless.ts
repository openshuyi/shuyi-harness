/**
 * Headless 模式：不开浏览器，命令行直接跑一个任务。
 *
 *   bun apps/server/src/headless.ts run "重构 src/utils 模块" \
 *     --cwd /path/to/project [--model deepseek] [--mode build] [--auto-approve]
 *
 * --auto-approve 说明：headless 没有审批界面，默认所有 always-ask 操作被拒绝；
 * 传 --auto-approve 则全部自动批准（等价于「本会话放行全部工具」）。
 * 敏感路径保护与 plan 模式只读约束不受此开关影响（fail-closed 底线不动）。
 */
import path from "node:path";
import { EventBus } from "./bus/index.js";
import { SqliteEventStore } from "./store/event-store.js";
import { createFullRegistry } from "./tools/index.js";
import { RuntimeModelRegistry } from "./model/registry.js";
import { SessionManager } from "./session/manager.js";

interface HeadlessOptions {
  cwd: string;
  model?: string;
  mode: "plan" | "build";
  autoApprove: boolean;
  dbPath: string;
  modelsConfig?: string;
}

function parseArgs(argv: string[]): { task: string; opts: HeadlessOptions } {
  const args = argv.slice(2); // 去掉 bun + 脚本路径
  if (args[0] !== "run" || !args[1]) {
    console.error(`用法: bun headless.ts run "<任务描述>" [--cwd 目录] [--model 模型id] [--mode plan|build] [--auto-approve]`);
    process.exit(2);
  }
  const task = args[1];
  const opts: HeadlessOptions = {
    cwd: process.cwd(),
    mode: "build",
    autoApprove: false,
    dbPath: path.join(process.env.HOME ?? "/root", ".agent", "agent.db"),
  };
  for (let i = 2; i < args.length; i++) {
    switch (args[i]) {
      case "--cwd": opts.cwd = path.resolve(args[++i]); break;
      case "--model": opts.model = args[++i]; break;
      case "--mode": opts.mode = args[++i] === "plan" ? "plan" : "build"; break;
      case "--auto-approve": opts.autoApprove = true; break;
      case "--db": opts.dbPath = args[++i]; break;
      default:
        console.error(`未知参数: ${args[i]}`);
        process.exit(2);
    }
  }
  return { task, opts };
}

export async function runHeadless(argv: string[]): Promise<number> {
  const { task, opts } = parseArgs(argv);
  const HOME = process.env.HOME ?? "/root";

  const bus = new EventBus();
  const store = new SqliteEventStore(opts.dbPath, bus);
  const tools = await createFullRegistry();
  const models = new RuntimeModelRegistry(
    process.env,
    opts.modelsConfig ?? process.env.AGENT_MODELS_CONFIG ?? path.join(HOME, ".agent", "models.json"),
  );
  const sessions = new SessionManager(store, tools, models);

  const modelId = opts.model ?? models.defaultModel;
  if (!models.get(modelId)) {
    console.error(`模型不可用: ${modelId}（可用：${[...models.adapters.keys()].join(", ")}）`);
    return 1;
  }

  const session = sessions.createSession({
    title: `headless: ${task.slice(0, 40)}`,
    cwd: opts.cwd,
    mode: opts.mode,
    model: modelId,
    sandbox_level: "workspace",
  });

  // headless 审批策略：auto-approve 时通过消息前置注入放行规则
  //（permission 为会话私有，借 postMessage 前 createSession 同 id 的权限实例不可达，
  //  改为创建会话后直接操纵该会话的权限服务——通过 manager 公开方法）
  if (opts.autoApprove) {
    sessions.rememberAllowAll(session.session_id, tools.list().filter((t) => t.permission === "always-ask").map((t) => t.name));
  }

  // 订阅事件流，打印进度
  let lastText = "";
  const unsub = bus.subscribe((e) => {
    if (e.session_id !== session.session_id) return;
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case "message.assistant.delta":
        process.stdout.write(p.text_delta as string);
        lastText += p.text_delta as string;
        break;
      case "message.assistant.completed":
        if (lastText) { process.stdout.write("\n"); lastText = ""; }
        break;
      case "tool.call.proposed":
        console.log(`\n[工具] ${p.tool} ${JSON.stringify(p.args).slice(0, 120)}`);
        break;
      case "tool.call.completed":
        console.log(`[完成] ${p.duration_ms}ms`);
        break;
      case "tool.call.failed":
        console.log(`[失败] ${String(p.error).slice(0, 200)}`);
        break;
      case "approval.requested":
        // P0：question 工具——headless 无交互，自动作答（首个选项或默认语）保证轮次不挂起
        if (p.tool === "question") {
          const opts = (p.args as { options?: string[] })?.options;
          const answer = opts?.[0] ?? "（headless 无交互，按你的最佳判断继续）";
          console.log(`\n[提问] ${(p.args as { question?: string })?.question} → 自动回答：${answer}`);
          sessions.resolveApproval(e.session_id, p.approval_id as string, {
            decision: "approve",
            answer,
          });
        } else {
          console.log(`[审批] ${p.tool} 需要批准但未开启 --auto-approve，已拒绝`);
        }
        break;
      case "turn.completed": {
        const usage = p.usage as { prompt_tokens: number; completion_tokens: number };
        const cost = p.cost_estimate as number | undefined;
        console.log(`\n[轮次完成] tokens ${usage.prompt_tokens}+${usage.completion_tokens}${cost != null ? ` · $${cost.toFixed(4)}` : ""}`);
        break;
      }
      case "turn.aborted":
        console.log(`\n[中断] ${p.reason}`);
        break;
      case "error.occurred":
        console.error(`[错误] ${p.message}`);
        break;
    }
  });

  console.log(`[headless] 会话 ${session.session_id.slice(0, 8)} · 模型 ${modelId} · ${opts.cwd}`);
  sessions.postMessage(session.session_id, task);

  // 等待轮次结束
  const exitCode = await new Promise<number>((resolve) => {
    const timeout = setTimeout(() => {
      console.error("\n[headless] 超时（30 分钟），强制中断");
      sessions.abort(session.session_id);
      resolve(124);
    }, 30 * 60 * 1000);
    const unsubDone = bus.subscribe((e) => {
      if (e.session_id !== session.session_id) return;
      if (e.type === "turn.completed") { clearTimeout(timeout); unsubDone(); resolve(0); }
      if (e.type === "turn.aborted") { clearTimeout(timeout); unsubDone(); resolve(1); }
    });
  });

  unsub();
  store.close();
  return exitCode;
}

// 直接执行时（bun headless.ts run ...）
if (import.meta.main) {
  const code = await runHeadless(process.argv);
  process.exit(code);
}
