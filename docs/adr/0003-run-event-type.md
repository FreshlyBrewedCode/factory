# 0003. D3's run-event type — opaque AG-UI passthrough over a typed Factory spine

## Status

Accepted, 2026-09-14. Grounded in measurements, not design intuition: every non-obvious choice
below traces to a specific observation in
[`docs/findings/1-event-type-corpus-analysis.md`](../findings/1-event-type-corpus-analysis.md),
and the load-bearing ones are pinned as executable assertions in `src/events.test.ts`.

Implemented in `src/events.ts` at the time of writing. Nothing persists it yet (phase 2), so
the cost of being wrong is still one file and a test.

## Context

D3 makes one typed, append-only run-event log the spine shared by all three columns: the
runtime emits, sqlite stores, SSE replays, the SPA renders. STATUS instructed this type to be
designed **first**, against the corpora, because the runtime, the CLI and phase 2's schema all
hang off it — and because phase 2 turns every later change into a migration over stored data.

ADR 0002 settled the emission surface this type must be a superset of: step boundaries with
mandatory names, exec results, standardised assertions, open `log` records, write-back and the
PR URL, typed run results. That removed the risk of designing events for a shape that then
moved.

What remained genuinely open was the other half — **how to carry the harness's own chunks**,
which are the bulk of the volume (267 of 311 recorded lines) and none of which Factory
authors.

Not re-litigated here: D1, D3, D4, D5, D9, D10, D11, D14 (the corpora this is designed
against), D16 (the stray-artifact workaround this surfaces), and all of ADR 0002.

## Decision

### 1. Harness chunks are carried opaquely, in AG-UI form

One union member, `AgentChunk`, wraps the chunk verbatim as `Schema.Json`. Factory does not
re-type, re-name or normalise it.

The alternatives considered were enumerating opencode's 16 chunk types as Factory events, or
normalising them into a Factory-private semantic dialect. Both were rejected, because the
premise they share — that Factory must define this vocabulary — is false:

- **These chunks are AG-UI**, a published cross-vendor streaming protocol
  (`@tanstack/ai/skills/ai-core/ag-ui-protocol/SKILL.md`), not a TanStack-private shape.
  Adopting it is standardisation, not coupling.
- **TanStack already ships the hard parts.** SSE framing (`toServerSentEventsStream`), NDJSON
  framing (`toHttpStream`), resumable streams with offsets (`durableStreamSource`,
  `resumeServerSentEventsResponse`), WebSocket framing, a client package
  (`@tanstack/ai-event-client`), and spec normalisation middleware. Phase 3 needs SSE replay
  and phase 4 needs rendering; re-deriving either against a Factory dialect would be work
  spent to arrive back where we started.
- **Enumeration would be wrong within phase 1.** The opencode adapter's set is closed at 16,
  but the protocol declares 33, including `TEXT_MESSAGE_CHUNK`/`TOOL_CALL_CHUNK` combined
  variants that an adapter emits *instead of* the three-part framing opencode uses. Phase 1
  already plans a `claudeCodeText` comparison, which would break an opencode-shaped
  enumeration on contact.

`chunkType` is denormalised onto the event as a plain string so phase 2 can index and the UI
can filter without parsing JSON in SQL. It is copied, never interpreted: Factory has no enum
of chunk types and never branches on it.

**Opacity is a property of the log and its consumers, not of the runtime.** The runtime still
reads a handful of chunk types on the way past, because ADR 0002 obliges it to: tier-1
`structured-output.complete` extraction, tier-2 final-text re-parse, `opencode.session-id`,
and `TEXT_MESSAGE_*` accumulation. It does that while streaming and stores the chunk
unchanged. Stating this plainly because "opaque" would otherwise overclaim.

### 2. `seq` is the only ordering key

Every event carries a per-run monotonic counter assigned by Factory at ingest. Chunk
timestamps are retained inside the chunk and **never** used to order.

This is forced, not stylistic. All nine corpora contain timestamp inversions, and they are
structural rather than jitter: a `sandbox.file` chunk's `timestamp` is the watched file's
mtime, not its emission time (identical to `value.timestamp` in 12 of 15 cases, within 1 ms in
the rest), so those chunks arrive back-dated by up to 1473 ms. Sorting a corpus by timestamp
reorders real events.

`seq` doubles as the SSE resume offset in phase 3 and the primary-key tail in phase 2.

### 3. Run termination and step termination are Factory events with explicit outcomes

The harness emits **nothing** on cancellation. An aborted step's stream stops mid-message — no
`RUN_FINISHED`, no `RUN_ERROR`, no terminal chunk, and a `TEXT_MESSAGE_START` with no matching
END. A cancelled step, a crashed step and a step still in flight are indistinguishable from
the chunks alone.

So `Outcome` is `completed | failed | cancelled`, and termination is always recorded by
Factory. Correspondingly, consumers must treat unclosed messages and unresolved tool calls as
a normal terminal state.

### 4. Run terminal states are tags; activity outcomes are fields

`RunFinished` / `RunFailed` / `RunCancelled` are three separate tags. `AgentStepFinished` and
`WriteBackFinished` instead carry an `outcome` field.

