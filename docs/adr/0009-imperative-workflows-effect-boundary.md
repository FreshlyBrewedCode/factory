# 0009. Imperative workflows, and where Effect stops (D1, D2, D4, D13)

## Status

Accepted. Decided 2026-09-13 in the first research pass and the pre-spike design session;
**recorded here 2026-09-17**, when the decision register (`docs/decisions.md`) was retired in
favour of ADRs plus GitHub issues. Nothing below is new — every phase since was built on it, and
phases 0–5 shipped without falsifying any of it.

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

## Consequences

- **The daemon cannot know a workflow's shape before it runs.** D1 buys ergonomics by giving up
  static structure: there is no graph to render, no step count to show, no dry run. Issue #11 pays
  part of this back with a static-analysis outline over `ctx.*` call sites — an approximation that
  degrades honestly, not a change to the authoring surface.
- **A workflow's control flow is invisible to the event log until it happens.** This is why ADR
  0003's log is append-only and emitted by the runtime rather than declared up front, and why the
  UI is a thin client over it.
- **Two idioms live in one repo,** and the split has to be stated rather than felt: Effect inside
  `runtime/` and the dispatcher, plain async everywhere an author or a request handler can see.
  Reviews should ask which side of the seam a new file is on.
- **The write-back gap is permanent as long as D2 holds.** Anything the agent layer learns to do
  with git is something we already do; the duplication is accepted in exchange for owning the PR.
- **`ctx` grows rather than the authoring model changing.** Every widening since — `ctx.output`,
  and `ctx.dispatch` in epic #19 — has been a new member on a plain function's context, which is
  the shape D1/D13 predicted.
