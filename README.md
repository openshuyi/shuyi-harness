# shuyi-harness —— 本地优先的编码智能体（个人版 v0.2）

参考 OpenCode 形态的「本地服务端 + 浏览器客户端」架构。设计文档见 `docs/`：

- 《编码智能体-总体架构与开发计划.md》—— 设计原则、模块划分、里程碑计划
- 《编码智能体-事件模型设计.md》—— 全系统第一份契约：事件类型、SQLite schema、上下文重建算法、SSE 协议
- 《编码智能体-技术选型与仓库结构.md》—— 选型理由与 monorepo 结构

## 仓库结构（better-t-stack 规范）

```
shuyi-harness/
├── apps/
│   ├── server/        # @shuyi/server — Agent Server（Bun + Hono）
│   └── web/           # @shuyi/web    — Web SPA（Vite + React）
├── packages/
│   └── types/         # @shuyi/types  — 事件模型契约（前后端共享）
├── docs/              # 架构设计文档
└── mcp.json.example   # MCP 配置示例
```

## 快速开始

前置：已安装 [Bun](https://bun.sh)（≥ 1.4）。

```bash
# 安装依赖（workspaces；npm 亦可）
bun install        # 或 npm install

# 终端 1：启动 Agent Server（默认端口 4291）
bun run dev:server

# 终端 2：启动 Web 开发服务器（端口 4290，代理 /api 到 4291）
bun run dev:web
# 打开 http://localhost:4290
```

生产模式（单进程单端口）：

```bash
bun run build:web
bun run --cwd apps/server start
# 打开 http://localhost:4291
```

## 体验路径（内置 Mock 模型，无需 API key）

1. 点击「+ 新会话」
2. 输入普通消息 → 看流式输出
3. 输入 `!write test.txt 你好` → write 工具在工作区内自动放行，工具卡片可展开看 diff，改动自动 git 提交
4. 输入 `!bash ls -la` → 弹出审批窗（完整命令可见）→ 批准后执行
5. 输入 `!write /etc/evil.txt x` → 权限服务 fail-closed 拒绝（越出工作区）
6. 输入 `!task 总结这个项目` → 子代理在隔离上下文探索后带回摘要
7. 输入 `!memory 项目用 Bun 运行时` → 写入项目记忆，后续会话自动注入
8. 切到 Plan 模式 → 只读分析，写工具对模型不可见
9. 侧栏搜索框 → 全文检索历史消息；会话条目显示累计 token 用量
10. 刷新页面 / 重启服务端 → 会话现场从事件日志完整恢复

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

## 测试

```bash
bun test            # 22 个用例（4 个文件）：工具执行 / 审批批准与拒绝 / 权限拒绝 /
                    # 上下文重建配对 / 崩溃恢复 / 分叉 / seq 无空洞 /
                    # git 提交 / Plan 模式 / 记忆 / 压缩 / 子代理 / MCP / LSP / 搜索 / 用量
bun run typecheck   # 全量类型检查
```

## 更多能力

**MCP 外部工具**：把 `mcp.json.example` 复制为 `~/.agent/mcp.json` 并配置 server，
启动时自动桥接其工具（`mcp_<server>_<tool>`），与内置工具同一权限模型（默认逐条审批）。

**LSP 代码智能**：项目装有 typescript-language-server 时自动可用（诊断/定义/引用），
未安装时工具优雅降级并提示安装方法。

**独立二进制分发**：

```bash
bun run build:binary   # 产出 agent-bin（约 79MB，含运行时）
AGENT_WEB_DIST=apps/web/dist ./agent-bin
```

**上下文压缩**：窗口填充 75% 自动触发（确定性清理 → 结构化模板摘要），
`AGENT_CONTEXT_WINDOW` 可配置窗口大小。

## 架构一图

```
浏览器 SPA (React + Zustand + TanStack Query)
   │ HTTP + SSE（after_seq 断线续传）
   ▼
Agent Server (Bun + Hono)
   API 层 → 会话管理 → 核心 Loop ─┬─ 权限服务（fail-closed + 审批工作流）
                                  ├─ 工具系统（read/write/edit/bash/glob/grep）
                                  ├─ 上下文工程（重建 / 前缀稳定 / 压缩预留）
                                  └─ 模型适配层（mock / OpenAI 兼容）
   ▼
SQLite 事件日志（append-only，唯一事实来源）
```

核心不变量：**一切皆是事件**。模型看到的一切都能从事件日志完整重建；
恢复、回放、分叉、未来的审计都是对同一条事件流的不同 fold。

## 当前状态与 roadmap

已完成（v0.3）：P0 骨架、P1 安全基线（含 git 原子提交）、P2 上下文工程
（结构化压缩 / 记忆 / Plan/Build 工具面）、P3 能力扩展（LSP / MCP / 子代理）、
P4 主体（全文搜索 / 用量统计 / 二进制分发）、P5 模型实战化（多 provider /
运行时模型管理 / 失败重试 / 成本估算）。
待做：真实模型长任务调优、批量编辑审阅、Trajectory 来源过滤、团队版三挂钩的
中心化实现（身份 / 存储 / 审计）。详见 docs 中开发计划文档。
