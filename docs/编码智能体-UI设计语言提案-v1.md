# 编码智能体 UI 设计语言提案 v1 —— Quiet Instrument（静谧仪器）

> 日期：2026-10-07
> 状态：提案（研究与讨论稿，未实施）
> 配套设计稿：`docs/编码智能体-UI设计稿-v1.html`（浏览器直接打开，支持深浅主题切换）
> 适用范围：apps/web 重皮；packages/ui（shadcn base-lyra）token 槽位映射；TUI 配色可参照同一 token 体系

---

## 0. 一句话定位

**把 UI 从「会说话的玩具」做成「可信的仪器」。**

harness 是给模型装的仪器台，Web 界面是仪器的操作面板。高级感的来源不是圆润亲和的消费级气质，而是仪器的克制与精确：示波器、终端、瑞士排版。2026 年开发者工具的最高褒奖是"它像 Linear"——calm design 已是品牌属性，不是风格选项。

---

## 1. 研究结论：2026 设计趋势与竞品基线

### 1.1 趋势研究要点（2026-10 检索）

| 趋势 | 对本项目的含义 |
|---|---|
| **Calm design（Linear 式克制）** 被誉为 2026 最高级感代名词 | 留白重、视觉噪音零、功能强大但默认不展示 |
| **Technical Mono / 代码 brutalism**：mono 字体进主流设计系统，Vercel/Factory AI 引领 | 开发者工具的"身份证"：工具名、路径、token 数、耗时全部 mono |
| **正经设计的 dark mode**：独立设计调色板，而非机械反转 | 深色靠表面分层 + 发丝线，不靠阴影；对比度单独校验 |
| **三层 Design Token**（primitive → semantic → component），W3C DTCG 规范 2025.10 发布，token 采用率 84% | 新 token 体系按三层组织，直接映射 shadcn oklch 槽位 |
| **色彩即信号，非装饰**（Geist 铁律：彩色只出现在 ≤10px 状态点与数据） | 渐变、彩色按钮、彩色图标全面收敛 |
| Bento 网格、微交互、空间层次（Apple Spatial）持续有效 | 用于空状态、仪表化面板（用量、成本） |

### 1.2 竞品视觉语言拆解

- **Vercel Geist**：#fafafa 画布 / #171717 墨色 / 4 档灰阶 / 唯一强调蓝 #0072F5 / 6px 圆角 / Geist Sans 显示尺寸负字距 -0.02em~-0.06em / mono 只用于代码与标签 / "渐变只留给发布日"。
- **Linear**：近黑画布 #08090a 起步，表面差极小（2-3% 亮度步进），发丝线分层，动效 120-200ms，文本层级 3 档走天下。
- **Factory AI / Unit**：Technical Mono 代表，整站 mono 标签体系，大写 + 宽字距的 11px 标签是"section 身份证"。

### 1.3 现行设计语言诊断（apps/web/src/styles.css，"2026 设计语言"）

| 现状 | 问题 |
|---|---|
| 电光靛蓝渐变 `#6e6cf6→#a78bfa` 用在品牌字、发送钮、进度条、primary 按钮 | 渐变滥用 = 廉价感第一来源；Geist 判例：渐变是"仪式"，不是日常 |
| 按钮一律 999px 胶囊 | 玩具感；信息密集界面中胶囊破坏纵向节奏 |
| 圆角 8/12/18px + 卡片柔影 `0 2px 10px rgba(0,0,0,.25)` | 深色下阴影几乎不可见，层次实际靠边框在撑；圆角 18px 偏消费级 |
| 单轨系统字体，mono 仅代码块 | 工具名、耗时、token 数等"仪器读数"没有 mono 加持，失去 dev tool 气质 |
| 表面四层 `#0b0d12→#1f2431`（思路正确） | 层差偏大（每步 ~6-8% 亮度），多层堆叠时显"脏"；保留分层思路，收窄步进 |

**结论：保留品牌靛蓝与四层表面的骨架资产，切除渐变依赖、胶囊形、大圆角，引入 mono 双轨排版与信号化用色。**

---

## 2. 设计原则（六条铁律）

