/**
 * D3's run-event type — the append-only spine shared by all three columns.
 * The runtime emits, sqlite stores (phase 2), SSE replays (phase 3), the SPA
 * renders (phase 4).
 *
 * Designed against the nine NDJSON corpora under `.factory/runs/` (D14), with
 * ADR 0002's emission surface pinned. See
 * `docs/findings/1-event-type-corpus-analysis.md` for the measurements behind
 * every non-obvious choice here, and ADR 0003 for the decision record.
 *
 * Two halves, deliberately asymmetric:
 *
 * 1. **Factory lifecycle events** — typed, because we emit them and nobody
 *    else will. The harness emits nothing about exec results, assertions,
 *    write-back or cancellation (ADR 0001 §5), so this log is the only replay
 *    path that will ever exist for them.
 * 2. **`AgentChunk`** — one opaque passthrough member carrying an AG-UI
 *    protocol chunk verbatim. AG-UI is a published cross-vendor streaming
 *    spec, and `@tanstack/ai` already ships its transport
 *    (`toServerSentEventsStream`, `toHttpStream`) and client
 *    (`@tanstack/ai-event-client`). Re-typing 33 event types into a Factory
 *    dialect would buy nothing and would make every adapter swap a schema
 *    migration over stored data.
 */

import { Schema } from "effect";

/**
 * How an activity inside a run ended.
 *
 * `cancelled` exists because the harness never signals it. An aborted step's
 * chunk stream simply stops mid-`TEXT_MESSAGE` — no `RUN_FINISHED`, no
 * `RUN_ERROR`, no terminal chunk of any kind (corpus:
 * `effect-boundary-abort-*`). From the chunks alone a cancelled step is
 * indistinguishable from one still in flight. Only Factory knows, so only
 * Factory can record it.
 */
export const Outcome = Schema.Literals(["completed", "failed", "cancelled"]);
export type Outcome = typeof Outcome.Type;

/** Elapsed wall-clock in milliseconds. Finite: a duration is never NaN or ∞. */
const DurationMs = Schema.Finite;

/** A count, an offset, an epoch-millisecond stamp, or a process exit code. */
const Integer = Schema.Int;

/**
 * The payload union. `_tag` is the discriminant; `Schema.TaggedUnion` also
 * gives us `guards`, `isAnyOf`, `match` and `matchOrElse` for free, which is
 * what the CLI renderer and (later) the SPA will consume.
 *
 * Naming trap, called out because it will bite someone: the harness has its
 * own `RUN_STARTED`/`RUN_FINISHED` chunk types, and they are *not* these.
 * A harness `RUN_STARTED` fires once per agent step and arrives inside an
 * `AgentChunk`; `RunStarted` below fires once per Factory run. The corpora
 * show exactly one harness RUN_STARTED/RUN_FINISHED pair per agent step.
 */
