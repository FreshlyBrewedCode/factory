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
import { isTerminal, RunEvent, type RunEventPayload } from "../events";

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
  readonly startedAt: number;
  readonly finishedAt: number | undefined;
  readonly status: RunStatus | "interrupted";
  readonly eventCount: number;
}

export function listRuns(db: Database): ReadonlyArray<RunSummary> {
  const rows = db.query<{ run_id: string }, []>("SELECT DISTINCT run_id FROM events").all();

  return rows
    .map(({ run_id }) => summarizeRun(db, run_id))
    .sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId));
}

function summarizeRun(db: Database, runId: string): RunSummary {
  const events = getRunEvents(db, runId);
  const started = events.find((e) => e.payload._tag === "RunStarted");
  const terminal = events.find((e) => isTerminal(e.payload));

  return {
    runId,
    workflowId: started?.payload._tag === "RunStarted" ? started.payload.workflowId : undefined,
    dir: started?.payload._tag === "RunStarted" ? started.payload.dir : undefined,
    startedAt: events[0]?.ts ?? 0,
    finishedAt: terminal?.ts,
    status: terminal !== undefined ? (terminal.payload._tag as RunStatus) : "interrupted",
    eventCount: events.length,
  };
}