1. **色彩即信号。** 彩色只出现在：状态点（8px）、语义文本、diff、语义按钮。绝不做装饰。谁在界面上看到颜色，谁就获得了信息。
2. **渐变是仪式。** 品牌渐变只保留两处：产品 logo、空状态插画。按钮、进度条、发送键一律纯色。
3. **仪器读数用 mono。** 工具名、文件路径、命令、token 计数、耗时、seq、成本——凡"读数"皆 `font-mono`；凡"叙述"皆 sans。这是 Technical Mono 的落地。
4. **层次靠表面与线，不靠阴影。** 深色下阴影被吞没；用 3% 亮度步进的表面阶梯 + 3 档发丝线分层。阴影只属于浮层（弹窗、菜单）。
5. **密度即尊重。** Trajectory 是信息流，行高紧凑（13px 正文、24px 行高）；弹窗是决策时刻，舒适（14px 正文）。密度分级，不搞一刀切。
6. **动效快而准。** 140ms hover / 200ms 展开 / 280ms 弹窗，位移 ≤4px。动效的职责是解释"东西从哪来"，不是表演。

---

## 3. Design Token 体系（三层）

对齐 W3C DTCG：primitive（原值）→ semantic（语义槽）→ component（组件槽）。本文档定稿 semantic 层；primitive 层在落地时展开为 12 档灰阶 + 品牌阶。

### 3.1 表面（Dark 默认）

| Token | 值 | 用途 |
|---|---|---|
| `--bg-0` | `#090b10` | 应用画布（最深，侧栏底、body） |
| `--bg-1` | `#0e1117` | 一级面板（侧栏卡、右面板容器） |
| `--bg-2` | `#141822` | 卡片（消息、工具卡、输入区） |
| `--bg-3` | `#1b2030` | 浮层（弹窗、菜单、hover 提升） |
| `--bg-inset` | `#0a0c11` | 内嵌凹陷（代码块、终端、diff、输入框内嵌区） |

层差约 3% 亮度步进，比现行（6-8%）收窄，多层堆叠不发脏。

### 3.2 文本

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `--text-1` | `#edeef2` | `#1d1f26` | 主文 |
| `--text-2` | `#9ba3b0` | `#565b68` | 次文（比现行 `#8a91a3` 提亮一档，长文可读性） |
| `--text-3` | `#5f6674` | `#9aa0aa` | 弱文（时间戳、meta、占位符） |

### 3.3 线

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `--line-1` | `rgba(255,255,255,.06)` | `rgba(24,26,36,.07)` | 分区分隔线 |
| `--line-2` | `rgba(255,255,255,.11)` | `rgba(24,26,36,.12)` | 卡片描边 |
| `--line-3` | `rgba(255,255,255,.18)` | `rgba(24,26,36,.19)` | 交互边（输入框、hover 提升） |

### 3.4 品牌色（保留靛蓝资产，收敛用法）

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `--accent` | `#6e6cf6` | `#5856ea` | 主交互色：primary 按钮、链接、焦点、进行中 |
| `--accent-hover` | `#7f7df8` | `#4745d8` | hover |
| `--accent-active` | `#5d5bf0` | `#6a68f0` | active |
| `--accent-soft` | `rgba(110,108,246,.13)` | `rgba(88,86,234,.10)` | 选中底、hover 底、高亮块 |
| `--accent-ring` | `rgba(110,108,246,.45)` | `rgba(88,86,234,.40)` | focus ring |
| `--brand-gradient` | `135deg #6e6cf6 → #8f7bf9` | 同 | **仅** logo 与空状态插画 |

#### 3.4.1 品牌色备选（开放决策，对照设计稿第 16 节实时换肤试验场）

靛蓝是 AI 工具类别最拥挤的色相（Linear `#5e6ad2` / Warp / Arc / Obsidian 全在靛紫族）。但拥挤≠廉价——Linear 本身就是靛蓝，廉价来自饱和滥用而非色相。语义系统预订绿/红/黄/青后，accent 合法空间只剩四个：

