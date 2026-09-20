/**
 * 项目级配置（P8-5，对齐 OpenCode 的 opencode.json 分层配置）：
 *   全局 ~/.agent/shuyi.json  ←  项目 <cwd>/shuyi.json（项目覆盖全局）
 *   环境变量仍为最高优先级（模型清单见 model/index.ts）。
 *
 * 配置形状（所有字段可选）：
 *   {
 *     "model": "deepseek",                  // 新会话默认模型（注册表中的 id）
 *     "instructions": "……" 或 ["……", "……"],  // 注入系统提示的项目指令
 *     "permissions": {                      // 会话开始时预置的权限规则
 *       "allow": ["read", "glob"],
 *       "deny":  ["bash"]
 *     },
 *     "auto_title": false                   // 关闭自动标题（默认开启）
 *   }
 */
import fs from "node:fs";
import path from "node:path";

export interface ProjectConfig {
  model?: string;
  instructions?: string;
  permissions?: { allow?: string[]; deny?: string[] };
  auto_title?: boolean;
  /** P1-5：是否启用 .agent/hooks/ 下的可执行 hook（默认 false，fail-closed） */
  hooks?: boolean;
}

interface RawConfig {
  model?: unknown;
  instructions?: unknown;
  permissions?: unknown;
  auto_title?: unknown;
  hooks?: unknown;
}

function readConfigFile(file: string): RawConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as RawConfig) : null;
  } catch {
    return null; // 不存在或损坏均视为无配置
  }
}

function normalizeInstructions(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (Array.isArray(raw)) {
    const parts = raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
    if (parts.length) return parts.map((s) => s.trim()).join("\n");
  }
  return undefined;
}

function normalizePermissions(raw: unknown): ProjectConfig["permissions"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { allow?: unknown; deny?: unknown };
  const pick = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined;
  const allow = pick(r.allow);
  const deny = pick(r.deny);
  return allow || deny ? { allow, deny } : undefined;
}

/**
 * P0-4b：AGENTS.md 自动加载（对齐 Codex/OpenCode 的仓库级代理指令约定）。
 * 读取 <cwd>/AGENTS.md 与 ~/.agent/AGENTS.md，拼接后注入系统提示；
 * 单文件上限 32KB（防爆上下文），不存在/读取失败静默跳过。
 */
const AGENTS_MD_MAX = 32 * 1024;

function readAgentsMd(file: string): string | undefined {
  try {
    const text = fs.readFileSync(file, "utf-8").trim();
    if (!text) return undefined;
    return text.length > AGENTS_MD_MAX ? `${text.slice(0, AGENTS_MD_MAX)}\n… [AGENTS.md 过长已截断]` : text;
  } catch {
    return undefined;
  }
}

export function loadAgentsMd(cwd: string, home: string = process.env.HOME ?? "/root"): string | undefined {
  const parts = [
    { label: "AGENTS.md（项目根）", text: readAgentsMd(path.join(cwd, "AGENTS.md")) },
    { label: "AGENTS.md（全局）", text: readAgentsMd(path.join(home, ".agent", "AGENTS.md")) },
  ].filter((p) => p.text);
  if (!parts.length) return undefined;
  return parts.map((p) => `## ${p.label}\n${p.text}`).join("\n\n");
}

/** 加载并合并配置：全局 ← 项目（项目字段覆盖；instructions 拼接；permissions 数组合并） */
export function loadProjectConfig(cwd: string, home: string = process.env.HOME ?? "/root"): ProjectConfig {
  const global = readConfigFile(path.join(home, ".agent", "shuyi.json")) ?? {};
  const project = readConfigFile(path.join(cwd, "shuyi.json")) ?? {};

  const instructions = [
    normalizeInstructions(global.instructions),
    normalizeInstructions(project.instructions),
  ]
    .filter(Boolean)
    .join("\n\n") || undefined;

  const gPerm = normalizePermissions(global.permissions);
  const pPerm = normalizePermissions(project.permissions);
  const permissions =
    gPerm || pPerm
      ? {
          allow: [...(gPerm?.allow ?? []), ...(pPerm?.allow ?? [])],
          deny: [...(gPerm?.deny ?? []), ...(pPerm?.deny ?? [])],
        }
      : undefined;

  return {
    model: typeof project.model === "string" ? project.model : typeof global.model === "string" ? global.model : undefined,
    instructions,
    permissions,
    auto_title:
      typeof project.auto_title === "boolean"
        ? project.auto_title
        : typeof global.auto_title === "boolean"
          ? global.auto_title
          : undefined,
    // P1-5：项目或全局任一层显式开启即生效（开启动作本身需要用户显式书写，满足 fail-closed）
    hooks:
      typeof project.hooks === "boolean"
        ? project.hooks
        : typeof global.hooks === "boolean"
          ? global.hooks
          : undefined,
  };
}
