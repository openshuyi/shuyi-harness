/**
 * 极简 unified diff（LCS 行级，上下文 3 行）。变更面板展示用，
 * 不追求 git 级最优编辑脚本；大文件（>2000 行）退化为整文件替换块。
 */
export interface DiffResult {
  text: string;
  additions: number;
  deletions: number;
}

export function unifiedDiff(pathLabel: string, before: string | null, after: string | null): DiffResult {
  const oldLines = before === null ? [] : before.split("\n");
  const newLines = after === null ? [] : after.split("\n");
  if (oldLines.length > 2000 || newLines.length > 2000) {
    const text = `--- a/${pathLabel}\n+++ b/${pathLabel}\n（文件过大，省略逐行 diff：- ${oldLines.length} 行 / + ${newLines.length} 行）`;
    return { text, additions: newLines.length, deletions: oldLines.length };
  }
  // LCS DP
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // 回溯生成操作序列
  type Op = { t: " " | "-" | "+"; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ t: " ", line: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: "-", line: oldLines[i] });
      i++;
    } else {
      ops.push({ t: "+", line: newLines[j] });
      j++;
    }
  }
  while (i < m) ops.push({ t: "-", line: oldLines[i++] });
  while (j < n) ops.push({ t: "+", line: newLines[j++] });

  // 折叠上下文（仅保留变更前后 3 行）
  const CTX = 3;
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.t !== " ") {
      for (let k = Math.max(0, idx - CTX); k <= Math.min(ops.length - 1, idx + CTX); k++) keep[k] = true;
    }
  });
  let additions = 0;
  let deletions = 0;
  const body: string[] = [];
  let skipping = false;
  ops.forEach((op, idx) => {
    if (!keep[idx]) {
      if (!skipping) body.push(" @@ …… @@");
      skipping = true;
      return;
    }
    skipping = false;
    if (op.t === "+") additions++;
    if (op.t === "-") deletions++;
    body.push(`${op.t}${op.line}`);
  });
  const header = `--- a/${pathLabel}\n+++ b/${pathLabel}`;
  return { text: `${header}\n${body.join("\n")}`, additions, deletions };
}
