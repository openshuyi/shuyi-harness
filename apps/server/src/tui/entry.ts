/**
 * P1-7：TUI 进程入口（agent-bin --tui）。
 * 连接常驻服务端（--server 或 AGENT_SERVER，缺省 http://localhost:4291）。
 */
import readline from "node:readline";
import { TuiApp } from "./index.js";

export async function runTui(argv: string[]): Promise<void> {
  const serverIdx = argv.indexOf("--server");
  const baseUrl =
    (serverIdx >= 0 ? argv[serverIdx + 1] : undefined) ??
    process.env.AGENT_SERVER ??
    "http://localhost:4291";
  const cwdIdx = argv.indexOf("--cwd");
  const cwd = (cwdIdx >= 0 ? argv[cwdIdx + 1] : undefined) ?? process.cwd();

  const rl = readline.createInterface({ input: process.stdin });
  const app = new TuiApp({
    baseUrl,
    cwd,
    io: {
      write: (s) => process.stdout.write(s),
      onLine: (cb) => rl.on("line", cb),
    },
  });
  await app.run();
  app.startEventLoop();
  // Ctrl+C：运行中中断轮次，空闲时退出
  rl.on("SIGINT", () => {
    process.exit(0);
  });
}
