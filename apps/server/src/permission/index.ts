/**
 * 权限服务：fail-closed，Loop 调用任何工具前必须经过此处裁决。
 *
 * 裁决顺序（先命中先生效）：
 *   1. deny 规则（敏感路径等，不可被会话规则覆盖）
 *   2. 用户会话期记住的规则（remember_rule）
 *   3. 工具声明的权限级别 + 沙箱等级
 *   4. 默认拒绝（fail-closed）
 */
import path from "node:path";
import type { SandboxLevel } from "@shuyi/types";
import type { ToolDefinition } from "../tools/index.js";

export type Verdict =
  | { kind: "allow"; reason: string }
  | { kind: "ask"; reason: string }
  | { kind: "deny"; reason: string };

export interface PermissionQuery {
  tool: ToolDefinition;
  args: Record<string, unknown>;
  cwd: string;
  sandboxLevel: SandboxLevel;
  /** 会话模式：plan 模式下写工具兜底拒绝（工具面过滤的双保险） */
  mode?: "plan" | "build";
}

/** 默认敏感路径：即使 sandbox=full 也只读保护中的「读限制」 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.env(\.|$)?/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /id_rsa|id_ed25519/,
];

export class PermissionService {
  /** 会话期记住的规则：key = `${tool}` 或 `${tool}:${path前缀}` */
  private rememberedRules = new Map<string, "allow" | "deny">();

  classify(query: PermissionQuery): Verdict {
    const { tool, args, cwd, sandboxLevel, mode } = query;

    // 0. Plan 模式兜底：非只读工具一律拒绝（工具面过滤的双保险）
    if (mode === "plan" && tool.permission !== "always-allow") {
      return { kind: "deny", reason: "Plan 模式只读：请先与用户确认方案再切回 Build 模式执行" };
    }
    const involved = (tool.involvedPaths?.(args) ?? []).map((p) =>
      path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p),
    );

    // 1. 敏感路径：写一律拒绝；读在 sandbox != full 时拒绝
    for (const p of involved) {
      if (SENSITIVE_PATTERNS.some((re) => re.test(p))) {
        const isWrite = tool.permission !== "always-allow";
        if (isWrite || sandboxLevel !== "full") {
          return { kind: "deny", reason: `涉及敏感路径 ${p}` };
        }
      }
    }

    // 2. 记住的规则
    const ruleKey = `${tool.name}`;
    const remembered = this.rememberedRules.get(ruleKey);
    if (remembered === "allow") return { kind: "allow", reason: `会话规则：允许 ${tool.name}` };
    if (remembered === "deny") return { kind: "deny", reason: `会话规则：拒绝 ${tool.name}` };

    // 3. 工具权限级别 + 沙箱
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
  }

  rememberRule(toolName: string, decision: "allow" | "deny"): void {
    this.rememberedRules.set(toolName, decision);
  }

  clearRules(): void {
    this.rememberedRules.clear();
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
