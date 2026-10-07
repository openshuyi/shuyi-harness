/**
 * 极简 unified diff（LCS 行级，上下文 3 行）。变更面板展示用，
 * 不追求 git 级最优编辑脚本；大文件（>2000 行）退化为整文件替换块。
 */
export interface DiffResult {
	additions: number;
	deletions: number;
	text: string;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: LCS diff 动态规划 + 回溯，平移自 v0.3 成熟实现
export function unifiedDiff(
	pathLabel: string,
	before: string | null,
	after: string | null
): DiffResult {
	const oldLines = before === null ? [] : before.split("\n");
	const newLines = after === null ? [] : after.split("\n");
	if (oldLines.length > 2000 || newLines.length > 2000) {
		const text = `--- a/${pathLabel}\n+++ b/${pathLabel}\n（文件过大，省略逐行 diff：- ${oldLines.length} 行 / + ${newLines.length} 行）`;
		return { additions: newLines.length, deletions: oldLines.length, text };
	}
	// LCS DP
	const m = oldLines.length;
	const n = newLines.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array<number>(n + 1).fill(0)
	);
	for (let i = m - 1; i >= 0; i -= 1) {
		const row = dp[i];
		const below = dp[i + 1];
		if (!(row && below)) {
			continue;
		}
		for (let j = n - 1; j >= 0; j -= 1) {
			row[j] =
				oldLines[i] === newLines[j]
					? (below[j + 1] ?? 0) + 1
					: Math.max(below[j] ?? 0, row[j + 1] ?? 0);
		}
	}
	// 回溯生成操作序列
	interface Op {
		line: string;
		t: " " | "-" | "+";
	}
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		const oldLine = oldLines[i];
		const newLine = newLines[j];
		if (oldLine === undefined || newLine === undefined) {
			break;
		}
		if (oldLine === newLine) {
			ops.push({ line: oldLine, t: " " });
			i += 1;
			j += 1;
		} else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
			ops.push({ line: oldLine, t: "-" });
			i += 1;
		} else {
			ops.push({ line: newLine, t: "+" });
			j += 1;
		}
	}
	while (i < m) {
		i += 1;
		const line = oldLines[i];
		if (line === undefined) {
			break;
		}
		ops.push({ line, t: "-" });
	}
	while (j < n) {
		j += 1;
		const line = newLines[j];
		if (line === undefined) {
			break;
		}
		ops.push({ line, t: "+" });
	}

	// 折叠上下文（仅保留变更前后 3 行）
	const CTX = 3;
	const keep = new Array<boolean>(ops.length).fill(false);
	ops.forEach((op, idx) => {
		if (op.t !== " ") {
			for (
				let k = Math.max(0, idx - CTX);
				k <= Math.min(ops.length - 1, idx + CTX);
				k += 1
			) {
				keep[k] = true;
			}
		}
	});
	let additions = 0;
	let deletions = 0;
	const body: string[] = [];
	let skipping = false;
	ops.forEach((op, idx) => {
		if (!keep[idx]) {
			if (!skipping) {
				body.push(" @@ …… @@");
			}
			skipping = true;
			return;
		}
		skipping = false;
		if (op.t === "+") {
			additions += 1;
		}
		if (op.t === "-") {
			deletions += 1;
		}
		body.push(`${op.t}${op.line}`);
	});
	const header = `--- a/${pathLabel}\n+++ b/${pathLabel}`;
	return { additions, deletions, text: `${header}\n${body.join("\n")}` };
}
