/**
 * Phase 2: the event log becomes durable. One table, because `RunEvent`
 * (`src/events.ts`) already documents its own schema — `events(run_id, seq,
 * ts, tag, payload)`, PK `(run_id, seq)` — and D3 makes it the single source
 * of truth. No separate `runs`/`steps`/`artifacts` tables: a run's identity,
 * outcome and timing are all derivable from its own event rows (`RunStarted`
 * for the former, the terminal event — or its absence — for the latter), so a
 * second table would just be a cache that can drift from the log it's a
 * cache of.
 *
 * Plain synchronous functions over `bun:sqlite`, not an Effect layer: D4
 * scopes "Effect owns the server" to phase 3's daemon (lifecycle, dispatch,
 * scheduling). Phase 2 is still CLI-driven (STATUS.md), and `bun:sqlite`'s
 * API is synchronous in-process I/O — wrapping it in Effect here would add a
 * layer with nothing to bridge, the same reasoning that keeps `ctx.exec`/
 * `ctx.writeBack` (`src/lib/`) as plain async functions.
 */

import { Database } from "bun:sqlite";
import { Schema, SchemaParser } from "effect";
import { RunEvent, type RunEventPayload } from "../events";
import type { WorkspaceKind } from "../workflow";

export function openStore(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      tag TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
  `);
  return db;
}

const encodeEvent = Schema.encodeSync(RunEvent);
const decodeEvent = SchemaParser.decodeUnknownSync(RunEvent);

export function appendEvent(db: Database, event: RunEvent): void {
  const encoded = encodeEvent(event);
  db.query("INSERT INTO events (run_id, seq, ts, tag, payload) VALUES (?, ?, ?, ?, ?)").run(
    encoded.runId,
    encoded.seq,
    encoded.ts,
    encoded.payload._tag,
    JSON.stringify(encoded.payload),
  );
}

export function getRunEvents(db: Database, runId: string): ReadonlyArray<RunEvent> {
  const rows = db
    .query<{ run_id: string; seq: number; ts: number; tag: string; payload: string }, [string]>(
      "SELECT run_id, seq, ts, tag, payload FROM events WHERE run_id = ? ORDER BY seq ASC",
    )
    .all(runId);

  return rows.map((row) =>
    decodeEvent({
      runId: row.run_id,
      seq: row.seq,
      ts: row.ts,
      payload: JSON.parse(row.payload) as unknown,
    }),
  );
}

/**
 * A run with no terminal event in its log is `"interrupted"` — the process
 * died mid-run rather than the workflow reaching `RunFinished`/`RunFailed`/
 * `RunCancelled` (D12: "mark interrupted runs and keep history queryable").
 * Derived at read time from the log, not written at crash time — nothing
 * detects the crash as it happens, so there is nothing to mark until someone
 * asks.
 */
export type RunStatus = Extract<
  RunEventPayload["_tag"],
  "RunFinished" | "RunFailed" | "RunCancelled"
>;

export interface RunSummary {
  readonly runId: string;
  readonly workflowId: string | undefined;
  readonly dir: string | undefined;
  /** How `dir` was provisioned (issue #13). Pre-issue events default to clone. */
  readonly workspaceKind: WorkspaceKind;
  readonly startedAt: number;
  readonly finishedAt: number | undefined;
  readonly status: RunStatus | "interrupted";
  readonly eventCount: number;
  /** Decoded from `RunStarted.input` (D5) — arbitrary, per-workflow. */
  readonly input: unknown;
  /** Decoded from `RunFinished.output` when the run reached that tag — arbitrary, per-workflow. */
  readonly output: unknown;
  /**
   * Issue #16: the schedule that started this run, when any did — from
   * `RunStarted.scheduleId`. A manual or dispatched run has no schedule.
   */
  readonly scheduleId: string | undefined;
}

interface RunSummaryRow {
  readonly run_id: string;
  readonly event_count: number;
  readonly started_at: number;
  readonly started_payload: string | null;
  readonly finished_at: number | null;
  readonly status: string | null;
  readonly terminal_payload: string | null;
}

/**
 * One row per run, aggregated by SQL so a summary never reads (or decodes) a
 * run's events. The correlated subqueries pick, per run: the first event (its
 * `ts` is the start time — the old `events[0].ts`, deliberately not `MIN(ts)`,
 * which a back-dated `sandbox.file`-style chunk would corrupt), the `RunStarted`
 * row (for `workflowId`/`dir`) and the first terminal row (for status/timing).
 *
 * Ordering is the runs page's: newest first, ties broken by `runId` so the
 * order is stable rather than whatever the row scan happens to produce.
 */
export function listRuns(db: Database): ReadonlyArray<RunSummary> {
  const rows = db
    .query<RunSummaryRow, []>(`
      SELECT
        agg.run_id AS run_id,
        agg.event_count AS event_count,
        first_evt.ts AS started_at,
        started.payload AS started_payload,
        term.ts AS finished_at,
        term.tag AS status,
        term.payload AS terminal_payload
      FROM (SELECT run_id, COUNT(*) AS event_count FROM events GROUP BY run_id) AS agg
      JOIN events AS first_evt
        ON first_evt.run_id = agg.run_id
       AND first_evt.seq = (SELECT MIN(m.seq) FROM events AS m WHERE m.run_id = agg.run_id)
      LEFT JOIN events AS started
        ON started.run_id = agg.run_id
       AND started.seq = (
         SELECT MIN(s.seq) FROM events AS s
         WHERE s.run_id = agg.run_id AND s.tag = 'RunStarted'
       )
      LEFT JOIN events AS term
        ON term.run_id = agg.run_id
       AND term.seq = (
         SELECT MIN(t.seq) FROM events AS t
         WHERE t.run_id = agg.run_id
           AND t.tag IN ('RunFinished', 'RunFailed', 'RunCancelled')
       )
      ORDER BY started_at DESC, agg.run_id ASC
    `)
    .all();

  return rows.map((row) => {
    const started =
      row.started_payload === null
        ? undefined
        : (JSON.parse(row.started_payload) as RunEventPayload);
    const terminal =
      row.terminal_payload === null
        ? undefined
        : (JSON.parse(row.terminal_payload) as RunEventPayload);

    return {
      runId: row.run_id,
      workflowId: started?._tag === "RunStarted" ? started.workflowId : undefined,
      dir: started?._tag === "RunStarted" ? started.dir : undefined,
      workspaceKind: started?._tag === "RunStarted" ? (started.workspaceKind ?? "clone") : "clone",
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      status: row.status === null ? "interrupted" : (row.status as RunStatus),
      eventCount: row.event_count,
      input: started?._tag === "RunStarted" ? started.input : undefined,
      output: terminal?._tag === "RunFinished" ? terminal.output : undefined,
      scheduleId: started?._tag === "RunStarted" ? started.scheduleId : undefined,
    };
  });
}
