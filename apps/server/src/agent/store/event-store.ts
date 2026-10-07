/**
 * 存储层：EventStore 接口 + SQLite 实现（@libsql/client 驱动）。
 *
 * 不变量（见《事件模型设计》）：
 * - append-only：事件只追加，永不修改
 * - seq 会话内单调递增、无空洞（事务内分配）
 * - 所有读写必须经过此接口（团队版存储挂钩）
 *
 * 驱动说明：libsql 本地 file: 库即 SQLite；异步事务保证 seq 分配原子性。
 * 构造函数保持同步签名，初始化（PRAGMA + 建表）在内部 ready promise 中完成，
 * 每个公开方法先 await ready。
 */
import { createClient, type Client, type InValue, type Row } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AgentEvent,
  EventInput,
  EventType,
  SessionRecord,
  SessionStatus,
} from "@shuyi-harness/types";
import type { EventBus } from "../bus/index.js";

export interface SearchHit {
  session_id: string;
  session_title: string;
  seq: number;
  type: string;
  snippet: string;
  ts: number;
}

export interface EventStore {
  /** 全文搜索：在消息与工具结果 payload 中匹配，返回命中摘要（P4） */
  search(query: string, limit?: number): Promise<SearchHit[]>;

  append<T extends EventType>(input: EventInput<T>): Promise<AgentEvent<T>>;
  readSince(sessionId: string, afterSeq: number): Promise<AgentEvent[]>;
  readRange(sessionId: string, fromSeq: number, toSeq: number): Promise<AgentEvent[]>;
  latestSeq(sessionId: string): Promise<number>;
  findLast(sessionId: string, type: EventType): Promise<AgentEvent | null>;

