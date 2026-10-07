# shuyi-harness —— 本地优先的编码智能体（个人版 v0.5，Better T Stack 架构）

参考 OpenCode 形态的「本地服务端 + 浏览器客户端」架构，运行在 Better T Stack monorepo
（Turborepo + Biome/Ultracite + Varlock + oRPC；Better-Auth / Drizzle 为团队版预留挂钩，当前休眠）。
设计文档见 `docs/`：

- 《编码智能体-总体架构与开发计划.md》—— 设计原则、模块划分、里程碑计划
- 《编码智能体-事件模型设计.md》—— 全系统第一份契约：事件类型、SQLite schema、上下文重建算法、SSE 协议
- 《编码智能体-技术选型与仓库结构.md》—— 选型理由与 monorepo 结构
- 《编码智能体-v0.3设计-能力追赶计划.md》/《编码智能体-v0.4设计-交互体验追赶计划.md》—— 能力与交互追赶
- 《编码智能体-UI设计语言提案-v1.md / -v2.md》—— 设计语言演进（v1 静谧仪器 → v2 墨仪·天青定稿），配套可交互 HTML 设计稿（`docs/编码智能体-UI设计稿-v1/v2.html`）

## 仓库结构

```
shuyi-harness/
├── apps/
│   ├── server/        # Agent Server（Bun + Hono + libsql 事件存储）
│   │   └── src/agent/ # 智能体内核（loop/store/tools/permission/acp/checkpoint/agents/…）
│   ├── web/           # Web SPA（Vite + React + TanStack Router；Tauri 桌面壳预留）
│   └── tui/           # OpenTUI 终端界面（预留）
├── packages/
│   ├── types/         # @shuyi-harness/types — 事件模型契约（前后端共享）
│   ├── api/           # oRPC 路由层（团队版扩展点）
│   ├── auth/          # Better-Auth（休眠保留）
│   ├── db/            # Drizzle + libsql（休眠保留：团队版身份/审计表）
│   ├── ui/            # shadcn/base-lyra 组件库（含 AI Elements，供 web 重皮用）
│   └── config/        # 共享 tsconfig（noUncheckedIndexedAccess 等严格集）
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
8. 切到 Plan 模式 → 只读分析，写工具对模型不可见；计划完成后可一键批准开工（F5）
9. 侧栏搜索框 → 全文检索历史消息；会话条目显示累计 token 用量与成本
10. 工具栏「↩ 撤销本轮改动」→ 工作区 git 回滚到本轮开始前（未提交改动先自动保存）
11. 工具栏「⬇ 回放」→ 下载自包含 HTML 会话回放（可分享）
12. 📎 按钮 → 附件随消息发送，agent 可用 read 工具读取
13. 侧栏 ☀/☾ → 墨/纸主题切换（记忆选择，默认跟随系统）——「墨仪」设计语言：墨分五色表面、天青交互、朱砂盖印、宋体标题
14. 变更面板（F2）→ 逐文件 accept/revert 审查本轮改动
15. busy 时发消息 → 自动排队（Steering，F4），轮次结束后依次执行，可撤回
16. 刷新页面 / 重启服务端 → 会话现场从事件日志完整恢复

接入真实模型（OpenAI 兼容协议，含 DeepSeek / OpenAI 等）——三种方式：

```bash
# 方式一：环境变量（适合 CI / 固定配置）
# 格式：id|baseURL|apiKey|model[|label][|contextWindow][|输入价$/M][|输出价$/M][|缓存价$/M]
export AGENT_MODELS="deepseek|https://api.deepseek.com/v1|sk-你的key|deepseek-chat|DeepSeek V3|64000|0.27|1.10|0.07,openai|https://api.openai.com/v1|sk-另一key|gpt-4o"
bun run dev:server