| 候选 | 值（dark） | 叙事 | 代价 | 判断 |
|---|---|---|---|---|
| **电光靛**（现行） | `#6e6cf6` | 品牌资产延续 | 类别最拥挤 | 求稳首选：高级感靠纪律赢 |
| **信号橙** | `#ff7847`（深色下配墨色文字） | Teenage Engineering / 航空琥珀灯 / 合成器 LED——与"静谧仪器"叙事最合 | warn 需让位纯黄 `#facc15`；暖色贴近 danger 区需拉开 | 求身份首选：稀缺 × 叙事双满 |
| **信号品红** | `#e34f97` | 类别几乎无人用，辨识度最高 | 时尚感与"静谧"气质有张力 | 大胆选项 |
| **墨水无彩度** | `#e9ebf0`（dark）/ `#1d1f26`（light） | Geist / Cursor 路线，理论上限最高 | "进行中"信号与交互色同质化；链接/焦点需辅助功能蓝 | 最挑排版与信号系统设计 |

**决策建议**：v1 先按电光靛落地（零迁移成本），品牌色作为独立决策开放——第 16 节可在真实组件上四选一实时对比。若选信号橙，§3.5 warn 语义色同步调为纯黄，按钮文字色引入 `--on-accent` 令牌（深色 `#1c0f08`）。

### 3.5 语义色（信号系统）

| Token | Dark | Light | 信号含义 |
|---|---|---|---|
| `--success` | `#34d399` | `#0e9f6e` | 完成、accept、连接正常 |
| `--danger` | `#f8717f` | `#e5484d` | 错误、拒绝、destructive |
| `--warn` | `#f5b954` | `#b7791f` | 等待审批、用量 >70%、中断 |
| `--info` | `#6bd6f5` | `#0e7490` | 提示、外部链接、预览 |

各配 `--*-soft`（12% alpha）用于底色块。**语义色不做渐变、不做大底色块（>24px 高的彩底一律禁止）。**

### 3.6 Light 主题表面

| Token | 值 |
|---|---|
| `--bg-0` | `#f5f5f1`（暖白画布，延续现行气质） |
| `--bg-1` | `#fbfbf8` |
| `--bg-2` | `#ffffff` |
| `--bg-3` | `#ffffff`（浮层靠阴影区分） |
| `--bg-inset` | `#f2f2ec` |

---

## 4. 排版系统（双轨）

### 4.1 字族

```css
--font-sans: "Inter", -apple-system, "SF Pro Text", "Segoe UI",
             "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
--font-mono: "JetBrains Mono", "SF Mono", ui-monospace, "Cascadia Code", monospace;
```

- 落地时 Inter + JetBrains Mono 走 `next/font`/`@fontsource` 自托管（本地优先原则，不引 CDN）。
- 中文回退 PingFang SC / Microsoft YaHei / Noto Sans SC（沿用现行栈）。

### 4.2 字号阶梯

| 级 | 值 | 用途 | 备注 |
|---|---|---|---|
| display | 24px / 600 / -0.02em | 页面大标题（少用） | |
| h2 | 20px / 600 | 面板标题、弹窗标题 | |
| h3 | 16px / 600 | 卡片组标题 | |
| body | 14px / 400 / 1.6 | 默认正文 | |
| body-dense | 13px / 400 / 1.55 | **Trajectory 信息流专用** | 密度即尊重 |
| meta | 12px / 400 | 辅助说明、列表 meta | |
| **label-mono** | **11px / 500 / mono / uppercase / +0.06em** | **仪器读数标签**：工具名、状态、分区号 | Technical Mono 落地 |
| code | 13px / 400 / mono | 代码块、行内码、命令 | |

### 4.3 mono 读数清单（谁必须用 mono）

工具名（`bash` `write` `edit`）、文件路径、命令行、diff、token 计数（`in 12.4k / out 3.2k`）、成本（`$0.0831`）、耗时（`412ms`）、seq 号、模型名（`glm-5.3`）、快捷键（`⌘K` `Esc`）、状态标签（`RUNNING` `AWAITING APPROVAL`）。

---

## 5. 形状 · 间距 · 阴影 · 动效

### 5.1 圆角（告别胶囊）

| Token | 值 | 用途 |
|---|---|---|
| `--r-xs` | 6px | badge、kbd、小元素 |
| `--r-sm` | 8px | **按钮、输入框、工具卡**（统一基准） |
| `--r-md` | 10px | 消息卡、面板卡 |
| `--r-lg` | 12px | 弹窗、命令面板 |
| `--r-full` | 999px | 仅状态点、头像 |

### 5.2 间距

4px 基数：`4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 56`。组件内距基准：工具卡 12px、消息卡 16px、弹窗 24px。

### 5.3 阴影（只属于浮层）

