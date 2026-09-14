/**
 * 存储层：EventStore 接口 + SQLite 实现。
 *
 * 不变量（见《事件模型设计》）：
 * - append-only：事件只追加，永不修改
 * - seq 会话内单调递增、无空洞（事务内分配）
 * - 所有读写必须经过此接口（团队版存储挂钩）
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type {
  AgentEvent,
  EventInput,
  EventType,
  SessionRecord,
  SessionStatus,
} from "@shuyi/types";
import type { EventBus } from "../bus/index.js";

export interface SearchHit {
  session_id: string;
  session_title: string;
  seq: number;
  type: string;
  snippet: string;
  ts: number;
}

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
  search(query: string, limit?: number): SearchHit[];

  append<T extends EventType>(input: EventInput<T>): AgentEvent<T>;
  readSince(sessionId: string, afterSeq: number): AgentEvent[];
  readRange(sessionId: string, fromSeq: number, toSeq: number): AgentEvent[];
  latestSeq(sessionId: string): number;
  findLast(sessionId: string, type: EventType): AgentEvent | null;

  createSession(record: Omit<SessionRecord, "status" | "last_seq">): SessionRecord;
  getSession(sessionId: string): SessionRecord | null;
  listSessions(includeArchived?: boolean): SessionRecord[];
  setSessionStatus(sessionId: string, status: SessionStatus): void;
  updateSessionConfig(
    sessionId: string,
    patch: Partial<Pick<SessionRecord, "mode" | "model" | "sandbox_level" | "title" | "archived">>,
  ): void;
  copyEventsTo(targetSessionId: string, sourceSessionId: string, fromSeq: number, toSeq: number): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
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
);
CREATE TABLE IF NOT EXISTS events (
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
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_events_type ON events(session_id, type, seq);
CREATE INDEX IF NOT EXISTS idx_events_turn ON events(session_id, turn_id);
`;

interface EventRow {
  session_id: string;
  seq: number;
  event_id: string;
  ts: number;
  type: string;
  actor: string;
  turn_id: string | null;
  causation_id: string | null;
  payload: string;
}

interface SessionRow {
  session_id: string;
  title: string;
  cwd: string;
  mode: string;
  model: string;
  sandbox_level: string;
  created_at: number;
  archived: number;
  forked_from: string | null;
  caller_identity: string;
}

export class SqliteEventStore implements EventStore {
  private db: Database;

  constructor(
    dbPath: string,
    private bus: EventBus,
  ) {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
  }

  private rowToEvent(row: EventRow): AgentEvent {
    return {
      event_id: row.event_id,
      session_id: row.session_id,
      seq: row.seq,
      ts: row.ts,
      type: row.type as EventType,
      actor: row.actor as AgentEvent["actor"],
      turn_id: row.turn_id,
      causation_id: row.causation_id,
      payload: JSON.parse(row.payload),
    } as AgentEvent;
  }

  append<T extends EventType>(input: EventInput<T>): AgentEvent<T> {
    // seq 分配与插入必须在同一事务内，保证单调无空洞
    const event = this.db.transaction(() => {
      const row = this.db
        .query<{ max_seq: number | null }, [string]>(
          "SELECT MAX(seq) AS max_seq FROM events WHERE session_id = ?",
        )
        .get(input.session_id);
      const seq = (row?.max_seq ?? -1) + 1;
      const full: AgentEvent<T> = {
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
      this.db
        .query(
          `INSERT INTO events (session_id, seq, event_id, ts, type, actor, turn_id, causation_id, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          full.session_id,
          full.seq,
          full.event_id,
          full.ts,
          full.type,
          full.actor,
          full.turn_id,
          full.causation_id,
          JSON.stringify(full.payload),
        );
      return full;
    })();

    // 提交后发布到总线（SSE 订阅者据此实时推送）
    this.bus.publish(event as AgentEvent);
    return event;
  }

  readSince(sessionId: string, afterSeq: number): AgentEvent[] {
    const rows = this.db
      .query<EventRow, [string, number]>(
        "SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq",
      )
      .all(sessionId, afterSeq);
    return rows.map((r) => this.rowToEvent(r));
  }

  readRange(sessionId: string, fromSeq: number, toSeq: number): AgentEvent[] {
    const rows = this.db
      .query<EventRow, [string, number, number]>(
        "SELECT * FROM events WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq",
      )
      .all(sessionId, fromSeq, toSeq);
    return rows.map((r) => this.rowToEvent(r));
  }

  latestSeq(sessionId: string): number {
    const row = this.db
      .query<{ max_seq: number | null }, [string]>(
        "SELECT MAX(seq) AS max_seq FROM events WHERE session_id = ?",
      )
      .get(sessionId);
    return row?.max_seq ?? -1;
  }

  findLast(sessionId: string, type: EventType): AgentEvent | null {
    const row = this.db
      .query<EventRow, [string, string]>(
        "SELECT * FROM events WHERE session_id = ? AND type = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(sessionId, type);
    return row ? this.rowToEvent(row) : null;
  }

  // ---------- 会话 ----------

  private rowToSession(row: SessionRow): SessionRecord {
    return {
      session_id: row.session_id,
      title: row.title,
      cwd: row.cwd,
      mode: row.mode as SessionRecord["mode"],
      model: row.model,
      sandbox_level: row.sandbox_level as SessionRecord["sandbox_level"],
      created_at: row.created_at,
      archived: row.archived === 1,
      forked_from: row.forked_from,
      caller_identity: row.caller_identity,
      status: this.currentStatus(row.session_id),
      last_seq: this.latestSeq(row.session_id),
      usage: this.totalUsage(row.session_id),
    };
  }

  /** 聚合 turn.completed 的 token 用量（成本归因的最小形态） */
  private totalUsage(sessionId: string): { prompt_tokens: number; completion_tokens: number } {
    const row = this.db
      .query<{ p: number | null; c: number | null }, [string]>(
        `SELECT
           SUM(json_extract(payload, '$.usage.prompt_tokens')) AS p,
           SUM(json_extract(payload, '$.usage.completion_tokens')) AS c
         FROM events WHERE session_id = ? AND type = 'turn.completed'`,
      )
      .get(sessionId);
    return { prompt_tokens: row?.p ?? 0, completion_tokens: row?.c ?? 0 };
  }

  search(query: string, limit = 20): SearchHit[] {
    const rows = this.db
      .query<SessionRow & { seq: number; type: string; payload: string; ts: number; title: string }, [string, number]>(
        `SELECT e.seq, e.type, e.payload, e.ts, s.title, s.session_id
         FROM events e JOIN sessions s ON s.session_id = e.session_id
         WHERE e.type IN ('message.user', 'message.assistant.completed', 'tool.call.completed')
           AND e.payload LIKE ?
         ORDER BY e.ts DESC LIMIT ?`,
      )
      .all(`%${query}%`, limit);
    return rows.map((r) => {
      const payload = JSON.parse(r.payload) as Record<string, unknown>;
      const text = String(payload.text ?? payload.result ?? "");
      const idx = text.indexOf(query);
      const start = Math.max(0, idx - 40);
      return {
        session_id: r.session_id,
        session_title: r.title,
        seq: r.seq,
        type: r.type,
        snippet: (start > 0 ? "…" : "") + text.slice(start, idx + query.length + 80),
        ts: r.ts,
      };
    });
  }

  private currentStatus(sessionId: string): SessionStatus {
    const last = this.findLast(sessionId, "session.status_changed");
    return (last?.payload as { status?: SessionStatus })?.status ?? "idle";
  }

  createSession(record: Omit<SessionRecord, "status" | "last_seq">): SessionRecord {
    this.db
      .query(
        `INSERT INTO sessions (session_id, title, cwd, mode, model, sandbox_level, created_at, archived, forked_from, caller_identity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
    return this.getSession(record.session_id)!;
  }

  getSession(sessionId: string): SessionRecord | null {
    const row = this.db
      .query<SessionRow, [string]>("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId);
    return row ? this.rowToSession(row) : null;
  }

  listSessions(includeArchived = false): SessionRecord[] {
    const rows = this.db
      .query<SessionRow, [number]>(
        `SELECT * FROM sessions WHERE archived <= ? ORDER BY created_at DESC`,
      )
      .all(includeArchived ? 1 : 0);
    return rows.map((r) => this.rowToSession(r));
  }

  setSessionStatus(sessionId: string, status: SessionStatus): void {
    this.append({
      session_id: sessionId,
      type: "session.status_changed",
      actor: "system",
      payload: { status },
    });
  }

  updateSessionConfig(
    sessionId: string,
    patch: Partial<Pick<SessionRecord, "mode" | "model" | "sandbox_level" | "title" | "archived">>,
  ): void {
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(k === "archived" ? (v ? 1 : 0) : (v as string));
    }
    if (sets.length === 0) return;
    vals.push(sessionId);
    this.db.query(`UPDATE sessions SET ${sets.join(", ")} WHERE session_id = ?`).run(...vals);
  }

  /** 分叉：把源会话 [fromSeq, toSeq] 区间的事件物理复制到目标会话 */
  copyEventsTo(targetSessionId: string, sourceSessionId: string, fromSeq: number, toSeq: number): void {
    const events = this.readRange(sourceSessionId, fromSeq, toSeq);
    for (const e of events) {
      this.append({
        session_id: targetSessionId,
        type: e.type,
        actor: e.actor,
        turn_id: e.turn_id,
        causation_id: e.causation_id,
        payload: e.payload,
      } as EventInput);
    }
  }

  close(): void {
    this.db.close();
  }
}
