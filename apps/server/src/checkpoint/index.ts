/**
 * F1/F2 检查点快照（v0.4）：变更类工具执行前的文件影子拷贝。
 * - 位置：<cwd>/.agent/checkpoints/<sessionId>/<seq>/<b64url(absPath)>
 * - 每个快照目录带 meta.json {path, existed}；seq 取快照时刻的 last_seq（递增锚点）
 * - rewind(to_seq)：恢复所有 seq > to_seq 的快照（倒序，后到先恢），成功后删除目录
 * - 只增不改红线：事件日志不动；恢复快照是工作区文件操作
 */
import fs from "node:fs";
import path from "node:path";

export interface SnapshotMeta {
  path: string;
  existed: boolean;
}

function checkpointsRoot(cwd: string, sessionId: string): string {
  return path.join(cwd, ".agent", "checkpoints", sessionId);
}

function encodePath(absPath: string): string {
  return Buffer.from(absPath, "utf8").toString("base64url");
}

/** 变更类工具执行前快照目标文件。返回是否建立了快照（目标不存在也记录 existed=false） */
export function snapshotFile(cwd: string, sessionId: string, seq: number, absPath: string): void {
  try {
    // 防越界：仅快照 cwd 内的文件
    const rel = path.relative(cwd, absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return;
    const dir = path.join(checkpointsRoot(cwd, sessionId), String(seq));
    const file = path.join(dir, encodePath(absPath));
    if (fs.existsSync(file)) return; // 同一 seq 已快照过（保留最早的 before）
    fs.mkdirSync(dir, { recursive: true });
    const existed = fs.existsSync(absPath);
    if (existed) fs.copyFileSync(absPath, file);
    fs.writeFileSync(path.join(dir, `${encodePath(absPath)}.json`), JSON.stringify({ path: absPath, existed } satisfies SnapshotMeta));
  } catch {
    // 快照失败不阻塞工具执行（ rewind 能力降级而已）
  }
}

interface SnapshotEntry {
  seq: number;
  meta: SnapshotMeta;
  snapFile: string;
  metaFile: string;
  dir: string;
}

function listSnapshots(cwd: string, sessionId: string): SnapshotEntry[] {
  const root = checkpointsRoot(cwd, sessionId);
  if (!fs.existsSync(root)) return [];
  const out: SnapshotEntry[] = [];
  for (const seqDir of fs.readdirSync(root)) {
    const seq = Number(seqDir);
    if (!Number.isInteger(seq)) continue;
    const dir = path.join(root, seqDir);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as SnapshotMeta;
        out.push({
          seq,
          meta,
          snapFile: path.join(dir, f.slice(0, -5)),
          metaFile: path.join(dir, f),
          dir,
        });
      } catch {
        /* 坏 meta 跳过 */
      }
    }
  }
  return out.sort((a, b) => b.seq - a.seq); // 新→旧
}

/** 恢复 seq > toSeq 的全部快照（倒序）。返回恢复的文件路径列表 */
export function restoreAfter(cwd: string, sessionId: string, toSeq: number): string[] {
  const entries = listSnapshots(cwd, sessionId).filter((e) => e.seq > toSeq);
  const restored: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    try {
      if (!seen.has(e.meta.path)) {
        seen.add(e.meta.path);
        if (e.meta.existed && fs.existsSync(e.snapFile)) {
          fs.copyFileSync(e.snapFile, e.meta.path);
        } else if (!e.meta.existed && fs.existsSync(e.meta.path)) {
          fs.rmSync(e.meta.path); // 快照时不存在 → rewind 后删除
        }
        restored.push(e.meta.path);
      }
      fs.rmSync(e.snapFile, { force: true });
      fs.rmSync(e.metaFile, { force: true });
    } catch {
      /* 单文件失败继续其余 */
    }
  }
  // 清理空 seq 目录
  const root = checkpointsRoot(cwd, sessionId);
  for (const seqDir of fs.readdirSync(root).map(Number).filter((n) => n > toSeq)) {
    const dir = path.join(root, String(seqDir));
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  }
  return restored;
}

export interface FileChange {
  /** 相对 cwd 的路径 */
  path: string;
  before: string | null; // null = 文件原先不存在
  after: string | null; // null = 当前已删除
}

/** 变更面板数据：每个被快照文件的最早 before × 当前 after */
export function collectChanges(cwd: string, sessionId: string): FileChange[] {
  const entries = listSnapshots(cwd, sessionId);
  // 按 旧→新 遍历，首次出现即最早 before
  const oldest = new Map<string, SnapshotEntry>();
  for (const e of [...entries].reverse()) {
    if (!oldest.has(e.meta.path)) oldest.set(e.meta.path, e);
  }
  const changes: FileChange[] = [];
  for (const [absPath, e] of oldest) {
    const rel = path.relative(cwd, absPath) || absPath;
    let before: string | null = null;
    if (e.meta.existed && fs.existsSync(e.snapFile)) {
      try {
        before = fs.readFileSync(e.snapFile, "utf8");
      } catch {
        before = null;
      }
    }
    let after: string | null = null;
    if (fs.existsSync(absPath)) {
      try {
        after = fs.readFileSync(absPath, "utf8");
      } catch {
        after = null;
      }
    }
    if (before === after) continue; // 无净变化不展示
    changes.push({ path: rel, before, after });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** F2 审查：accept = 丢弃该文件全部快照；revert = 恢复最早 before（并丢弃快照） */
export function reviewChange(
  cwd: string,
  sessionId: string,
  relPath: string,
  action: "accept" | "revert",
): { ok: boolean; error?: string } {
  const absPath = path.resolve(cwd, relPath);
  const rel = path.relative(cwd, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, error: "路径越界" };
  const entries = listSnapshots(cwd, sessionId).filter((e) => e.meta.path === absPath);
  if (entries.length === 0) return { ok: false, error: "该文件无待审快照" };
  if (action === "revert") {
    const first = [...entries].reverse()[0]; // 旧→新取最早
    try {
      if (first.meta.existed && fs.existsSync(first.snapFile)) fs.copyFileSync(first.snapFile, absPath);
      else if (!first.meta.existed && fs.existsSync(absPath)) fs.rmSync(absPath);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  for (const e of entries) {
    try {
      fs.rmSync(e.snapFile, { force: true });
      fs.rmSync(e.metaFile, { force: true });
      if (fs.existsSync(e.dir) && fs.readdirSync(e.dir).length === 0) fs.rmdirSync(e.dir);
    } catch {
      /* ignore */
    }
  }
  return { ok: true };
}

/** 清理会话全部快照（会话删除/归档时可调；当前由 mergeWorktree 等场景自然遗留，量小） */
export function clearCheckpoints(cwd: string, sessionId: string): void {
  try {
    fs.rmSync(checkpointsRoot(cwd, sessionId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
