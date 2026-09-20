/**
 * 权限规则配置文件加载（M3）：
 * - 全局 ~/.agent/permissions.json；项目 <cwd>/.agent/permissions.json
 * - 支持两种形态：
 *   1) 速记映射 { "tests/**": "allow", "rm -rf *": "deny" }（tool "*" 自动匹配，含 glob 字符→glob，否则→prefix）
 *   2) 完整规则 { "rules": [{ tool, pattern, patternType?, decision }] } 或直接数组
 * - 解析失败/文件缺失 → 空列表（fail-closed 不受影响：规则只可能放宽 ask→allow，
 *   但 deny_builtin 与 sandbox 仍在其后把关；缺文件时行为与之前一致）。
 */
import fs from "node:fs";
import path from "node:path";
import type { PermissionRule } from "./index";

const DECISIONS = new Set(["allow", "ask", "deny"]);
const PATTERN_TYPES = new Set(["glob", "regex", "prefix"]);
const GLOB_CHARS = /[*?{}[\]]/;

function autoPatternType(pattern: string): "glob" | "prefix" {
  return GLOB_CHARS.test(pattern) ? "glob" : "prefix";
}

function normalizeRule(raw: unknown): PermissionRule | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.pattern !== "string" || !o.pattern) return null;
  if (typeof o.decision !== "string" || !DECISIONS.has(o.decision)) return null;
  const tool = typeof o.tool === "string" && o.tool ? o.tool : "*";
  let patternType: PermissionRule["patternType"] = autoPatternType(o.pattern);
  if (typeof o.patternType === "string" && PATTERN_TYPES.has(o.patternType)) {
    patternType = o.patternType as PermissionRule["patternType"];
  }
  return {
    tool,
    pattern: o.pattern,
    patternType,
    decision: o.decision as PermissionRule["decision"],
    source: "user_config",
  };
}

/** 解析单文件内容为规则列表（source 固定 user_config）。 */
export function parsePermissionConfig(raw: unknown): PermissionRule[] {
  const out: PermissionRule[] = [];
  if (!raw || typeof raw !== "object") return out;
  // 完整形态：{ rules: [...] } 或直接数组
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as Record<string, unknown>).rules) ? ((raw as Record<string, unknown>).rules as unknown[]) : null;
  if (list) {
    for (const item of list) {
      const r = normalizeRule(item);
      if (r) out.push(r);
    }
    return out;
  }
  // 速记映射：{ "pattern": "allow" | "ask" | "deny" }
  for (const [pattern, decision] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof decision !== "string" || !DECISIONS.has(decision)) continue;
    if (!pattern) continue;
    out.push({
      tool: "*",
      pattern,
      patternType: autoPatternType(pattern),
      decision: decision as PermissionRule["decision"],
      source: "user_config",
    });
  }
  return out;
}

function loadFile(file: string): PermissionRule[] {
  try {
    if (!fs.existsSync(file)) return [];
    return parsePermissionConfig(JSON.parse(fs.readFileSync(file, "utf-8")));
  } catch {
    return [];
  }
}

export interface UserConfigRules {
  /** 项目级规则（排在前，优先命中） */
  project: PermissionRule[];
  /** 全局规则 */
  global: PermissionRule[];
}

/** 加载项目级 + 全局权限规则。 */
export function loadPermissionRules(cwd: string, home?: string): UserConfigRules {
  const projectFile = path.join(cwd, ".agent", "permissions.json");
  const globalFile = path.join(home ?? process.env.HOME ?? cwd, ".agent", "permissions.json");
  return { project: loadFile(projectFile), global: loadFile(globalFile) };
}

/** 追加一条规则到指定配置文件（完整规则形态写入 rules 数组）。 */
export function appendPermissionRule(file: string, rule: Omit<PermissionRule, "source">): void {
  let parsed: unknown = { rules: [] };
  try {
    if (fs.existsSync(file)) parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    parsed = { rules: [] };
  }
  // 旧格式（速记映射）→ 升级为 { rules } 形态，保留原速记条目
  let rules: unknown[];
  if (Array.isArray(parsed)) {
    rules = parsed;
  } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).rules)) {
    rules = (parsed as Record<string, unknown>).rules as unknown[];
  } else if (parsed && typeof parsed === "object") {
    rules = parsePermissionConfig(parsed); // 速记 → 完整条目
  } else {
    rules = [];
  }
  rules.push({ tool: rule.tool, pattern: rule.pattern, patternType: rule.patternType, decision: rule.decision });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ rules }, null, 2));
}

/** 按索引删除指定配置文件中的一条规则（索引基于 parsePermissionConfig 展开后的列表）。 */
export function deletePermissionRule(file: string, index: number): boolean {
  try {
    if (!fs.existsSync(file)) return false;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    const expanded = parsePermissionConfig(parsed);
    if (index < 0 || index >= expanded.length) return false;
    expanded.splice(index, 1);
    fs.writeFileSync(
      file,
      JSON.stringify(
        { rules: expanded.map((r) => ({ tool: r.tool, pattern: r.pattern, patternType: r.patternType, decision: r.decision })) },
        null,
        2,
      ),
    );
    return true;
  } catch {
    return false;
  }
}