export const RunEventPayload = Schema.TaggedUnion({
  // ---- Run lifecycle -------------------------------------------------
  // The run is the unit of record — phase 2's tables, phase 3's dispatch.
  // Its terminal state is a state-machine transition and the three outcomes
  // carry structurally different payloads, so each gets its own tag. Activities
  // *within* a run (below) report an `outcome` field instead: their payload
  // shape does not change with the outcome.

  RunStarted: {
    workflowId: Schema.String,
    /** The prepared working tree. The runtime clones; the workflow never does (D8). */
    dir: Schema.String,
    /** Decoded and validated against the workflow's `input` schema (D5). */
    input: Schema.Json,
    /**
     * How `dir` was provisioned (issue #13). Optional so pre-issue events and
     * the nine corpora still decode; a run without it is a `clone` workspace.
     */
    workspaceKind: Schema.optional(Schema.Literals(["clone", "scratch"])),
    /**
     * The run context this run was started by, via `ctx.dispatch` (issue #14).
     * Present on child runs only — a top-level run has no parent. Cancelling
     * the parent does **not** cascade (D-epic 19); the link is for the UI's
     * parent ↔ child navigation and nothing else.
     */
    parentId: Schema.optional(Schema.String),
    /**
     * The run's dedupe key (issue #15), present only when the run was started
     * with one. While this run is non-terminal, no other run can start with
     * the same key; the record here is for observability — the holder is
     * named in any `DispatchCollision` raised against it. Absent, the run
     * holds nothing.
     */
    dedupeKey: Schema.optional(Schema.String),
    /**
     * Issue #16: the schedule that started this run, present only on runs
     * fired by the scheduler. Absent on manual, dispatched and CLI runs; the
     * optional field keeps pre-issue events decodable.
     */
    scheduleId: Schema.optional(Schema.String),
  },

  RunFinished: {
    /** Validated against the workflow's optional `output` schema (ADR 0002 §1). */
    output: Schema.optional(Schema.Json),
    durationMs: DurationMs,
  },

  RunFailed: {
    /** The workflow fails by throwing; this is that throw, flattened (ADR 0002 §3). */
    message: Schema.String,
    stack: Schema.optional(Schema.String),
    durationMs: DurationMs,
  },

  RunCancelled: {
    durationMs: DurationMs,
  },

  /**
   * The parent's record of one `ctx.dispatch` call (issue #14). The child's
   * own log carries the mirror link — `RunStarted.parentId` — so run detail
   * can navigate both directions from events alone, with no second table.
   * Fire-and-forget by design: dispatch resolves to the child's run id and
   * never waits for it (D-epic 19 — an awaited child holding a concurrency
   * slot deadlocks the pool).
   */
  RunDispatched: {
    childRunId: Schema.String,
    childWorkflowId: Schema.String,
    input: Schema.Json,
    /**
     * The child's dedupe key (issue #15), present only when the dispatch
     * carried one.
     */
    dedupeKey: Schema.optional(Schema.String),
  },

  /**
   * The parent's record of a `ctx.dispatch` call rejected on a dedupe-key
   * collision (issue #15). The throw fails the parent visibly — this event is
   * the log-side record the run-detail UI surfaces, with the holding run
   * reachable from `holderRunId`. A collision is never a silent no-op.
   */
  DispatchCollision: {
    key: Schema.String,
    /** The run currently holding `key` (non-terminal — it is holding). */
    holderRunId: Schema.String,
    childWorkflowId: Schema.String,
  },

  // ---- ctx.agent(name, prompt, opts?) --------------------------------

  AgentStepStarted: {
    /**
     * Per-occurrence correlation id, assigned by the runtime.
     *
     * `name` alone is not enough. ADR 0002 makes step names mandatory but not
     * unique, and 0a-2's `{step, chunk}` envelope only worked because that
     * workflow happened to use three distinct names. A retry loop calling
     * `ctx.agent("fix", ...)` twice would make name-keyed correlation
     * ambiguous, so the id is the join key and `name` is the human label.
     */
    stepId: Schema.String,
    name: Schema.String,
    model: Schema.String,
    prompt: Schema.String,
    /** Whether an `output` schema was passed, i.e. whether to expect structured output. */
    structured: Schema.Boolean,
  },

  /**
   * One AG-UI protocol chunk, verbatim.
   *
   * `chunk` is `Schema.Json` rather than a Factory-shaped type: opacity is a
   * property of *this log and its consumers*, not of the runtime. The runtime
   * itself no longer interprets the stream — the adapter does (ADR 0012 §2)
   * and hands over normalized signals instead; the SPA still folds these
   * chunks with `StreamProcessor` from `@tanstack/ai/client`.
   *
   * `chunkType` is the chunk's own `type` field copied out. It is an opaque
   * string, never an enum, and Factory never branches on it — it exists so
   * phase 2 can index and the UI can filter without parsing JSON in SQL.
   */
  AgentChunk: {
    stepId: Schema.String,
    chunkType: Schema.String,
    chunk: Schema.Json,
  },

  AgentStepFinished: {
    stepId: Schema.String,
    name: Schema.String,
    outcome: Outcome,
    chunkCount: Integer,
    durationMs: DurationMs,
    /**
     * The last completed assistant message. Accumulated from
     * `TEXT_MESSAGE_CONTENT.delta` between START and END — note `delta`, not
     * `content`; the 0a-1 corpus is what caught that (finding #2).
     *
     * A cancelled step can end mid-message, in which case the partial buffer is
     * dropped and this is whatever the last *closed* message was. Consumers
     * must not assume a terminated step has a final text at all.
     */
    finalText: Schema.String,
    /** Present only when tier 1 (the adapter's signal) or tier 2 (final-text re-parse) produced an object. */
    output: Schema.optional(Schema.Json),
    /** From the adapter's `session` signal (ADR 0012 §2). Fresh per step (D10). */
    sessionId: Schema.optional(Schema.String),
    /** From the adapter's `error` signal (ADR 0012 §2), or the abort reason. */
    error: Schema.optional(Schema.String),
  },

  // ---- ctx.exec(argv) ------------------------------------------------
  // Write-back's own git/gh invocations flow through here too, so the UI gets
  // per-command granularity for free and `WriteBackFinished` stays a summary.

  ExecStarted: {
    execId: Schema.String,
    command: Schema.Array(Schema.String),
    cwd: Schema.String,
  },

  ExecFinished: {
    execId: Schema.String,
    command: Schema.Array(Schema.String),
    /** Never throws; non-zero is the workflow's branching primitive (D9). */
    exitCode: Integer,
    stdout: Schema.String,
    stderr: Schema.String,
    durationMs: DurationMs,
  },

  // ---- ctx.assert(name, callback) ------------------------------------

  /**
   * ADR 0002: `ctx.assert` records and returns, it does **not** throw. This
   * event is the record. The runtime never learns what a "check" is; it only
   * standardises the shape so the UI can render pass/fail.
   */
  AssertionRecorded: {
    name: Schema.String,
    pass: Schema.Boolean,
    details: Schema.optional(Schema.Json),
  },

  // ---- ctx.log(name, data) -------------------------------------------

  /**
   * The generic escape hatch (ADR 0002 §2). This slot must exist before phase 2
   * persists anything — adding it later is a schema migration over stored data.
   */
  LogRecorded: {
    name: Schema.String,
    data: Schema.Json,
  },

  // ---- ctx.writeBack({...}) ------------------------------------------

  WriteBackStarted: {
    branch: Schema.String,
  },

  /**
   * The summary. Individual git/gh commands appear as `ExecFinished` events.
   *
   * `cleanedArtifacts` is the D16 workaround's output — the
   * `.tanstack-projected-*` marker files a `defineWorkspace` config strews into
   * the tree. It is surfaced rather than hidden so that the day upstream fixes
   * the bug, the events go empty and the workaround can be deleted on evidence.
   */
  WriteBackFinished: {
    branch: Schema.String,
    /**
     * Set only when D32's collision retry landed on a different branch than
     * the run was started with — the branch the PR actually landed on.
     */
    usedBranch: Schema.optional(Schema.String),
    outcome: Outcome,
    cleanedArtifacts: Schema.Array(Schema.String),
    stagedPaths: Schema.Array(Schema.String),
    prUrl: Schema.optional(Schema.String),
    error: Schema.optional(Schema.String),
  },
});

