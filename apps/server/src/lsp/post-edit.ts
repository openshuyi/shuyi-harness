/**
 * 编辑后诊断折回（OpenCode 同款机制）：
 * write/edit 成功后自动跑 LSP 诊断，结果拼入工具结果，
 * 模型当轮即可看到自己刚写出的类型错误并修复——诊断是推送而非拉取。
 */
import { lspFor, isTsLike, type Diagnostic } from "./client.js";

/** 对刚写入的文件跑诊断，返回可拼入工具结果的文本；不可用/无诊断返回 null */
export async function postEditDiagnostics(
  cwd: string,
  files: string[],
  waitMs = 2500,
): Promise<string | null> {
  const tsFiles = files.filter(isTsLike);
  if (tsFiles.length === 0) return null;
  const client = lspFor(cwd);
  if (!client) return null;

  const sections: string[] = [];
  for (const file of tsFiles.slice(0, 5)) {
    // 上限 5 个文件，防批量写场景拖慢轮次
    let diags: Diagnostic[] | null = null;
    try {
      diags = await client.diagnostics(file, waitMs);
    } catch {
      continue; // 诊断失败静默降级，不影响工具结果
    }
    if (!diags || diags.length === 0) continue;
    const errors = diags.filter((d) => d.severity === "error");
    const show = errors.length > 0 ? errors : diags; // 有 error 只看 error
    const lines = show
      .slice(0, 10)
      .map((d) => `  ${d.severity.toUpperCase()} ${d.line}:${d.character} ${d.message}${d.source ? ` [${d.source}]` : ""}`);
    sections.push(`${file}: ${show.length} 条${errors.length > 0 ? "错误" : "诊断"}\n${lines.join("\n")}`);
  }

  if (sections.length === 0) return null;
  return `\n\n[LSP 诊断（编辑后自动检查）]\n${sections.join("\n")}\n如有错误请立即修复。`;
}
