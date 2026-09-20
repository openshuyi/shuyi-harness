/**
 * Agent 定义系统（P8-3 + v0.3/M2 升级）：
 * 代理 =「prompt + 模型 + 权限（M3 接入）」可配的运行时实体，
 * build/plan 不再是 Loop 硬编码模式，而是内置代理定义。
 *
 * 加载顺序（后者覆盖前者，按 name 合并；内置永远存在、不可覆盖）：
 *   1. 内置：build / plan / explore / title / summary
 *   2. 全局：~/.agent/agents/*.md（source: user）
 *   3. 项目：<cwd>/.agent/agents/*.md（source: project）
 *   4. 运行时：API 动态添加，持久化 ~/.agent/agents.json（source: runtime）
 *
 * 覆盖规则（M2 验收）：同名 runtime > project > user > builtin；
 * 但 builtin 不可被任何来源覆盖——md 文件与内置同名时忽略该文件并提示改名，
 * API 写入与内置同名直接拒绝。
 *
 * Markdown 文件格式：
 *   ---
 *   name: explore
 *   description: 代码库探索子代理
 *   tools: readonly        # readonly | all | none | [read, grep]
 *   model: deepseek        # 可选：覆盖会话模型
 *   mode: plan             # 可选：plan | build（plan 等价旧 Plan 模式）
 *   ---
 *   系统提示正文……
 */
import fs from "node:fs";
import path from "node:path";

export interface AgentDefinition {
  name: string;
  description: string;
  /** 工具面：readonly（只读工具）/ all（全量）/ 显式白名单 */
  tools: "readonly" | "all" | string[];
  /** 覆盖会话模型（模型注册表中的 id）；缺省继承会话模型 */
  model?: string;
  /** 系统提示（设计文档中的 prompt 字段；markdown 正文） */
  system: string;
  source: "builtin" | "user" | "project" | "runtime";
  /** M2：代理的模式语义——plan 代理等价旧 plan 模式（工具面双保险 + 权限兜底） */
  modeDefault?: "plan" | "build";
  /** M3 预留：按代理覆盖的权限规则（M3 接入裁决链，此处只透传存储） */
  permissionOverride?: unknown[];
}

// ---------- 内置代理 ----------

const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: "build",
    description: "默认构建代理：直接动手完成任务（等价旧 Build 模式）",
    tools: "all",
    system:
      "你是默认构建代理：直接动手完成任务。可以修改文件与执行命令，但修改前先说明意图。",
    source: "builtin",
    modeDefault: "build",
  },
  {
    name: "plan",
    description: "计划代理：只读分析，输出分步实施计划（等价旧 Plan 模式）",
    tools: "readonly",
    system:
      "你是计划代理：只读分析，给出分步实施计划。不修改任何文件，不执行任何命令。",
    source: "builtin",
    modeDefault: "plan",
  },
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

const BUILTIN_NAMES = new Set(BUILTIN_AGENTS.map((a) => a.name));

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

  // M2：mode 字段（plan 代理等价旧 plan 模式）
  const rawMode = meta.mode?.trim();
  const modeDefault = rawMode === "plan" || rawMode === "build" ? rawMode : undefined;

  // M3 预留：permission 字段（JSON 数组，M3 定义规则模型并接入裁决链）
  let permissionOverride: unknown[] | undefined;
  if (meta.permission?.trim()) {
    try {
      const parsed = JSON.parse(meta.permission) as unknown;
      if (Array.isArray(parsed)) permissionOverride = parsed;
    } catch {
      // 无法解析的 permission 字段忽略（M3 落地前不阻塞加载）
    }
  }

  return {
    name: meta.name,
    description: meta.description ?? "",
    tools,
    model: meta.model || undefined,
    system,
    source,
    modeDefault,
    permissionOverride,
  };
}

// ---------- 注册表 ----------

export class AgentRegistry {
  private runtimeFile: string;

