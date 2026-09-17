# 0010. Persisting the event log: plain synchronous `bun:sqlite`, one `events` table (D21)

## Status

Accepted. Decided 2026-09-13 in phase 2's persistence design and built the same phase;
**recorded here 2026-09-17**, when `docs/decisions.md` was retired. Validated by phase 2's exit
criterion — `SIGKILL` mid-run, a real process restart, intact and correctly-`interrupted` partial
history (`docs/findings/4-crash-mid-run-recovery.md`) — and load-bearing for everything phase 3
built on top.

## Context

ADR 0003 defines the run-event type; this decides what stores it. Two questions were open: whether
persistence goes through Effect (D4 says "Effect owns the server"), and whether the log gets
companion `runs`/`steps`/`artifacts` tables for the queries the API and UI will want.

ADR 0004 already cites this decision six times as the precedent for staying out of Effect in the
HTTP layer, but it has never had a record of its own.

## Decision

**Plain synchronous functions over `bun:sqlite`** — `openStore` / `appendEvent` / `getRunEvents` /
`listRuns` in `src/persistence/store.ts`. Not `@effect/sql-sqlite-bun`, which is not installed.

**One table.** `events(run_id, seq, ts, tag, payload)`, primary key `(run_id, seq)`, journal mode
WAL. No `runs`, `steps` or `artifacts` tables.

**Run status is derived at read time, not written.** `listRuns` projects per-run summaries from the
event rows themselves with correlated subqueries: the first event's `ts` is the start time, the
first terminal event decides the outcome, and its *absence* is what `"interrupted"` means.

Three arguments, in the order they decided it:

1. **Nothing to bridge.** Phase 2 is CLI-driven and `bun:sqlite` is synchronous in-process I/O;
   wrapping it in Effect adds a layer with no async boundary, no resource to manage and no error
   channel that is not already a thrown exception. It matches `ctx.exec`/`ctx.writeBack` staying
   plain async (D4, ADR 0009 §2).
2. **A second table would be a cache that can drift.** A run's identity, outcome and timing are all
   derivable from its own rows — `RunStarted`, and the terminal event or its absence — so a `runs`
   table stores nothing new and introduces a way for the summary and the log to disagree.
3. **Nothing observes a crash as it happens.** A status column would have to be written by the
   process that just died. Deriving it at read time is the only definition that survives `SIGKILL`.

## Consequences

- **Crash recovery is free, and that is the phase 2 exit criterion.** An append-only table plus a
  read-time projection means a killed process leaves a correct partial history by construction.
- **`"interrupted"` means "no terminal event", nothing more.** That is a property of the store, not
  of liveness — which is precisely the trap the SPA fell into later: a live run has no terminal
  event either. ADR 0011 is the fix, and it works by pairing the store's answer with the server's
  in-process registry rather than by adding state here.
- **Summary queries are correlated subqueries over one table, and will get slower with volume.**
  Acceptable at POC scale; the seam if it stops being acceptable is a materialised view or a
  projection table fed from the log — still downstream of it, never authoritative.
- **`seq` is the only ordering key, and it is Factory's.** Chunk timestamps are not usable for
  ordering (ADR 0003, finding 1), so the `(run_id, seq)` primary key is what makes replay,
  `Last-Event-ID` resume and dedupe possible at all.
- **WAL means concurrent runs write without blocking each other**, which is part of why D28's
  per-run working trees were the whole of concurrency (ADR 0005): the store was already per-run
  safe.
- **New state must be a new event tag, not a new column.** A queued-run state, for example, is an
  ADR 0003 change plus a projection change — the cost is deliberate.