# 方式二：Web 界面「⚙ 模型」面板直接添加（写入 ~/.agent/models.json，重启不丢）
# 方式三：直接编辑 ~/.agent/models.json
```

模型层自带：429/5xx 指数退避重试（最多 4 次）、流式中断自动恢复、
按定价的美元成本估算（输入/输出/缓存命中分别计价，显示在侧栏与输入区）。
未显式配置上下文窗口/定价时，服务端自动从 models.dev 元数据补全（24h 缓存，离线回退）。

## 项目级配置与自定义代理

**`shuyi.json`**（项目根目录；全局默认值放 `~/.agent/shuyi.json`，项目覆盖全局）：

```json
{
  "model": "deepseek",
  "instructions": ["使用 pnpm 而不是 npm", "不要改动 src/legacy 目录"],
  "permissions": { "allow": ["read", "glob"], "deny": ["bash"] },
  "auto_title": true
}
```

- `model`：新会话默认模型（显式选择 > 项目配置 > 注册表默认）
- `instructions`：注入系统提示的项目指令（AGENTS.md 的轻量替代）
- `permissions`：会话开始时预置的放行/拒绝规则
- `auto_title`：首轮完成后自动命名会话（默认开启）

**自定义代理**（`~/.agent/agents/*.md` 全局，`<cwd>/.agent/agents/*.md` 项目，同名覆盖内置）：

```markdown
---
name: explore
description: 代码库探索子代理
tools: readonly        # readonly | all | [read, grep]
model: deepseek        # 可选：覆盖会话模型
---
你是探索代理的系统提示……
```

task 工具用 `agent` 参数指定代理定义（默认 `explore`）；内置 `title` 代理负责自动标题。
安全约束不变：子代理工具面始终只读，写操作由主代理决定后执行。

## 测试与质量门

```bash
bun test                      # 在 apps/server 下运行全部用例：工具执行 / 审批 / 权限 /
                              # 上下文重建 / 崩溃恢复 / 分叉 / seq 无空洞 / git 提交 /
                              # Plan 模式 / 记忆 / 压缩 / 子代理 / MCP / LSP / 搜索 / 用量 /
                              # 模型注册表 / 重试退避 / 成本估算 / 纠错回环 / 回放导出 /
                              # 会话回滚 / bash 压缩与后台任务 / LSP 编辑后诊断 / 代理定义 /
                              # 自动标题 / 项目配置 / models.dev / todo / worktree / hooks /
                              # skills / commands / web 搜索 / question / acp / tui / rewind
bun run check                 # ultracite（Biome）lint + 格式
bun run check-types           # 全仓 tsc（turbo，严格集含 noUncheckedIndexedAccess）
bun run build                 # 全仓构建（turbo）
```

## Headless 模式（不开浏览器直接跑任务）

```bash
bun run --cwd apps/server headless run "重构 src/utils 模块" \
  --cwd /path/to/project --model deepseek --auto-approve
# 事件流实时打印到终端；事件日志照常落库，事后可在 Web 界面回放
# --auto-approve：无审批界面场景下自动批准 bash 等高风险操作
# （敏感路径保护与 Plan 模式只读约束不受影响）
```

## 更多能力

**MCP 外部工具**：把 `mcp.json.example` 复制为 `~/.agent/mcp.json` 并配置 server，
启动时自动桥接其工具（`mcp_<server>_<tool>`），与内置工具同一权限模型（默认逐条审批）。

**LSP 代码智能**：项目装有 typescript-language-server 时自动可用（诊断/定义/引用 +
编辑后诊断回注纠错回环），未安装时工具优雅降级并提示安装方法。

**ACP（IDE 协议）**：`--acp` 进入 ACP stdio 模式，作为 IDE（如 Zed）子进程运行；
**内嵌 TUI**：`--tui` 启动终端客户端（连接常驻服务端）。

**上下文压缩**：窗口填充 75% 自动触发（确定性清理 → 结构化模板摘要），
`AGENT_CONTEXT_WINDOW` 可配置窗口大小。

**环境变量**（均可选，见 `apps/server/.env.schema`，Varlock 管理）：
`AGENT_PORT`（4351）、`AGENT_DB`（~/.agent/agent.db）、`AGENT_MODELS`、
`AGENT_MODELS_CONFIG`（~/.agent/models.json）、`AGENT_MCP_CONFIG`（~/.agent/mcp.json）、
`AGENT_CONTEXT_WINDOW`（128000）、`AGENT_WEB_DIST`。

## 架构一图

```
浏览器 SPA (React + Zustand + TanStack Query，聚合 SSE 直连 4351)
   │ HTTP + SSE（after_seq 断线续传；聚合流支持双会话对比）
   ▼
Hono 宿主（CORS / Better-Auth(休眠) / oRPC /rpc / Agent REST+SSE /api/* / 静态托管）
   ▼
Agent 内核 (src/agent/)
   API 层 → 会话管理（队列/rewind/worktree/自动标题）→ 核心 Loop
   ─┬─ 权限服务（fail-closed + 审批 + glob 规则 + 项目配置）
    ├─ 工具系统（read/write/edit/bash(+后台)/glob/grep/todo/web/question/task）
    ├─ 上下文工程（重建 / 前缀稳定 / 压缩 / 记忆 / todo 附录）
    ├─ 代理定义（agents/*.md）/ 技能（skills）/ 斜杠命令 / hooks
    ├─ 检查点（write 影子快照 → rewind/变更面板审查）
    └─ 模型适配层（mock / OpenAI 兼容 / 重试 / 成本 / models.dev）
   ▼
libsql SQLite 事件日志（append-only，唯一事实来源；WAL）
```

核心不变量：**一切皆是事件**。模型看到的一切都能从事件日志完整重建；
恢复、回放、分叉、rewind、未来的审计都是对同一条事件流的不同 fold。

## 当前状态与 roadmap

已完成（v0.5 + BTS 架构迁移）：v0.2 内核全部能力（安全基线 / 上下文工程 /
能力扩展 / 主体）、P5 模型实战化、P6 质量与可观测性、P7 能力深化（回滚/附件/headless）、
P8 对齐 OpenCode/DeepSeek Harness、v0.3 能力追赶（M1–M6）、v0.4 交互体验追赶（F1–F10）、
Better T Stack 架构迁移（Turborepo/Biome/Varlock/libsql + 严格 TS 质量门）、
墨仪 UI 主题升级 v2.1（墨/纸双主题 token、天青×朱砂双轨、宋体标题轨 @fontsource 自托管、
「准」批准印+盖章动效、按钮去胶囊化、卡片顶光/触感层等高级感工程）。
待做（backlog）：web shadcn 组件层迁移（packages/ui 已备 AI Elements，token 语义已对齐墨仪）、
API oRPC 化、Better-Auth/Drizzle 团队版唤醒、Tauri 桌面打包、TUI 接入、
`bun build --compile` × libsql 复验、平移组件 lint 冻结解除。
详见 docs 中开发计划文档。