| Token | 值 | 用途 |
|---|---|---|
| `--shadow-1` | `0 1px 2px rgba(23,26,38,.06)` | light 卡片微影 |
| `--shadow-2` | `0 4px 16px rgba(23,26,38,.08)` | light hover 提升 |
| `--shadow-3` | `0 16px 48px rgba(23,26,38,.16)` | light 弹窗 |
| `--shadow-pop` | `0 16px 48px rgba(0,0,0,.55)` | **深色唯一的阴影**：弹窗/菜单 |

### 5.4 动效

| Token | 值 | 用途 |
|---|---|---|
| `--dur-fast` | 140ms | hover、focus |
| `--dur-base` | 200ms | 展开、折叠、面板 |
| `--dur-slow` | 280ms | 弹窗、命令面板 |
| `--ease` | `cubic-bezier(.25,.46,.45,.94)` | 默认 |
| `--ease-pop` | `cubic-bezier(.34,1.3,.64,1)` | 弹窗入场（轻微过冲） |

保留现行功能性动效：`dot-pulse`（等待审批）、`shimmer`（流式输出）——它们是信号，不是表演。全部动效遵守 `prefers-reduced-motion` 降级。

---

## 6. 组件规格对照（核心元素）

### 6.1 按钮

| 变体 | 规格 |
|---|---|
| primary | `bg-accent`，hover `accent-hover`，白字，`r-sm`，高 32/36/40 |
| secondary | `bg-2` + `line-2` 描边，hover 提升到 `bg-3` + `line-3` |
| ghost | 透明，hover `accent-soft` |
| destructive | `bg-danger` 白字（审批"拒绝"用 secondary-danger：`danger-soft` 底 + danger 字） |
| 发送键 | **纯色 accent 方形 r-sm**（原渐变胶囊 → 纯色圆角方），运行中变"停止"（danger 描边） |

### 6.2 工具调用卡片（Trajectory 灵魂组件）

```
┌────────────────────────────────────────────┐
│ ● bash   pnpm build                   412ms │  ← 头部：状态点 + mono 工具名
├────────────────────────────────────────────┤    + mono 目标参数 + mono 耗时
│ $ pnpm --filter web build                  │  ← 展开：inset 底 mono 命令
│ ...                                        │
│ exit 0 · 24 lines                          │  ← 结果摘要 mono
└────────────────────────────────────────────┘
```

- 头部高 32px：状态点 6px + `label-mono` 工具名 + 目标（路径截断）+ 右对齐耗时。
- 状态点：`accent` 运行中（pulse）/ `success` 成功 / `danger` 失败 / `warn` 等待审批。
- 默认折叠；点击展开 body（`bg-inset` + mono）。
- `write/edit` 卡展开内嵌 diff（见 6.3）。

### 6.3 Diff

- 文件头：mono 路径 + `+12 −3` 统计（增绿删红，mono）。
- 行：`bg-inset` 底，行号 mono `text-3`，增行 `success-soft` 底 + 左 2px success 线，删行同理 danger。
- 逐文件 accept（success）/ revert（secondary）按钮在文件头右侧。

### 6.4 审批弹窗（决策时刻，舒适密度）

- `r-lg` 弹窗，`shadow-pop`，标题 h2 + `label-mono AWAITING APPROVAL`（warn）。
- 命令完整入参：`bg-inset` mono 块，可滚动，**不截断**（fail-closed 的可视化）。
- 按钮组：[批准]（primary）[拒绝]（destructive）[本会话放行此规则]（ghost，mono 规则 `bash:pnpm test*`）。

### 6.5 Composer（输入区）

- 容器：`bg-2` + `line-2` + `r-md`，聚焦时 `line-3` + `accent-ring` 外圈。
- 模式切换 Plan/Build：分段控件（segmented），选中段 `accent-soft` 底 + accent 字。
- 用量条（常驻底部）：mono 读数 `in 12.4k · out 3.2k · $0.0831 · ctx 43%`；ctx >70% 整条转 warn 色。
- 排队消息 chips：mono + 移除 ×。

### 6.6 会话列表

- 分组头：`label-mono`（PINNED / RUNNING / AWAITING / IDLE）+ 计数 mono。
- 项：标题 13px + meta 行（相对时间 + token 摘要，`text-3`）+ 状态点。
- 置顶项左侧 2px accent 竖线；选中项 `accent-soft` 底。

