/**
 * P0-4a：自定义斜杠命令（对齐 OpenCode /commands、Claude Code 自定义命令）。
 *
 * 命令 = 一个 markdown 文件，文件名即命令名：
 *   全局  ~/.agent/commands/<name>.md
 *   项目  <cwd>/.agent/commands/<name>.md   （同名覆盖全局）
 *
 * 文件支持极简 frontmatter（与代理定义同一解析风格）：
 *   ---
 *   description: 代码评审
 *   ---
 *   请评审以下变更，重点关注正确性与边界条件：$ARGUMENTS
 *
 * 正文中的 $ARGUMENTS 被命令行参数替换；无占位符时参数追加在正文末尾。
 * 用户输入 "/review src/" → 服务端展开模板后作为本轮用户消息。
 * 未匹配的 "/xxx" 按普通文本处理（可能是路径或排版）。
 */
import fs from "node:fs";
import path from "node:path";

export interface CommandDefinition {
  name: string;
  description: string;
  template: string;
  source: "global" | "project";
}

function parseCommandFile(file: string, source: CommandDefinition["source"]): CommandDefinition | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const name = path.basename(file).replace(/\.md$/i, "");
  if (!/^[\w][\w-]*$/.test(name)) return null;

  let description = "";
  let body = raw;
  // frontmatter：起始 --- 行到下一个行首 ---（/m 使 ^ 匹配行首，兼容空 meta 块）
  const m = raw.match(/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?\n?([\s\S]*)$/m);
  if (m) {
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
      if (kv && kv[1] === "description") description = kv[2].trim();
    }
    body = m[2];
  }
  const template = body.trim();
  if (!template) return null;
  return { name, description, template, source };
}

function scanDir(dir: string, source: CommandDefinition["source"]): CommandDefinition[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
  } catch {
    return [];
  }
  const out: CommandDefinition[] = [];
  for (const f of files) {
    const def = parseCommandFile(path.join(dir, f), source);
    if (def) out.push(def);
  }
  return out;
}

/** 加载全部命令：全局 ← 项目（项目同名覆盖）。每次调用重新扫盘（文件少，保证新鲜）。 */
export function loadCommands(cwd: string, home: string = process.env.HOME ?? "/root"): CommandDefinition[] {
  const byName = new Map<string, CommandDefinition>();
  for (const def of scanDir(path.join(home, ".agent", "commands"), "global")) byName.set(def.name, def);
  for (const def of scanDir(path.join(cwd, ".agent", "commands"), "project")) byName.set(def.name, def);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 匹配 "/name args" 形式的输入；不匹配返回 null。 */
export function matchCommandInput(text: string): { name: string; args: string } | null {
  const m = text.trim().match(/^\/([\w][\w-]*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { name: m[1], args: (m[2] ?? "").trim() };
}

/** 展开命令模板：$ARGUMENTS 替换为参数；无占位符时参数追加末尾。 */
export function expandCommand(def: CommandDefinition, args: string): string {
  if (def.template.includes("$ARGUMENTS")) {
    return def.template.replaceAll("$ARGUMENTS", args);
  }
  return args ? `${def.template}\n\n${args}` : def.template;
}

/**
 * 尝试把用户输入展开为命令模板。
 * 命中返回 { def, expanded }；未命中/不是命令返回 null（调用方按原文处理）。
 */
export function tryExpandCommandInput(
  text: string,
  cwd: string,
  home?: string,
): { def: CommandDefinition; expanded: string } | null {
  const m = matchCommandInput(text);
  if (!m) return null;
  const def = loadCommands(cwd, home).find((d) => d.name === m.name);
  if (!def) return null;
  return { def, expanded: expandCommand(def, m.args) };
}