  constructor(private homeDir: string = process.env.HOME ?? "/root") {
    this.runtimeFile = path.join(this.homeDir, ".agent", "agents.json");
  }

  /**
   * 合并后的代理列表：内置 ← 全局 ← 项目 ← 运行时。
   * 内置不可覆盖：同名 md / runtime 条目被忽略并提示（upsert 时已拒绝，双保险）。
   */
  list(cwd?: string): AgentDefinition[] {
    const merged = new Map<string, AgentDefinition>();
    for (const a of BUILTIN_AGENTS) merged.set(a.name, a);
    const overlay = (defs: AgentDefinition[], origin: string) => {
      for (const a of defs) {
        if (BUILTIN_NAMES.has(a.name)) {
          console.error(
            `[agents] ${origin}代理 "${a.name}" 与内置代理同名，已忽略——内置代理不可覆盖，请改名`,
          );
          continue;
        }
        merged.set(a.name, a);
      }
    };
    overlay(this.loadDir(path.join(this.homeDir, ".agent", "agents"), "user"), "全局");
    if (cwd) overlay(this.loadDir(path.join(cwd, ".agent", "agents"), "project"), "项目");
    overlay(this.loadRuntime(), "运行时");
    return [...merged.values()];
  }

  get(name: string, cwd?: string): AgentDefinition | undefined {
    return this.list(cwd).find((a) => a.name === name);
  }

  /** M2：API 动态添加/更新代理（source=runtime，持久化 ~/.agent/agents.json） */
  upsertRuntime(def: Omit<AgentDefinition, "source">): AgentDefinition {
    if (!def.name?.trim()) throw new Error("代理 name 不能为空");
    if (!def.system?.trim()) throw new Error("代理系统提示（system/prompt）不能为空");
    if (BUILTIN_NAMES.has(def.name)) {
      throw new Error(`"${def.name}" 是内置代理名，内置代理不可覆盖，请改名`);
    }
    const entries = this.loadRuntime().filter((a) => a.name !== def.name);
    const full: AgentDefinition = { ...def, name: def.name.trim(), source: "runtime" };
    entries.push(full);
    this.saveRuntime(entries);
    return full;
  }

  /** M2：删除运行时代理（builtin/project/user 来源只读） */
  removeRuntime(name: string): void {
    const entries = this.loadRuntime();
    const found = entries.find((a) => a.name === name);
    if (!found) {
      throw new Error(
        BUILTIN_NAMES.has(name)
          ? `"${name}" 是内置代理，只读不可删除`
          : `运行时代理不存在: ${name}（project/user 来源的代理请删除对应 .md 文件）`,
      );
    }
    this.saveRuntime(entries.filter((a) => a.name !== name));
  }

  private loadRuntime(): AgentDefinition[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.runtimeFile, "utf-8")) as unknown;
      const arr = Array.isArray(raw) ? raw : ((raw as { agents?: unknown[] }).agents ?? []);
      return (arr as Partial<AgentDefinition>[])
        .filter((d) => d && typeof d.name === "string" && typeof d.system === "string")
        .map((d) => ({
          name: d.name!,
          description: d.description ?? "",
          tools: normalizeTools(d.tools),
          model: d.model,
          system: d.system!,
          source: "runtime" as const,
          modeDefault: d.modeDefault === "plan" || d.modeDefault === "build" ? d.modeDefault : undefined,
          permissionOverride: Array.isArray(d.permissionOverride) ? d.permissionOverride : undefined,
        }));
    } catch {
      return []; // 文件不存在或损坏：静默降级为空
    }
  }

  private saveRuntime(entries: AgentDefinition[]): void {
    fs.mkdirSync(path.dirname(this.runtimeFile), { recursive: true });
    fs.writeFileSync(this.runtimeFile, JSON.stringify(entries, null, 2), "utf-8");
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

function normalizeTools(raw: unknown): AgentDefinition["tools"] {
  if (raw === "readonly" || raw === "all") return raw;
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string");
  return "readonly";
}