  createSession(record: Omit<SessionRecord, "status" | "last_seq">): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  listSessions(includeArchived?: boolean): Promise<SessionRecord[]>;
  setSessionStatus(sessionId: string, status: SessionStatus): Promise<void>;
  updateSessionConfig(
    sessionId: string,
    patch: Partial<Pick<SessionRecord, "mode" | "model" | "sandbox_level" | "title" | "archived">>,
  ): Promise<void>;
  copyEventsTo(targetSessionId: string, sourceSessionId: string, fromSeq: number, toSeq: number): Promise<void>;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id   TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    cwd          TEXT NOT NULL,
    mode         TEXT NOT NULL,
    model        TEXT NOT NULL,
    sandbox_level TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    archived     INTEGER NOT NULL DEFAULT 0,
    forked_from  TEXT,
    caller_identity TEXT NOT NULL DEFAULT 'local-user'
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    session_id    TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    event_id      TEXT NOT NULL UNIQUE,
    ts            INTEGER NOT NULL,
    type          TEXT NOT NULL,
    actor         TEXT NOT NULL,
    turn_id       TEXT,
    causation_id  TEXT,
    payload       TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS idx_events_type ON events(session_id, type, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_events_turn ON events(session_id, turn_id)`,
];

export class SqliteEventStore implements EventStore {
  private db: Client;
  private ready: Promise<void>;

  constructor(
    dbPath: string,
    private bus: EventBus,
  ) {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const url = dbPath === ":memory:" ? ":memory:" : pathToFileURL(path.resolve(dbPath)).href;
    this.db = createClient({ url });
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await this.db.execute("PRAGMA journal_mode = WAL;");
    await this.db.execute("PRAGMA synchronous = NORMAL;");
    await this.db.batch(SCHEMA_STATEMENTS, "write");
  }

  private rowToEvent(row: Row): AgentEvent {
    return {
      event_id: String(row.event_id),
      session_id: String(row.session_id),
      seq: Number(row.seq),
      ts: Number(row.ts),
      type: String(row.type) as EventType,
      actor: String(row.actor) as AgentEvent["actor"],
      turn_id: row.turn_id === null ? null : String(row.turn_id),
      causation_id: row.causation_id === null ? null : String(row.causation_id),
      payload: JSON.parse(String(row.payload)),
    } as AgentEvent;
  }

  async append<T extends EventType>(input: EventInput<T>): Promise<AgentEvent<T>> {
    await this.ready;
    // seq 分配与插入必须在同一事务内，保证单调无空洞
    const tx = await this.db.transaction("write");
    let full: AgentEvent<T>;
    try {
      const rs = await tx.execute({
        sql: "SELECT MAX(seq) AS max_seq FROM events WHERE session_id = ?",
        args: [input.session_id],
      });
      const seq = Number(rs.rows[0]?.max_seq ?? -1) + 1;
      full = {
        event_id: randomUUID(),
        session_id: input.session_id,
        seq,
        ts: Date.now(),
        type: input.type,
        actor: input.actor,
        turn_id: input.turn_id ?? null,
        causation_id: input.causation_id ?? null,
        payload: input.payload,
      };
      await tx.execute({
        sql: `INSERT INTO events (session_id, seq, event_id, ts, type, actor, turn_id, causation_id, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          full.session_id,
          full.seq,
          full.event_id,
          full.ts,
          full.type,
          full.actor,
          full.turn_id,
          full.causation_id,
          JSON.stringify(full.payload),
        ],
      });
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }

    // 提交后发布到总线（SSE 订阅者据此实时推送）
    this.bus.publish(full as AgentEvent);
    return full;
  }

  async readSince(sessionId: string, afterSeq: number): Promise<AgentEvent[]> {
    await this.ready;
    const rs = await this.db.execute({
      sql: "SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq",
      args: [sessionId, afterSeq],
    });
    return rs.rows.map((r) => this.rowToEvent(r));
  }

  async readRange(sessionId: string, fromSeq: number, toSeq: number): Promise<AgentEvent[]> {
    await this.ready;
    const rs = await this.db.execute({
      sql: "SELECT * FROM events WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq",
      args: [sessionId, fromSeq, toSeq],
    });
    return rs.rows.map((r) => this.rowToEvent(r));
  }

  async latestSeq(sessionId: string): Promise<number> {
    await this.ready;
    const rs = await this.db.execute({
      sql: "SELECT MAX(seq) AS max_seq FROM events WHERE session_id = ?",
      args: [sessionId],
    });
    return Number(rs.rows[0]?.max_seq ?? -1);
  }

  async findLast(sessionId: string, type: EventType): Promise<AgentEvent | null> {
    await this.ready;
    const rs = await this.db.execute({
      sql: "SELECT * FROM events WHERE session_id = ? AND type = ? ORDER BY seq DESC LIMIT 1",
      args: [sessionId, type],
    });
    const row = rs.rows[0];
    return row ? this.rowToEvent(row) : null;
  }

  // ---------- 会话 ----------

  private async rowToSession(row: Row): Promise<SessionRecord> {
    const sessionId = String(row.session_id);
    return {
      session_id: sessionId,
      title: String(row.title),
      cwd: String(row.cwd),
      mode: String(row.mode) as SessionRecord["mode"],
      model: String(row.model),
      sandbox_level: String(row.sandbox_level) as SessionRecord["sandbox_level"],
      created_at: Number(row.created_at),
      archived: Number(row.archived) === 1,
      forked_from: row.forked_from === null ? null : String(row.forked_from),
      caller_identity: String(row.caller_identity),
      status: await this.currentStatus(sessionId),
      last_seq: await this.latestSeq(sessionId),
      usage: await this.totalUsage(sessionId),
    };
  }

  /** 聚合 turn.completed 的 token 用量（成本归因的最小形态） */
  private async totalUsage(sessionId: string): Promise<{ prompt_tokens: number; completion_tokens: number }> {
    await this.ready;
    const rs = await this.db.execute({
      sql: `SELECT
           SUM(json_extract(payload, '$.usage.prompt_tokens')) AS p,
           SUM(json_extract(payload, '$.usage.completion_tokens')) AS c
          FROM events WHERE session_id = ? AND type = 'turn.completed'`,
      args: [sessionId],
    });
    const row = rs.rows[0];
    return {
      prompt_tokens: Number(row?.p ?? 0),
      completion_tokens: Number(row?.c ?? 0),
    };
  }

  async search(query: string, limit = 20): Promise<SearchHit[]> {
    await this.ready;
    const rs = await this.db.execute({
      sql: `SELECT e.seq, e.type, e.payload, e.ts, s.title, s.session_id
          FROM events e JOIN sessions s ON s.session_id = e.session_id
          WHERE e.type IN ('message.user', 'message.assistant.completed', 'tool.call.completed')
            AND e.payload LIKE ?
          ORDER BY e.ts DESC LIMIT ?`,
      args: [`%${query}%`, limit],
    });
    return rs.rows.map((r) => {
      const payload = JSON.parse(String(r.payload)) as Record<string, unknown>;
      const text = String(payload.text ?? payload.result ?? "");
      const idx = text.indexOf(query);
      const start = Math.max(0, idx - 40);
      return {
        session_id: String(r.session_id),
        session_title: String(r.title),
        seq: Number(r.seq),
        type: String(r.type),
        snippet: (start > 0 ? "…" : "") + text.slice(start, idx + query.length + 80),
        ts: Number(r.ts),
      };
    });
  }

  private async currentStatus(sessionId: string): Promise<SessionStatus> {
    const last = await this.findLast(sessionId, "session.status_changed");
    return (last?.payload as { status?: SessionStatus })?.status ?? "idle";
  }

  async createSession(record: Omit<SessionRecord, "status" | "last_seq">): Promise<SessionRecord> {
    await this.ready;
    await this.db.execute({
      sql: `INSERT INTO sessions (session_id, title, cwd, mode, model, sandbox_level, created_at, archived, forked_from, caller_identity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.session_id,
        record.title,
        record.cwd,
        record.mode,
        record.model,
        record.sandbox_level,
        record.created_at,
        record.archived ? 1 : 0,
        record.forked_from,
        record.caller_identity,
      ],
    });
    return (await this.getSession(record.session_id))!;
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    await this.ready;
    const rs = await this.db.execute({
      sql: "SELECT * FROM sessions WHERE session_id = ?",
      args: [sessionId],
    });
    const row = rs.rows[0];
    return row ? this.rowToSession(row) : null;
  }

  async listSessions(includeArchived = false): Promise<SessionRecord[]> {
    await this.ready;
    const rs = await this.db.execute({
      sql: `SELECT * FROM sessions WHERE archived <= ? ORDER BY created_at DESC`,
      args: [includeArchived ? 1 : 0],
    });
    const out: SessionRecord[] = [];
    for (const row of rs.rows) {
      out.push(await this.rowToSession(row));
    }
    return out;
  }

  async setSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
    await this.append({
      session_id: sessionId,
      type: "session.status_changed",
      actor: "system",
      payload: { status },
    });
  }

  async updateSessionConfig(
    sessionId: string,
    patch: Partial<Pick<SessionRecord, "mode" | "model" | "sandbox_level" | "title" | "archived">>,
  ): Promise<void> {
    await this.ready;
    const sets: string[] = [];
    const vals: InValue[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(k === "archived" ? (v ? 1 : 0) : (v as string));
    }
    if (sets.length === 0) return;
    vals.push(sessionId);
    await this.db.execute({
      sql: `UPDATE sessions SET ${sets.join(", ")} WHERE session_id = ?`,
      args: vals,
    });
  }

  /** 分叉：把源会话 [fromSeq, toSeq] 区间的事件物理复制到目标会话 */
  async copyEventsTo(targetSessionId: string, sourceSessionId: string, fromSeq: number, toSeq: number): Promise<void> {
    const events = await this.readRange(sourceSessionId, fromSeq, toSeq);
    for (const e of events) {
      await this.append({
        session_id: targetSessionId,
        type: e.type,
        actor: e.actor,
        turn_id: e.turn_id,
        causation_id: e.causation_id,
        payload: e.payload,
      } as EventInput);
    }
  }

  async close(): Promise<void> {
    await this.ready;
    this.db.close();
  }
}
