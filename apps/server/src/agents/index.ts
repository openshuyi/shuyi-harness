/**
 * Agent 定义系统（P8-3，对齐 OpenCode 的声明式 agent 配置）：
 * Markdown + frontmatter 声明子代理的模型 / 工具面 / 系统提示。
 *
 * 加载顺序（后者覆盖前者，按 name 合并）：
 *   1. 内置：explore / title / summary
 *   2. 全局：~/.agent/agents/*.md
 *   3. 项目：<cwd>/.agent/agents/*.md
 *
 * 文件格式：
 *   ---
 *   name: explore
 *   description: 代码库探索子代理
 *   tools: readonly        # readonly | all | [read, grep]
 *   model: deepseek        # 可选：覆盖会话模型
 *   ---
 *   系统提示正文……
 */
import fs from "node:fs";
import path from "node:path";

export interface AgentDefinition {
  name: string;
  description: string;
  /** 工具面：readonly（只读工具）/ all（除 task 外全部）/ 显式名单 */
  tools: "readonly" | "all" | string[];
  /** 覆盖会话模型（模型注册表中的 id）；缺省用会话模型 */
  model?: string;
  /** 系统提示（frontmatter 之后的正文） */
  system: string;
  source: "builtin" | "user" | "project";
}

// ---------- 内置代理 ----------

const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: "explore",
    description: "代码库探索子代理：大范围搜索与阅读，只带回浓缩结论",
    tools: "readonly",
    system:
      "你是一个代码库探索子代理。独立完成下面的任务，直接给出浓缩的最终结论（不超过 800 字），不要复述过程。",
    source: "builtin",
  },
  {
    name: "title",
    description: "会话标题生成：首轮结束后根据用户请求生成简短标题",
    tools: [],
    system:
      "你是会话标题生成器。根据用户的请求，生成一个不超过 15 个字的简短中文标题。只输出标题本身，不要解释、不要引号、不要标点结尾。",
    source: "builtin",
  },
  {
    name: "summary",
    description: "对话摘要：为上下文压缩生成结构化摘要（预留）",
    tools: [],
    system:
      "你是对话摘要器。把冗长的对话历史压缩为结构化摘要，保留：会话意图、修改过的文件、关键决策、未完成的目标、下一步。",
    source: "builtin",
  },
];

// ---------- 极简 frontmatter 解析（无 yaml 依赖：key: value / [a, b]） ----------

export function parseAgentMarkdown(raw: string, source: AgentDefinition["source"]): AgentDefinition | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  if (!meta.name) return null;
  const system = m[2].trim();
  if (!system) return null;

  let tools: AgentDefinition["tools"] = "readonly";
  const rawTools = meta.tools?.trim();
  if (rawTools === "all") tools = "all";
  else if (rawTools === "readonly" || rawTools === undefined || rawTools === "") tools = "readonly";
  else if (rawTools === "[]" || rawTools === "none") tools = [];
  else {
    const inner = rawTools.replace(/^\[/, "").replace(/\]$/, "");
    tools = inner.split(",").map((s) => s.trim()).filter(Boolean);
  }

  return {
    name: meta.name,
    description: meta.description ?? "",
    tools,
    model: meta.model || undefined,
    system,
    source,
  };
}

// ---------- 注册表 ----------

export class AgentRegistry {
  constructor(private homeDir: string = process.env.HOME ?? "/root") {}

  /** 合并后的代理列表：内置 ← 全局 ← 项目（同名后者覆盖） */
  list(cwd?: string): AgentDefinition[] {
    const merged = new Map<string, AgentDefinition>();
    for (const a of BUILTIN_AGENTS) merged.set(a.name, a);
    for (const a of this.loadDir(path.join(this.homeDir, ".agent", "agents"), "user")) {
      merged.set(a.name, a);
    }
    if (cwd) {
      for (const a of this.loadDir(path.join(cwd, ".agent", "agents"), "project")) {
        merged.set(a.name, a);
      }
    }
    return [...merged.values()];
  }

  get(name: string, cwd?: string): AgentDefinition | undefined {
    return this.list(cwd).find((a) => a.name === name);
  }

  private loadDir(dir: string, source: AgentDefinition["source"]): AgentDefinition[] {
    const out: AgentDefinition[] = [];
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      return out; // 目录不存在
    }
    for (const f of files) {
      try {
        const parsed = parseAgentMarkdown(fs.readFileSync(path.join(dir, f), "utf-8"), source);
        if (parsed) out.push(parsed);
        else console.warn(`[agents] 忽略无法解析的代理定义: ${path.join(dir, f)}`);
      } catch {
        // 单个文件损坏不影响其他
      }
    }
    return out;
  }
}
