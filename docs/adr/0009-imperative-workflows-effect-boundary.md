# 0009. Imperative workflows, and where Effect stops (D1, D2, D4, D13)

## Status

Accepted. Decided 2026-09-13 in the first research pass and the pre-spike design session;
**recorded here 2026-09-17**, when the decision register (`docs/decisions.md`) was retired in
favour of ADRs plus GitHub issues. Nothing below is new — every phase since was built on it, and
phases 0–5 shipped without falsifying any of it.

**Amended 2026-09-18** (§5 below), after an audit of where Effect actually earns its place. D1, D2
and D13 are untouched. D4's boundary moves in one direction only — Effect gains the CLI and gains a
dependency-injection composition root inside the daemon — and the two places the boundary was
tightened (D21's store, D22's HTTP handlers) are explicitly reaffirmed, not reopened.

## Context

These four are the decisions the project starts from, and they are the ones later ADRs lean on
without re-arguing: ADR 0002 ("not re-litigated here, decided earlier: D1, D4"), ADR 0003 ("not
re-litigated here: D1, D3, D4, …"), ADR 0004 ("D4 says Effect owns the server — but D21 already
carved synchronous I/O out"). All three pointed at a decision table in `STATUS.md` for the
reasoning. That file is gone, so the reasoning needs a home that outlives it.

## Decision

### 1. Workflows are imperative plain TypeScript (D1)

A workflow is `async (ctx, input) => {...}` — `await`, `if`, `try`/`catch`, early returns. No step
graph, no declarative DSL, no YAML. Ergonomics are the entire point of column 1: this is what makes
the model borrowed from mattpocock/sandcastle pleasant, and a retry or a conditional fix step is an
ordinary language construct rather than a framework concept.

The registration surface around the function stays minimal (D5): a module exports an `id`, an input
schema, and the function. That is enough for the daemon to enumerate and validate workflows; it is
deliberately not a description of what the function will do.

### 2. Effect owns the server; authoring stays plain async (D4)

Effect's jobs are the run lifecycle (fiber interruption as cancellation, ADR 0001 §4) and the
dispatcher's scheduling loop. It does **not** cross into the authoring surface: `ctx.exec`,
`ctx.writeBack` and `ctx.agent` are plain async functions, because Effect-ifying them costs exactly
the ergonomics D1 exists to buy. The runtime (`src/runtime/run.ts`) is the bridge between the two.

The boundary was later drawn tighter twice, in the same direction, and both times the tighter line
held: synchronous callback-shaped I/O with nothing to bridge stays plain — the event store
(D21, ADR 0010) and the HTTP/SSE handlers (D22, ADR 0004).

### 3. Factory owns git write-back; TanStack AI is inbound only (D2)

Branch, commit, push and PR are ours, via `gh`. Forced by a gap — the agent-sandbox layer's
workspaces cover clone and bootstrap and stop there — and it fits dispatch better than a
merge-to-head model would: the pull request is exactly the artifact a downstream blocker check
reads. The mechanism, and why write-back is a deterministic workflow step rather than an agent
instruction, is ADR 0001 (D8/D9).

### 4. Three pieces, from the spike onward (D13)

Workflow script → imported utilities → a runtime that executes the workflow. The seam between "what
an author writes" and "what runs it" was load-bearing in phase 0 already (runs 0a-1, 0a-2, 0b) and
is what phase 1 inherited as `defineWorkflow` + `startRun`.

### 5. Amendment 2026-09-18 — the CLI and the composition root move inside

§2 drew the boundary as "Effect owns the run lifecycle and the scheduling loop." An audit after the
POC phase found that reading had produced two gaps that are costs, not savings.

**The CLI moves in.** `src/cli.ts` hand-rolled four argument parsers that disagreed with each other
(a stride-2 flag walker that structurally cannot represent a boolean flag, a separate single-step
loop for `factory start` that needed one, an inline loop for `init`, and a `parseServeArgs` that
passed an unvalidated `Number(portRaw)` straight to `Bun.serve`), plus a hand-maintained `USAGE`
string that drifts by construction. Because `usageError` calls `process.exit` inside a parser, the
entire argv layer was untestable and untested — every CLI test bypasses argv and calls the command
functions with structured options. `effect/unstable/cli` replaces all of it and makes argv parsing
an ordinary Effect that a test can run. This is not "Effect for its own sake": it is the one place
where the thing Effect replaces was demonstrably defective.

**Dependency injection moves in, at the daemon's composition root only.** The codebase had already
built a hand-rolled DI container out of optional fields — six `Injectable for tests` comments, a
`DispatchEnv` bag threaded recursively through the dispatch chain, a `dedupeRegistry?` option that
exists solely because `lib/dedupe.ts` exports a process-wide singleton, a `now?: () => number`
clock seam, and a `beforeStart?: () => Promise<void>` hook whose only job is to hold a window open
in one test. Four module-level mutable maps (`server/runs.ts`'s `active`, `server/pubsub.ts`'s
`subscribers`, the dedupe registry, `lib/workspace.ts`'s `refreshGates`) mean two daemons cannot
coexist in one process. `Layer` + `Context.Service` is what that pattern is, done properly, and the
first service to move is the agent runtime (ADR 0012 §4), where the plumbing is worst.

**What explicitly does not move.** The authoring surface (§2's original rule, unchanged: `ctx.exec`,
`ctx.agent`, `ctx.writeBack` stay plain async, and so does the `AgentAdapter` contract — ADR 0012
§5). The event store (D21/ADR 0010: `bun:sqlite` is synchronous in-process I/O with nothing to
bridge). The HTTP handlers (D22/ADR 0004: request in, response out; the composition root moving
under `Layer` does not make the route callbacks Effects). `effect/unstable/sql`,
`effect/unstable/process` and `effect/unstable/http` are all declined for now — `HttpApi` is
deferred rather than rejected, and its trigger is the API surface growing past what a hand-written
client in `web/api.ts` can mirror without drift.

**Typed errors follow the same logic.** Domain failures are thrown `Error` subclasses matched by
`instanceof` — `ConcurrencyLimitError`, `DispatchCapError`, `DedupeKeyError`, `RunCancelledSignal`.
`server/scheduler.ts` decides whether a missed cron window reads as `skipped-concurrency` or
`fire-failed` on one such `instanceof`, which is a semantic decision resting on an untyped catch.
`Schema.TaggedError` is already used twice in the codebase; applying it to the domain errors is
finishing a pattern, not introducing one.

## Consequences

- **The daemon cannot know a workflow's shape before it runs.** D1 buys ergonomics by giving up
  static structure: there is no graph to render, no step count to show, no dry run. Issue #11 pays
  part of this back with a static-analysis outline over `ctx.*` call sites — an approximation that
  degrades honestly, not a change to the authoring surface.
- **A workflow's control flow is invisible to the event log until it happens.** This is why ADR
  0003's log is append-only and emitted by the runtime rather than declared up front, and why the
  UI is a thin client over it.
- **Two idioms live in one repo,** and the split has to be stated rather than felt. As amended
  (§5), the line is: Effect owns the CLI, the run lifecycle (`runtime/`), the scheduler loop, and
  the daemon's composition root and services. Plain async owns everything an author can see
  (`ctx.*`, `defineWorkflow`, the `AgentAdapter` contract), the event store, and the HTTP route
  callbacks. Reviews should ask which side of the seam a new file is on — and the honest failure
  mode to watch for is not "too little Effect" but shallow Effect spread evenly everywhere, which
  costs the ergonomics of both idioms and buys neither.
- **The write-back gap is permanent as long as D2 holds.** Anything the agent layer learns to do
  with git is something we already do; the duplication is accepted in exchange for owning the PR.
- **`ctx` grows rather than the authoring model changing.** Every widening since — `ctx.output`,
  and `ctx.dispatch` in epic #19 — has been a new member on a plain function's context, which is
  the shape D1/D13 predicted.