### 6.7 计划卡片（Plan 批准流）

- `accent-soft` 顶线 + h3 "执行计划" + 任务清单（checkbox 样式只读列表）。
- 底部 [批准执行]（primary）[编辑后批准]（secondary）。

### 6.8 命令面板（⌘K）

- `r-lg` + `shadow-pop`，顶部输入 + `label-mono` 分组（SESSION / ACTION / THEME）。
- 项：图标 + 标签 + 右侧 kbd 快捷键。

### 6.9 消息流

- user：右对齐气泡 `accent-soft` 底 `r-md`（去尖角胶囊）。
- assistant：全宽无气泡，markdown 渲染；标题/列表/引用/代码块按 4.2 阶梯；代码块 `bg-inset` + mono + 语言标签 `label-mono`。
- 悬浮操作条：编辑 ✎ / 回滚 ↺ / 分叉 ⑂ —— icon button ghost，hover 显形。

---

## 7. 主题机制统一（必须解决的冲突）

现行 web 用 `html[data-theme="dark|light"]` 属性 + localStorage（`main.tsx`），packages/ui 的 shadcn token 用 `.dark` class。**提案：统一为 `data-theme` 属性方案，并在 ui 包 `globals.css` 增加 `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));`**，使 Tailwind v4 的 `dark:` 变体直接适配属性选择器。理由：

1. data-theme 可承载更多主题变体（未来 high-contrast）；
2. 现行 main.tsx 初始化逻辑零改动；
3. shadcn 组件只需变体重定向，不改写法。

shadcn 槽位映射（重皮时的对接表）：

| shadcn token | 映射到 |
|---|---|
| `--background` | `--bg-0` |
| `--card` | `--bg-2` |
| `--popover` | `--bg-3` |
| `--primary` / `--ring` | `--accent` / `--accent-ring` |
| `--muted` | `--bg-inset`，`--muted-foreground` → `--text-3` |
| `--border` | `--line-2`，输入边框场景 → `--line-3` |
| `--chart-1..5` | accent / info / success / warn / danger |
| `--sidebar-*` | `--bg-1` 系 |
| `--radius` | `0.5rem`（8px，派生 sm/md/lg 自动收敛） |

---

## 8. 落地路线（建议，不在本提案内实施）

1. **P0 token 迁移**：ui 包 `globals.css` 重写为本提案 semantic token（保留 oklch 表示法亦可，值按本表换算）+ `@custom-variant dark`。
2. **P0 主题统一**：web 保留 data-theme；ui 包变体适配。
3. **P1 组件替换**：trajectory 工具卡 → ai-elements `tool.tsx` 骨架 + 本提案头部规格；composer → `prompt-input.tsx`；审批 → dialog 变体。
4. **P2 密度与动效**：body-dense 应用到 trajectory；动效 token 化。
5. **P3 字体自托管**：`@fontsource-variable/inter` + `@fontsource-variable/jetbrains-mono`。
6. 每步验收：`dev:server + dev:web + bun test` 全绿 + 双主题截图目检（延续 v0.4 验收惯例）。

---

## 9. 设计稿使用说明

打开 `docs/编码智能体-UI设计稿-v1.html`：

- 右上角切换深/浅主题（token 全量联动）。
- 每个分区带 `label-mono` 编号（01 COLOR … 14 WORKBENCH），组件旁标注关键 token，可直接对照实现。
- 第 14 节为完整工作台合成预览（会话列表 + Trajectory + 变更面板 + Composer + 审批弹窗），验证整套语言在真实密度下的整体效果。
- 第 15 节为高级感细节示范（tabular 数字 / 卡片顶光 / stagger 入场 / 安静滚动条 / 流式光标 / 双层焦点环），均可交互重放。
- 第 16 节为品牌色试验场：电光靛 / 信号橙 / 信号品红 / 墨水四候选一键换肤整页（含 warn 联动与 `--on-accent` 文字色适配），供品牌色开放决策（§3.4.1）。
- 第 17–21 节为应用框架与扩展规格：应用外壳布局（区域/尺寸/行为/三变体）、菜单（下拉/右键）、表单控件全套、数据展示（表格/树/tabs/callout/面包屑）、图标系统（自绘 16px SVG sprite 全清单 + 使用规则）。