The asymmetry is deliberate. The run is the unit of record — phase 2's tables, phase 3's
dispatch — its terminal state is a state-machine transition, and the three cases carry
structurally different payloads (`output` vs `message`/`stack` vs neither). Activities *within*
a run have the same payload shape whatever the outcome, and their consumer is a UI badge.
`RunEventPayload.isAnyOf(["RunFinished", "RunFailed", "RunCancelled"])` is exported as
`isTerminal` so the distinction stays cheap to use.

### 5. Correlation is by runtime-assigned id, not by name

`AgentStepStarted` / `AgentChunk` / `AgentStepFinished` join on `stepId`; `ExecStarted` /
`ExecFinished` join on `execId`.

0a-2's `{step, chunk}` envelope keyed on the step *name*, and worked only because that workflow
used three distinct ones. ADR 0002 makes names mandatory but not unique, and a retry loop
calling `ctx.agent("fix", …)` twice would silently merge two steps' chunks. Names stay as human
labels. `ctx.exec` has no name at all, hence `execId`.

The same finding applies inside a step: tool calls interleave (two `toolCallId`s open at once,
results out of start order), so anything correlating tool calls by nesting rather than by id is
wrong. That correlation lives in the UI, over the opaque chunks.

### 6. Envelope wraps payload

```ts
RunEvent = { runId, seq, ts, payload: RunEventPayload }
```

`ts` is Factory's ingest wall-clock — display and durations only, never ordering. The split
maps directly onto phase 2's table and phase 3's resume offset:

```sql
events(run_id TEXT, seq INTEGER, ts INTEGER, tag TEXT, payload TEXT,
       PRIMARY KEY (run_id, seq))
```

### 7. The corpora become committed fixtures

The nine `chunks.ndjson` files move from the gitignored `.factory/runs/` to `test/corpus/`
(128 KB), with a `.gitignore` negation. `src/events.test.ts` re-derives the inversion,
interleaving, delta-count and cancellation findings from them on every `bun test`, and asserts
that every recorded chunk round-trips through `AgentChunk` byte-identically.

Phase 1's corpus-replay fake adapter reads the same fixtures, so this also unblocks that.

## Consequences

**Benefits.** The volume half of the log costs Factory no schema, no maintenance and no
migration when adapters change; the half Factory actually owns is fully typed. Phases 3 and 4
inherit working SSE/NDJSON transport and a client library rather than a bespoke dialect.
Ordering, termination and correlation are correct against real recorded behaviour rather than
against what the docs imply — three things a hand-written stub would have got wrong in exactly
the way phase 0 got four other things wrong. `ctx.log`'s open slot exists before anything
persists, so it is not a later migration.

**Costs and risks, stated plainly:**

- **`Schema.Json` on `chunk` and on `log`/`assert` payloads means those are unvalidated.** A
  malformed chunk is stored as faithfully as a good one. This is the intended trade — the log
  is a recording first — but it does mean the type system will not catch an adapter that
  starts emitting something absurd.
- **The UI must understand AG-UI.** That is the accepted position (TanStack solves it), but it
  is a real dependency: column 2 cannot render a run without an AG-UI-aware renderer, and if
  `@tanstack/ai-event-client` turns out not to fit the board/detail UI, phase 4 pays for a
  renderer we chose not to pre-build. Trigger to revisit: the first phase-4 spike that finds
  the client unusable for run-detail rendering.
- **`chunkType` is denormalised, and denormalised data can drift** from the `type` inside the
  chunk if a writer is careless. Only the runtime writes events, so this is cheap to keep
  honest, but it is duplication.
- **The tags-vs-field asymmetry in §4 is a judgment call**, not a derivation. Someone reading
  only the type will find it arbitrary; this ADR is the explanation.
- **Multi-delta accumulation remains unverified.** Every observed delta was single-chunk (24
  text, 32 tool-args, 13 reasoning — all exactly one). The event type stores deltas as they
  arrive, which is correct either way, but the accumulation logic that produces `finalText` has
  never run against a genuinely streaming provider. STATUS keeps this open.
- **`sandbox.file` is not promoted to a typed file-change event**, despite being the obvious
  raw material for a "files changed" UI. Its paths are in two incompatible namespaces — the
  D16 marker-path bug leaks a host-absolute path concatenated onto `/workspace` — and 9 of 15
  occurrences are about the stray marker rather than real work. Trigger to revisit: the same
  upstream fix that retires D16's workaround.
- **Nothing here is proven end-to-end yet.** The type is validated against recorded data and
  against ADR 0002's surface, not against a runtime that emits it. Phase 1's exit criterion is
  still what converts it from design to evidence.

## References

- [`docs/findings/1-event-type-corpus-analysis.md`](../findings/1-event-type-corpus-analysis.md)
  — the nine findings behind every decision above
- [`docs/adr/0002-workflow-authoring-surface.md`](./0002-workflow-authoring-surface.md) — the
  emission surface this type is a superset of
- [`docs/adr/0001-write-back-isolation-effect-boundary.md`](./0001-write-back-isolation-effect-boundary.md)
  §5 — why the harness emits nothing about exec, assertions or write-back
- `src/events.ts`, `src/events.test.ts`, `test/corpus/`
- `STATUS.md` — D3, D14
