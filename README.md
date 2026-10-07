# shuyi-harness —— 本地优先的编码智能体（个人版 v0.3，Better T Stack 架构）

参考 OpenCode 形态的「本地服务端 + 浏览器客户端」架构，v0.3 起运行在
Better T Stack monorepo（Turborepo + Biome/Ultracite + Varlock + oRPC，
团队版预留 Better-Auth / Drizzle 挂钩，当前休眠）。
设计文档见 `docs/`：

- 《编码智能体-总体架构与开发计划.md》—— 设计原则、模块划分、里程碑计划
- 《编码智能体-事件模型设计.md》—— 全系统第一份契约：事件类型、SQLite schema、上下文重建算法、SSE 协议
- 《编码智能体-技术选型与仓库结构.md》—— 选型理由与 monorepo 结构

## 仓库结构

```
shuyi-harness/
├── apps/
│   ├── server/        # server — Agent Server（Bun + Hono + libsql 事件存储）
│   │   └── src/agent/ # 迁移自 v0.2 的智能体内核（loop/store/tools/permission/…）
│   ├── web/           # web    — Web SPA（Vite + React + TanStack Router，Tauri 桌面壳预留）
│   └── tui/           # tui    — OpenTUI 终端界面（预留，迁移后启用）
├── packages/
│   ├── types/         # @shuyi-harness/types — 事件模型契约（前后端共享）
│   ├── api/           # oRPC 路由层（团队版扩展点）
│   ├── auth/          # Better-Auth（休眠保留：代码架构在，未接路由）
│   ├── db/            # Drizzle + libsql（休眠保留：团队版身份/审计表）
│   ├── ui/            # shadcn/base-lyra 组件库（含 AI Elements，供 web 重皮用）
│   └── config/        # 共享 tsconfig
├── docs/              # 架构设计文档
└── mcp.json.example   # MCP 配置示例
```

## 快速开始

前置：已安装 [Bun](https://bun.sh)（≥ 1.4）。

```bash
bun install

# 终端 1：启动 Agent Server（默认端口 4351）
bun run dev:server

# 终端 2：启动 Web 开发服务器（端口 4350）
bun run dev:web
# 打开 http://localhost:4350
```

说明：dev 下 web 直连 `VITE_SERVER_URL`（http://localhost:4351），
不经 vite 代理——本机代理/VPN 软件可能缓冲代理层的 SSE 流。

生产模式（单进程单端口，server 托管构建好的 SPA）：

```bash
bun run build         # turbo：tsdown 打包 server + vite 构建 web
cd apps/server && bun run start
# 打开 http://localhost:4351
```

## 体验路径（内置 Mock 模型，无需 API key）

1. 输入工作区绝对路径 → 点「+ 新会话」（路径会被记住，支持 `~` 前缀）
2. 输入普通消息 → 看流式输出
3. 输入 `!write test.txt 你好` → write 工具在工作区内自动放行，工具卡片可展开看 diff，改动自动 git 提交
4. 输入 `!bash ls -la` → 弹出审批窗（完整命令可见）→ 批准后执行
5. 输入 `!write /etc/evil.txt x` → 权限服务 fail-closed 拒绝（越出工作区）
6. 输入 `!task 总结这个项目` → 子代理在隔离上下文探索后带回摘要
7. 输入 `!memory 项目用 Bun 运行时` → 写入项目记忆，后续会话自动注入
8. 切到 Plan 模式 → 只读分析，写工具对模型不可见
9. 侧栏搜索框 → 全文检索历史消息；会话条目显示累计 token 用量
10. 刷新页面 / 重启服务端 → 会话现场从事件日志完整恢复

接入真实模型（OpenAI 兼容协议，含 DeepSeek 等）：

```bash
export AGENT_MODELS="deepseek|https://api.deepseek.com/v1|sk-你的key|deepseek-chat"
bun run dev:server   # 新会话即可选择 deepseek 模型
```

## 测试与质量门

```bash
bun test              # 22 个用例（apps/server）：工具执行 / 审批 / 权限 /
                      # 上下文重建 / 崩溃恢复 / 分叉 / seq 无空洞 / git 提交 /
                      # Plan 模式 / 记忆 / 压缩 / 子代理 / MCP / LSP / 搜索 / 用量
bun run check         # ultracite（Biome）lint + 格式
bun run check-types   # 全仓 tsc（turbo）
bun run build         # 全仓构建（turbo）
```

## 更多能力

**MCP 外部工具**：把 `mcp.json.example` 复制为 `~/.agent/mcp.json` 并配置 server，
启动时自动桥接其工具（`mcp_<server>_<tool>`），与内置工具同一权限模型（默认逐条审批）。

**LSP 代码智能**：项目装有 typescript-language-server 时自动可用（诊断/定义/引用），
未安装时工具优雅降级并提示安装方法。

**上下文压缩**：窗口填充 75% 自动触发（确定性清理 → 结构化模板摘要），
`AGENT_CONTEXT_WINDOW` 可配置窗口大小。

**环境变量**（均可选，见 `apps/server/.env.schema`，Varlock 管理）：
`AGENT_PORT`（4351）、`AGENT_DB`（~/.agent/agent.db）、`AGENT_MODELS`、
`AGENT_MCP_CONFIG`（~/.agent/mcp.json）、`AGENT_CONTEXT_WINDOW`（128000）、`AGENT_WEB_DIST`。

## 架构一图

```
浏览器 SPA (React + Zustand + TanStack Query，SSE 直连 4351)
    │ HTTP + SSE（after_seq 断线续传）
    ▼
Hono（宿主：CORS / Better-Auth(休眠) / oRPC /rpc / Agent REST+SSE /api/*）
    ▼
Agent 内核 (src/agent/)
    API 层 → 会话管理 → 核心 Loop ─┬─ 权限服务（fail-closed + 审批工作流）
                                   ├─ 工具系统（read/write/edit/bash/glob/grep）
                                   ├─ 上下文工程（重建 / 前缀稳定 / 压缩预留）
                                   └─ 模型适配层（mock / OpenAI 兼容）
    ▼
libsql SQLite 事件日志（append-only，唯一事实来源；WAL）
```

核心不变量：**一切皆是事件**。模型看到的一切都能从事件日志完整重建；
恢复、回放、分叉、未来的审计都是对同一条事件流的不同 fold。

## 当前状态与 roadmap

已完成：v0.2 全部能力（P0 骨架、P1 安全基线、P2 上下文工程、P3 能力扩展、
P4 主体）+ v0.3 架构迁移（Better T Stack monorepo、libsql 驱动、严格 TS/Biome 质量门）。
待做（P6 backlog）：web 升级 shadcn/Tailwind v4 重皮（packages/ui 已备好 AI Elements）、
API oRPC 化、Better-Auth/Drizzle 团队版唤醒、Tauri 桌面打包、TUI 接入。
详见 docs 中开发计划文档。