设计稿本身即本提案的自证：它由同一套 token 渲染，无一处硬编码色值逃逸。

---

## 10. 高级感工程学（v1.1 补章）

### 10.1 三层公式

**高级感 = 克制 × 精确 × 生命感。**

- **克制**（§1-§5 已覆盖）：色彩收敛、渐变仪式化、单色图标、留白自信。这是地板，不是天花板。
- **精确**（本节 a/b/d/f/g）：用户说不出哪里好，但"手感对"的全部来源——工程细节的像素级纪律。
- **生命感**（本节 c/e + §5.4）：流式光标、数字平滑爬升、列表呼吸入场。界面是活的仪器，不是印刷品。

单个细节低于感知阈值；叠加后构成"昂贵"的直觉。这就是为什么高级感无法靠加装饰获得，只能靠消除廉价感获得。

### 10.2 技巧清单（对照设计稿第 15 节）

| # | 技巧 | 关键实现 | 应用点 | 优先级 |
|---|---|---|---|---|
| a | **tabular 数字** | `font-variant-numeric: tabular-nums` | 一切流式读数：token 计数、成本、上下文占比、耗时 | **P0** |
| b | **卡片顶光** | dark：`box-shadow: inset 0 1px 0 rgba(255,255,255,.045)`；light：底边 1px 落影 | 所有 bg-2 卡片、弹窗、输入区 | **P0** |
| c | **stagger 入场** | `animation-delay: calc(var(--i) * 45ms)`，位移 ≤4px | 会话列表、工具卡组、命令面板结果 | **P0** |
| d | **安静滚动条** | thumb `border: 3px transparent + background-clip: padding-box`，视觉宽 4px / 命中宽 10px，轨道透明 | 全局 | **P0** |
| e | **流式光标** | 2px 竖条 + `steps(1)` 硬切换 blink | assistant 流式输出末尾 | P1 |
| f | **双层焦点环** | `0 0 0 1px var(--bg-0), 0 0 0 4px var(--accent-ring)` | 全部可聚焦元素 | P1 |
| g | **噪点触感层** | feTurbulence SVG 平铺，`opacity .028`（dark）/ `.04`（light），`pointer-events: none` | body 覆盖层 | P1 |
| h | **饱和毛玻璃** | `backdrop-filter: blur(14px) saturate(1.5)`（纯 blur 发灰，saturate 找回色彩） | topbar、命令面板遮罩 | P1 |
| i | **图标纪律** | lucide 统一 16px 网格 / 1.5px 描边，禁止混用填充+线性 | 全局 | P1 |
| j | **4px 光学对齐** | 间距全部落 4 网格；图标与文本间恒定 8px；mono 标签补偿 +0.5px 字距 | 全局 | P2 |
| k | **空状态品牌位** | 渐变第二仪式位 + 产品哲学文案 | 会话空列表、无变更 | P2 |
| l | **完成音（可选）** | turn.completed 页面不可见时轻提示音（2026 趋势：声音进设计系统） | 通知系统 | P2 |

### 10.3 反清单——廉价感来源（出现即删除）

1. 数字宽度抖动（proportional nums 用于流式数据）
2. 系统 默认粗滚动条
3. 单层 2px 糊焦点环
4. 纯 blur 不饱和的毛玻璃（发灰）
5. 入场动画位移 >8px 或时长 >400ms（表演感）
6. hover 位移/缩放文本（只许边框与亮度变化；按钮按下 translateY(1px) 除外）
7. 大面积纯色无纹理（数字塑料感）
8. 图标混排（线性和填充同屏、多尺寸网格）
9. 加载动画与最终布局不符（骨架必须 1:1 占位）
10. 破坏 4px 网格的"差不多"间距

### 10.4 落地次序

P0 四项一个下午可全量落地（纯 CSS，零依赖）；P1 随重皮 P1 阶段（§8）同批交付；P2 视产品节奏。验收方式：双主题截图对比 + 流式读数录屏回放检查抖动。

---

## 11. 应用框架与扩展组件规格（v1.2 补章，对照设计稿 17–21 节）

### 11.1 应用框架 · App Shell

单一外壳承载全部功能，无顶部导航栏：

