/**
 * 权限服务：fail-closed，Loop 调用任何工具前必须经过此处裁决。
 *
 * 规则模型（v0.3 / M3）：
 *   PermissionRule = { tool, pattern, patternType: glob|regex|prefix, decision, source }
 *   - glob：picomatch（大小写敏感；不支持否定模式 ! —— leading ! 按字面处理，保持简单）
 *   - 匹配目标：bash 提取完整命令行字符串；其他工具缺省用 involvedPaths 第一个
 *     （路径同时尝试「工作区相对路径」与「绝对路径」两个候选，便于书写规则）
 *   - 命令行匹配与路径匹配的 glob 语义不同：路径用 picomatch（* 不跨 /）；
 *     命令行中 / 只是普通字符，故 * 可跨 /（"rm -rf *" 能拦 "rm -rf /tmp/x"）。
 *
 * 裁决顺序（先命中先生效）：
 *   0. Plan 模式兜底：非只读工具一律拒绝（内置保护，不可被任何规则覆盖）
 *   1. deny_builtin：敏感路径（不可覆盖）
 *   2. agent：代理覆盖规则（M2 permissionOverride，仅当前代理生效）
 *   3. user_config：项目 .agent/permissions.json → 全局 ~/.agent/permissions.json（项目级优先）
 *   4. remembered：会话期记住的规则（含 glob 粒度）
 *   5. 工具声明权限级别 + 沙箱等级
 *   6. 默认拒绝（fail-closed）
 */
import path from "node:path";
import picomatch from "picomatch";
import type { SandboxLevel } from "@shuyi/types";
import type { ToolDefinition } from "../tools/index.js";
import { urlSafetyDenyReason } from "../tools/web.js";

export type Verdict =
  | { kind: "allow"; reason: string }
  | { kind: "ask"; reason: string }
  | { kind: "deny"; reason: string };

// ---------- 规则模型（M3） ----------

export type RuleSource = "deny_builtin" | "user_config" | "agent" | "remembered";

export interface PermissionRule {
  /** 作用的工具名；"*" 表示全部工具 */
  tool: string;
  /** 作用对象的匹配模式（路径或 bash 命令行） */
  pattern: string;
  patternType: "glob" | "regex" | "prefix";
  decision: "allow" | "ask" | "deny";
  source: RuleSource;
}

export interface PermissionQuery {
  tool: ToolDefinition;
  args: Record<string, unknown>;
  cwd: string;
  sandboxLevel: SandboxLevel;
  /** 会话模式：plan 模式下写工具兜底拒绝（工具面过滤的双保险） */
  mode?: "plan" | "build";
  /** M3：当前代理的覆盖规则（AgentDefinition.permissionOverride，仅本轮代理生效） */
  agentRules?: PermissionRule[];
}

/** 默认敏感路径：即使 sandbox=full 也只读保护中的「读限制」（deny_builtin，不可覆盖） */
const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.env(\.|$)?/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /id_rsa|id_ed25519/,
];

/** 从工具调用提取被匹配的候选字符串 */
export function matchTargets(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  cwd: string,
): string[] {
  // bash 类：提取完整命令行字符串（规则如 "rm -rf *"）
  if (typeof args.command === "string" && args.command) return [args.command];
  const involved = tool.involvedPaths?.(args) ?? [];
  const first = involved[0];
  if (!first) return [];
  const abs = path.isAbsolute(first) ? path.normalize(first) : path.resolve(cwd, first);
  const rel = path.relative(path.resolve(cwd), abs);
  // 同时尝试相对路径与绝对路径（规则写 "tests/**" 或 "/abs/**" 都能命中）
  return rel && !rel.startsWith("..") ? [rel, abs] : [abs];
}

/**
 * 命令行 glob → 正则：命令行里 / 无路径语义，* 应跨 / 匹配。
 * 大小写敏感；leading ! 按字面处理（与 nonegate 一致）。
 */