export type RunEventPayload = typeof RunEventPayload.Type;

/**
 * The stored/streamed envelope: what Factory knows, wrapped around what
 * happened.
 *
 * Maps to phase 2's table directly —
 * `events(run_id TEXT, seq INTEGER, ts INTEGER, tag TEXT, payload TEXT,
 *         PRIMARY KEY (run_id, seq))`
 * — which is also the shape SSE resume needs: `seq` is the offset.
 */
export const RunEvent = Schema.Struct({
  runId: Schema.String,

  /**
   * Per-run monotonic counter from 0, assigned by the runtime at ingest. **The
   * only ordering key.**
   *
   * Chunk timestamps cannot be used for this, and not because of clock jitter.
   * Every corpus contains 3–4 inversions and they are structural: each
   * `CUSTOM:sandbox.file` chunk is *back-dated*, carrying the watched file's
   * mtime rather than its emission time — up to 1473 ms earlier than the chunk
   * it arrives after. Sorting a corpus by timestamp reorders real events.
   */
  seq: Integer,

  /**
   * Factory's ingest wall-clock (ms). Display and duration only, never
   * ordering. The chunk's own `timestamp` is left untouched inside `chunk`, so
   * nothing is lost and nothing is silently corrected.
   */
  ts: Integer,

  payload: RunEventPayload,
});

export type RunEvent = typeof RunEvent.Type;

/** Terminal run states — the three tags phase 3's dispatcher waits on. */
export const isTerminal = RunEventPayload.isAnyOf(["RunFinished", "RunFailed", "RunCancelled"]);
