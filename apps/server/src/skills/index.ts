/**
 * P0-3：Skills 层（对齐 Claude Code Skills / OpenCode skill 工具 / CodeBuddy Skills）。
 *
 * 技能 = 一个目录，内含 SKILL.md：
 *   全局  ~/.agent/skills/<name>/SKILL.md
 *   项目  <cwd>/.agent/skills/<name>/SKILL.md   （同名覆盖全局）
 *
 * SKILL.md frontmatter（与代理/命令同一解析风格）：
 *   ---
 *   name: pdf-processing        （缺省取目录名）
 *   description: 提取 PDF 文本与表格
 *   ---
 *   正文 = 按需注入模型的操作指令。
 *
 * 渐进披露（progressive disclosure）：
 *   系统提示中只出现 name + description 清单；模型调用 skill 工具才把正文拉入上下文。
 *   技能目录里的其他文件（脚本、模板）由 read/bash 工具按正文指引使用。
 */
import fs from "node:fs";
import path from "node:path";

export interface SkillDefinition {
  name: string;
  description: string;
  /** SKILL.md 正文（操作指令） */
  body: string;
  /** 技能目录绝对路径（正文可能引用其中的脚本/模板） */
  dir: string;
  source: "global" | "project";
}

function parseSkillMd(file: string, source: SkillDefinition["source"]): SkillDefinition | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const dir = path.dirname(file);
  const meta: Record<string, string> = {};
  let body = raw;
  const m = raw.match(/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?\n?([\s\S]*)$/m);
  if (m) {
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].trim();
    }
    body = m[2];
  }
  const name = meta.name || path.basename(dir);
  if (!/^[\w][\w-]*$/.test(name)) return null;
  const trimmed = body.trim();
  if (!trimmed) return null;
  return { name, description: meta.description ?? "", body: trimmed, dir, source };
}

function scanSkillsDir(root: string, source: SkillDefinition["source"]): SkillDefinition[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillDefinition[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const def = parseSkillMd(path.join(root, e.name, "SKILL.md"), source);
    if (def) out.push(def);
  }
  return out;
}

/** 加载全部技能：全局 ← 项目（同名覆盖）。每次调用重新扫盘。 */
export function loadSkills(cwd: string, home: string = process.env.HOME ?? "/root"): SkillDefinition[] {
  const byName = new Map<string, SkillDefinition>();
  for (const def of scanSkillsDir(path.join(home, ".agent", "skills"), "global")) byName.set(def.name, def);
  for (const def of scanSkillsDir(path.join(cwd, ".agent", "skills"), "project")) byName.set(def.name, def);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 系统提示中的技能清单（只放名称+描述，正文由 skill 工具按需加载）。 */
export function skillsPromptSection(cwd: string, home?: string): string | undefined {
  const skills = loadSkills(cwd, home);
  if (!skills.length) return undefined;
  const lines = skills.map(
    (s) => `- ${s.name}${s.description ? `：${s.description}` : ""}（${s.source === "project" ? "项目" : "全局"}）`,
  );
  return [
    "## 可用技能",
    "以下技能可经 skill 工具按需加载完整操作指令；仅当任务与描述匹配时才加载：",
    ...lines,
  ].join("\n");
}