function commandGlobToRegex(glob: string): RegExp | null {
  try {
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`);
  } catch {
    return null;
  }
}

/** 单条规则是否命中任一候选（glob 大小写敏感；不支持否定模式 !） */
export function matchRule(rule: PermissionRule, targets: string[], isCommand = false): boolean {
  if (targets.length === 0) return false;
  switch (rule.patternType) {
    case "glob": {
      if (isCommand) {
        const re = commandGlobToRegex(rule.pattern);
        return re !== null && targets.some((t) => re.test(t));
      }
      const isMatch = picomatch(rule.pattern, { dot: true, nonegate: true });
      return targets.some((t) => isMatch(t));
    }
    case "regex": {
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern);
      } catch {
        return false; // 非法正则按不命中处理（fail-closed：不因配置错误而放行）
      }
      return targets.some((t) => re.test(t));
    }
    case "prefix":
      return targets.some((t) => t.startsWith(rule.pattern));
  }
}

function ruleVerdict(rule: PermissionRule): Verdict {
  const label = `规则[${rule.source}] ${rule.tool} ${rule.patternType}:${rule.pattern}`;
  switch (rule.decision) {
    case "allow":
      return { kind: "allow", reason: `${label} → 放行` };
    case "ask":
      return { kind: "ask", reason: `${label} → 需确认` };
    case "deny":
      return { kind: "deny", reason: `${label} → 拒绝` };
  }
}

/** 在规则列表中按序找第一条命中（tool 匹配 + pattern 匹配） */
export function applyRules(
  rules: PermissionRule[],
  toolName: string,
  targets: string[],
  isCommand = false,
): Verdict | null {
  for (const rule of rules) {
    if (rule.tool !== "*" && rule.tool !== toolName) continue;
    if (matchRule(rule, targets, isCommand)) return ruleVerdict(rule);
  }
  return null;
}

/** 校验未知来源的规则数组（M2 permissionOverride 为 unknown[]），非法项丢弃 */
export function sanitizeRules(raw: unknown[], source: RuleSource): PermissionRule[] {
  const out: PermissionRule[] = [];
  for (const r of raw) {
    const o = r as Partial<PermissionRule>;
    if (
      typeof o?.tool === "string" &&
      typeof o?.pattern === "string" &&
      (o.patternType === "glob" || o.patternType === "regex" || o.patternType === "prefix") &&
      (o.decision === "allow" || o.decision === "ask" || o.decision === "deny")
    ) {
      out.push({ tool: o.tool, pattern: o.pattern, patternType: o.patternType, decision: o.decision, source });
    }
  }
  return out;
}

// ---------- 权限服务 ----------

export class PermissionService {
  /** 会话期记住的工具级规则：key = 工具名 */
  private rememberedRules = new Map<string, "allow" | "deny">();
  /** 会话期记住的模式规则（M3：glob 粒度） */
  private rememberedPatterns: PermissionRule[] = [];
  /** user_config 规则（项目优先，由 SessionManager 每轮开始前注入） */
  private userConfigRules: PermissionRule[] = [];

  classify(query: PermissionQuery): Verdict {
    const { tool, args, cwd, sandboxLevel, mode } = query;

    // 0. Plan 模式兜底：非只读工具一律拒绝（内置保护，不可被任何规则覆盖）
    if (mode === "plan" && tool.permission !== "always-allow") {
      return { kind: "deny", reason: "Plan 模式只读：请先与用户确认方案再切回 Build 模式执行" };
    }
    const involved = (tool.involvedPaths?.(args) ?? []).map((p) =>
      path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p),
    );

    // 1. deny_builtin：敏感路径——写一律拒绝；读在 sandbox != full 时拒绝（不可覆盖）
    for (const p of involved) {
      if (SENSITIVE_PATTERNS.some((re) => re.test(p))) {
        const isWrite = tool.permission !== "always-allow";
        if (isWrite || sandboxLevel !== "full") {
          return { kind: "deny", reason: `涉及敏感路径 ${p}` };
        }
      }
    }

    // 1b. deny_builtin：SSRF 防护——出站 URL 仅允许公网 http/https（M4，不可覆盖）
    for (const u of tool.involvedUrls?.(args) ?? []) {
      const deny = urlSafetyDenyReason(u);
      if (deny) return { kind: "deny", reason: deny };
    }

    const targets = matchTargets(tool, args, cwd);
    const isCommand = typeof args.command === "string" && !!args.command;

    // 2. agent 代理覆盖规则（仅当前代理生效）
    if (query.agentRules?.length) {
      const hit = applyRules(query.agentRules, tool.name, targets, isCommand);
      if (hit) return hit;
    }

    // 3. user_config（项目 .agent/permissions.json → 全局 ~/.agent/permissions.json）
    if (this.userConfigRules.length) {
      const hit = applyRules(this.userConfigRules, tool.name, targets, isCommand);
      if (hit) return hit;
    }

    // 4. remembered（会话期记住：模式规则优先于工具级规则）
    {
      const hit = applyRules(this.rememberedPatterns, tool.name, targets, isCommand);
      if (hit) return hit;
    }
    const remembered = this.rememberedRules.get(tool.name);
    if (remembered === "allow") return { kind: "allow", reason: `会话规则：允许 ${tool.name}` };
    if (remembered === "deny") return { kind: "deny", reason: `会话规则：拒绝 ${tool.name}` };

    // 5. 工具权限级别 + 沙箱
    switch (tool.permission) {
      case "always-allow":
        return { kind: "allow", reason: "只读工具" };
      case "always-ask":
        if (sandboxLevel === "readonly") {
          return { kind: "deny", reason: "只读沙箱禁止执行命令" };
        }
        return { kind: "ask", reason: tool.riskSummary?.(args) ?? `${tool.name} 需要确认` };
      case "workspace-write": {
        if (sandboxLevel === "readonly") {
          return { kind: "deny", reason: "只读沙箱禁止写文件" };
        }
        if (sandboxLevel === "full") {
          return { kind: "allow", reason: "完全访问沙箱" };
        }
        const outside = involved.filter((p) => !isWithin(cwd, p));
        if (outside.length > 0) {
          return { kind: "deny", reason: `路径越出工作区: ${outside.join(", ")}` };
        }
        return { kind: "allow", reason: "工作区内写入" };
      }
    }

    // 6. 默认拒绝（fail-closed）
    return { kind: "deny", reason: `未命中任何放行规则：${tool.name}` };
  }

  rememberRule(toolName: string, decision: "allow" | "deny"): void {
    this.rememberedRules.set(toolName, decision);
  }

  /** M3：记住 glob 粒度规则（ApprovalDialog 高级选项） */
  rememberPatternRule(rule: Omit<PermissionRule, "source">): void {
    this.rememberedPatterns.push({ ...rule, source: "remembered" });
  }

  /** M3：注入 user_config 规则（项目优先序已排好；每轮开始前由 SessionManager 调用） */
  setUserConfigRules(rules: PermissionRule[]): void {
    this.userConfigRules = rules;
  }

  /** 快照：供 API 展示当前生效的 remembered 规则 */
  listRemembered(): PermissionRule[] {
    const toolLevel: PermissionRule[] = [...this.rememberedRules.entries()].map(([toolName, decision]) => ({
      tool: toolName,
      pattern: "*",
      patternType: "glob" as const,
      decision,
      source: "remembered" as const,
    }));
    return [...this.rememberedPatterns, ...toolLevel];
  }

  clearRules(): void {
    this.rememberedRules.clear();
    this.rememberedPatterns = [];
  }
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 供审批弹窗展示的风险摘要 */
export function describeRisk(tool: ToolDefinition, args: Record<string, unknown>): string {
  return tool.riskSummary?.(args) ?? `调用工具 ${tool.name}`;
}
