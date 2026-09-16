# 0004. Phase 3's server & dispatch — D22 (plain `Bun.serve`), D23 (pluggable `ReadySource`), D24 (event-log-derived backoff, in-process WIP limit)

## Status

**Partially superseded 2026-09-16 (D43, issue #18).** The epic #19 end state retired the hardcoded
dispatcher: `src/server/dispatch.ts`, `src/server/ready-source.ts` (the D23 `ReadySource`
abstraction, real and fake), the event-log backoff and the daemon's `--dispatch-*` wiring are
deleted, and the Ready sweep now lives in the sample project's scheduled wrapper workflow
(`sample/workflows/ready-sweep.ts`), dispatched by the #16 scheduler. D22 (plain `Bun.serve`)
stands; D23/D24 are this ADR's retired machinery. Evidence for the retirement:
`docs/findings/12-ready-sweep-live-leg.md`.

Accepted, 2026-09-14. Validated against fakes end-to-end
(`src/server/integration.test.ts`, `src/server/dispatch.test.ts`, `src/server/http.test.ts` —
49/49 tests passing, repeated 4x with no flakiness, `typecheck`/`lint` clean), **and live**: a
real unattended `factory serve --dispatch-*` run against a real GitHub Project picked up an
issue and opened a real PR, [factory-spike#5](https://github.com/FreshlyBrewedCode/factory-spike/pull/5)
(`docs/findings/6-live-dispatch-run.md`), confirmed with the user first, same precedent as phase
1's live E2E leg (`docs/findings/3-live-e2e-run.md`). That run also surfaced and fixed a genuine
stray-artifact bug (D25, `src/lib/writeback.ts`) — see Consequences.

## Context

Phase 3 is AGENTS.md's third column: "server/daemon that handles lifecycle and automatic
dispatch." Three things needed deciding that STATUS.md left open: where the HTTP/SSE API sits
relative to Effect (D4 says "Effect owns the server" — but D21 already carved synchronous
sqlite I/O out of that scope, so the same question recurs here), what "pluggable source" means
concretely for the dispatcher for wayful-script parity, and how to port the wayful script's
claim-lock/WIP-limit/pause-on-failure/backoff semantics onto a system that has no resumable
"continue this run" concept.

Not re-litigated here: D3/D20 (the event type this all reads/writes), D4 (Effect owns the
server — this ADR is about *where inside* "the server" Effect's boundary actually falls, not
whether it applies), D12 (crash recovery deprioritized — informs D24's "interrupted ≠ active"
rule), D21 (plain synchronous functions over `bun:sqlite`, no `runs`/`steps` tables — the same
reasoning is reapplied in D22), and `docs/research/2026-09-13-pre-spike-reading.md` (the wayful
script this phase ports from).

## Decision

### D22 — Plain `Bun.serve` for HTTP + SSE, not Effect

`src/server/http.ts`'s route handler and SSE stream (`createHandler`, `sseStream`) are plain
functions over `Request`/`Response`/`ReadableStream`, wired with `Bun.serve`. No `Effect.gen`,
no `HttpApi`.

This is D21's reasoning applied a second time: request/response handling here is synchronous
callback-shaped work with nothing for Effect to bridge — one request in, one response (or one
stream) out, no retry policy, no scheduled repetition. Effect's actual job in phase 3 is
`src/server/dispatch.ts`'s `runDispatchLoop`, a genuine long-running, repeating process
(`Effect.repeat(Schedule.spaced(...))`) — the kind of thing D4 means by "Effect owns ...
scheduling." Wrapping the HTTP layer in Effect would add a translation layer (`HttpApi`'s
route/handler DSL, `Effect.gen` over what is already a single `await`) that buys nothing here
and costs ergonomics, the same trade D21 already made for `store.ts`.

The SSE stream has one genuine hazard, independent of Effect-vs-plain: replay-then-tail must
not drop a live event that lands between subscribing to the pubsub channel and finishing the
persisted-history read. `sseStream` subscribes first, buffers anything that arrives before the
persisted read completes, then drains the buffer de-duplicated by `seq` (`event.seq <= lastSeq`
is dropped) once the read is done. This is ordinary async-code care, not something Effect would
have prevented or simplified.

### D23 — `ReadySource`: a two-method pluggable interface, ported from the wayful script

```ts
interface ReadySource {
  listReady(): Promise<ReadonlyArray<ReadyItem>>;
  claim(item: ReadyItem): Promise<boolean>;
}
```

`makeGitHubProjectsSource` implements it against the same GraphQL query and
`gh project item-edit --single-select-option-id` claim the wayful script uses, including the
same soft/hard blocker distinction (an open blocker with an OPEN-or-MERGED linked PR does not
hard-block). `makeFakeReadySource` is the deterministic in-memory counterpart for
`dispatch.test.ts`/`integration.test.ts`, matching the `ExecFn`-injection pattern already used
for `hostExec` elsewhere in the codebase.

The interface is deliberately this thin. `claim` returning `false` is not an error channel —
it's the same signal the wayful script treats as "lost the race or hit the WIP limit, skip",
so `reconcileOnce` treats a failed claim as `{action: "skipped-claim-failed"}` and moves on
rather than surfacing it as a fault. The GitHub Projects implementation is the only one wired
into `startDaemon` today; the interface exists so a second source (e.g. a different tracker) is
an implementation, not a redesign of the dispatcher.

One fidelity point the fake initially missed and the tests caught: the real source's
`listReady` naturally stops returning an item once its claim moves the Project's Status field
off "Ready" (the same GraphQL query no longer matches it). `makeFakeReadySource` had to filter
`listReady`'s result by `claimedItemIds` to mirror that — without it, a second reconcile pass
in a test would re-see and re-claim an already-claimed item, a divergence from production
behavior that only a test written against the real state-machine semantics (not just against
the interface's types) surfaced.

### D24 — No separate retry-state file; backoff derived from the event log; WIP limit via in-process registry

The wayful script tracks retry backoff in a TSV file keyed by thread id, and pauses *all*
dispatch globally the moment any thread has a failed status. Factory does neither.

**Backoff is derived, not stored.** `RunStarted.input.issueNumber` is the join key into
`listRuns`/`getRunEvents` (already persisted per D21) — `historyForIssue` walks a run's own
event rows to find its last terminal status, when it finished, and how many consecutive
failures precede it. There is no second store that could drift from the log it would be
caching. The backoff window itself doubles per consecutive failure
(`backoffBaseMinutes * 2 ** (consecutiveFailures - 1)`, capped at `backoffCapMinutes`, matching
the wayful script's constants of 15 minutes base / 1440 minutes cap) — note the `- 1`: this
function is only reached once `consecutiveFailures >= 1`, so the first failure should back off
by exactly the base amount, not double it immediately. (This off-by-one was a real bug caught
by `dispatch.test.ts`, not a hypothetical — see Consequences.)

**WIP limit of 1 is enforced via the current process's in-memory active-run registry**
(`src/server/runs.ts`'s `active` Map, exposed as `activeRunIds()`/`isActive()`), not derived
from sqlite. This is D12's "interrupted ≠ active" rule applied to dispatch specifically: a run
whose process died mid-flight is `"interrupted"` when read back, not a live run blocking new
dispatch — so a restart doesn't wedge the dispatcher behind a run nothing is still executing.

**Per-issue backoff replaces the wayful script's global pause-on-any-failure.** This is a
deliberate simplification, forced by a real difference between the two systems: the wayful
script's threads are resumable (a paused thread can later `continue`), so pausing globally on
any failure is a deliberate "stop and let a human look" gate before more threads pile onto a
possibly-systemic problem. Factory's workflows are one-shot `async` functions (D19) with no
resumable "continue this run" concept — a retry is necessarily a fresh run from scratch. Global
pause-on-any-failure would therefore starve every unrelated Ready issue for the sake of one
issue's problem, with no offsetting benefit (there's no paused-thread state to protect). Backoff
scoped to the specific failing issue gets the "don't hammer a broken thing" property without
that cost.

`reconcileOnce` (`src/server/dispatch.ts`) is a plain `async` function — same D21-style
reasoning as D22: the decision logic (check WIP limit, list ready items, skip hard-blocked,
skip still-backing-off, claim, dispatch) is synchronous-shaped async/await with nothing for
Effect to bridge, and being a plain function is what makes it directly unit-testable without
firing up a `Schedule`. `runDispatchLoop` is the thin Effect wrapper around it — `Effect.repeat`
over `Schedule.spaced(intervalMs)`, with a typed `ReconcileError` (`Schema.TaggedError`,
matching D18/the `agent-step.ts` precedent) catching whatever `reconcileOnce` throws so the
scheduled loop logs and continues rather than dying on one bad reconcile pass.

## Consequences

**Benefits.** The HTTP/SSE layer stays as simple as D21 predicted a synchronous-I/O layer
would; the only genuine hazard (SSE replay-then-tail ordering) is handled with ordinary
subscribe-before-read buffering, not framework machinery. `ReadySource` makes the dispatcher
testable without live `gh` calls, and the fake/real fidelity gap (claimed items must
disappear from `listReady`) was caught before it could hide a bug in production. Backoff having
no second store means there is nothing to keep in sync with the event log, and per-issue scope
means one broken issue never blocks unrelated work — a real improvement on the wayful script's
behavior for Factory's shape, not just a workaround for the lack of resumability.

**Costs and risks, stated plainly:**

- **WIP-limit enforcement is scoped to one process.** If Factory ever runs as more than one
  daemon process against the same sqlite file, `activeRunIds()` in process A has no visibility
  into a run process B started, and the WIP limit of 1 becomes a per-process limit of 1 (i.e.
  N processes ⇒ up to N concurrent runs). Nothing in phase 3 runs multiple daemon processes
  against one db, so this is latent, not live — but it is a real trigger to revisit before any
  horizontal scaling of the daemon itself.
- **`historyForIssue` re-walks every run's events on every reconcile pass to find the ones
  matching an issue number** (`listRuns` then `getRunEvents` per run, filtered by
  `RunStarted.input.issueNumber`). This is a full-log scan with no index on `issueNumber`,
  acceptable at POC scale (a handful of runs) but a query planner would want a real index at
  any serious volume.
- **The backoff-doubling formula's off-by-one was a genuine bug**, not merely a hypothetical
  risk — `dispatch.test.ts`'s backoff-doubling-per-consecutive-failure test caught
  `2 ** consecutiveFailures` immediately double-backing-off on the very first failure instead
  of applying the base delay. Fixed to `2 ** (consecutiveFailures - 1)`. Left here as a record
  that the exponent's off-by-one direction is easy to get wrong and worth a test, not just a
  read-through.
- **Per-issue backoff, not global pause, means Factory will keep retrying a systemically broken
  workflow (e.g. a broken opencode credential) once per issue, capped at the backoff ceiling,
  rather than stopping entirely for a human to notice.** The wayful script's global pause exists
  partly as that circuit breaker. Factory has no equivalent yet — accepted here because there is
  no resumability to protect, but if runs start being noticeably expensive (cost, not just
  wall-clock) a repeated-systemic-failure circuit breaker is a real gap, not a hypothetical one.
- **The "opens a PR" leg of phase 3's exit criterion is now validated live**
  (`docs/findings/6-live-dispatch-run.md`), but the live run exposed a real defect that no test
  against fakes had triggered: `cleanStrayArtifacts`'s stray-path matching operates on
  `git status --porcelain` output, and plain `--porcelain` collapses a wholly-new untracked
  directory into a single `?? dir/` summary line rather than enumerating the files inside it.
  This run's D16 marker happened to land under a directory git had never seen before, so it went
  undetected and shipped into the real PR (factory-spike#5). Fixed by passing
  `--untracked-files=all` (D25), pinned by `src/lib/writeback.test.ts`. The PR itself was left
  unamended — a decision for the user, not something to fix unilaterally on a real, shared,
  already-visible PR.

## References

- `src/server/http.ts`, `src/server/http.test.ts` — D22
- `src/server/ready-source.ts` — D23
- `src/server/dispatch.ts`, `src/server/dispatch.test.ts` — D24
- `src/server/integration.test.ts` — the fakes/replay-provable half of phase 3's exit criterion
- `src/server/runs.ts` — the in-process active-run registry D24 depends on
- `src/server/daemon.ts` — `startDaemon`, where `http.ts` and `dispatch.ts` are wired together
- `docs/research/2026-09-13-pre-spike-reading.md` — the wayful script this phase ports from
- `docs/adr/0001-write-back-isolation-effect-boundary.md`, `0003-run-event-type.md` — D21's
  precedent for D22, and the event log D24's backoff derivation reads
- `STATUS.md` — D4, D12, D19, D21, phase 3's exit criterion