| 区域 | 尺寸 | 行为 |
|---|---|---|
| titlebar | 40px 固定 | logo / 会话标题 / 状态徽章 / seq 读数 / ⌘K 入口；双击折叠侧栏 |
| sidebar | 236–280px | 会话列表（唯一常驻导航）+ 底部模型/代理入口；⌘B 折叠 |
| main | flex（min 480） | Trajectory 事件流投影 + Composer 底部常驻；双 pane 对比时 50/50 |
| right panel | 296–420px | tabs：变更 / 预览 / 待办；Resizable、可关闭；预览地址按会话记忆 |
| composer | auto | 多行增长至 40vh；Esc 打断/清空 |

- **导航原则**：命令面板优先——⌘K 一个入口覆盖全部动作；菜单与右键是鼠标用户的等价物，两者同一交互内核（↑↓ 导航、⏎ 确认、Esc 关闭）。
- **外壳三态**：idle / running（titlebar 徽章 pulse）/ awaiting（审批弹窗浮层）。
- 外壳变体：默认单栏 / 双栏对比（复用 v0.3 双会话）/ 右面板预览。

### 11.2 菜单 · Menus

浮层统一规格：`bg-3` + `line-2` 描边 + `shadow-pop` + `r-lg`；条目 32px 高、图标 16px（text-3，hover 提亮）、快捷键 kbd 右对齐；分组用 `label-mono` + 1px 分隔线；**破坏性操作独立成组、danger 色**。打开动效 140ms fade + 2px rise。两类：

- 下拉菜单（titlebar ⚙ / 会话项 ⋯）：会话操作 + 显示切换 + 删除（danger 组）。
- 上下文菜单（trajectory 消息右键）：编辑重发 / 回滚到此 / 从此分叉 / 复制 / 引用。

### 11.3 表单与控件 · Forms

标签 12.5/500 置于上方；控件高 36（紧凑 30）；焦点双层环；错误 = danger 边 + mono 错误文案（如 `E409 · 同名会话已存在`）；帮助文案 text-3。清单：input（默认/聚焦/错误/禁用/前导图标/尾缀 kbd）、select（r-sm 自绘箭头）、textarea、checkbox（选中 accent 底 + 反色勾）、radio（accent 环点）、switch（34×20，on=accent）、分段控件（§6.5）。产品绑定示例：沙箱级别三档 radio 对应权限服务三级；"记住规则" checklist 直观展示审批 glob 规则。

### 11.4 数据展示 · Data & Navigation

- **表格**：表头 label-mono 10.5；数字列右对齐 mono + tabular；行 hover bg-1；状态点入列。示例：模型管理（上下文 k / 成本 $ /M / 可用性）。
- **树视图**：mono 12px、缩进参考线 1px line-1、目录/文件 13px 图标、命中项 accent-soft 底——用于 @ 引用补全与变更面板。
- **Tabs**：下划线式（on = accent 2px 底线），承载右面板三模式；计数用 mono 小标。
- **Callout**：左 2px 语义线 + 13px 图标，四变体（info/success/warn/danger），仅用于跨组件系统性提示。
- **Breadcrumb**：`设置 / 权限 / bash 规则`，crumb 图标 12px。

### 11.5 图标系统 · Iconography

自绘 16px 网格线条图标（lucide 规格），落地直接用 lucide-react、缺口自绘：

| 规则 | 值 |
|---|---|
| 网格 / viewBox | 16px 恒定（14/16/20/24 尺寸缩放，描边随尺寸光学缩放 1.31/1.5/1.88/2.25） |
| 描边 / 端点 | 1.5px 默认、圆帽、圆角连接、currentColor 单色 |
| 配对 | 图标+文字恒定 8px；纯图标按钮 30×30 必配 tooltip |
| 铁律 | 工具卡头部用 mono 文字名不用图标（读数是文字，动作是图标）；禁止填充/线性混排；禁止彩色图标（色彩即信号） |
| 清单 | 工具 12：read/write·edit/bash/glob/grep/todo/web/question/task/queue/耗时/模型；动作 12：发送/停止/回滚/分叉/置顶/编辑/复制/批准/拒绝/新建/删除/发送至；系统：主题/设置/用户/目录/文件/箭头/双 chevron |
| 迁移 | 现行占位字符（✎ ↺ ⑂ 📌 ⌕）→ SVG sprite（设计稿已全量替换） |
