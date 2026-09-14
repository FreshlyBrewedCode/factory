# Findings

Evidence log for the spike and design work described in `STATUS.md`, one document per subtask.
Each is written for a reader who was not there — every claim cites the exact source file/line or
the exact NDJSON/`ps`/`git` output it's based on, not just "the docs say".

Conclusions drawn from this evidence live in `docs/adr/`, not here, so that a wrong conclusion
can be revised without losing the measurements.

## Phase 0 — spike

| Document | Subtask | Headline finding |
|---|---|---|
| [`0a-1-single-agent-step.md`](./0a-1-single-agent-step.md) | One opencode agent step through `@tanstack/ai` + `localProcessSandbox` | `workspace.source` is dead code for `localProcessSandbox`; the provider's `dir` option is what pins the sandbox in place, and reading the installed packages resolved most of phase 0's open questions about CUSTOM events, structured output, and permissions. |
| [`0a-2-round-trip.md`](./0a-2-round-trip.md) | The full eight-step round trip: clone, implement, test, fix, test, PR metadata, write-back, open PR | The round trip ran green end-to-end and opened a real PR with agent-generated title/body (tier 1, confirmed at runtime); the strengthened step-4 assertion confirmed the fix step's own sandbox re-bootstrap does not destroy or revert tracked files. |
| [`0b-effect-boundary.md`](./0b-effect-boundary.md) | The Effect v4 ↔ TanStack AI boundary: does fiber interruption kill the opencode process? | Interruption reliably killed the process in all 4 runs — but it also died in the control condition with no explicit `abort()` wired, via `Stream.fromAsyncIterable`'s own scope-finalizer, refining (not confirming as originally stated) fact F4. |

Conclusions → [`adr/0001-write-back-isolation-effect-boundary.md`](../adr/0001-write-back-isolation-effect-boundary.md).

## Phase 1 — workflow runtime

| Document | Subtask | Headline finding |
|---|---|---|
| [`1-event-type-corpus-analysis.md`](./1-event-type-corpus-analysis.md) | D3's event type, designed against the nine recorded NDJSON corpora | Chunk timestamps are not a valid ordering key — `sandbox.file` chunks are back-dated by up to 1473 ms because they carry an mtime — and cancellation emits no chunk at all, so both ordering and termination must be Factory's to record. The chunks themselves are AG-UI protocol, whose transport and client TanStack already ships. |
| [`2-sandbox-reuse-nonce-probe.md`](./2-sandbox-reuse-nonce-probe.md) | D10 in isolation: does the working tree survive a fresh-session boundary, independent of any workflow's own prompts? | Confirmed, live, three runs: a nonce written to disk by session 1 was read back correctly by session 2 (same `threadId`/`dir`, no shared transcript) — both from the read tool's own `TOOL_CALL_RESULT` and from the host filesystem directly. |

Conclusions → [`adr/0003-run-event-type.md`](../adr/0003-run-event-type.md) (D10 itself is recorded in `STATUS.md`'s decision table; this probe adds confirming evidence, no new decision).

## Phase 2 — persistence & lifecycle

| Document | Subtask | Headline finding |
|---|---|---|
| [`4-crash-mid-run-recovery.md`](./4-crash-mid-run-recovery.md) | `SIGKILL` mid-`ctx.exec`, then reopen the same sqlite file | The partial history survives intact and reads back as `"interrupted"` — derived at read time, since nothing observes the crash as it happens. |

Conclusions → D21 in `STATUS.md`; no ADR (plain synchronous sqlite, no Effect layer to bridge).

## Phase 3 — server & dispatch

| Document | Subtask | Headline finding |
|---|---|---|
| [`6-live-dispatch-run.md`](./6-live-dispatch-run.md) | A real `factory serve --dispatch-*` run against a real GitHub Project | The dispatcher claimed a Ready issue unattended and opened a real PR — and the run exposed a genuine stray-artifact bug (`git status --porcelain` collapsing a new directory), fixed by D25. |

Conclusions → [`adr/0004-server-dispatch.md`](../adr/0004-server-dispatch.md) (D22–D25).

## Phase 4 — web UI

| Document | Subtask | Headline finding |
|---|---|---|
| [`7-phase4-ui-prototype-refinement.md`](./7-phase4-ui-prototype-refinement.md) | One refinement pass over the throwaway phase 4 mock, section by section | Presentation-only: nav became a category menu, runs a chronological table, run detail dropped the pipeline strip, the step list gained an indexed spine and a dedicated time column, and step detail moved into collapsed disclosures with a full-panel transcript. |

No ADR — the mock is throwaway and carries none of the stack; decisions are listed in the finding
and the phase 4 section of `STATUS.md`.

## Distribution

| Document | Subtask | Headline finding |
|---|---|---|
| [`8-raw-ts-npm-shim-spike.md`](./8-raw-ts-npm-shim-spike.md) | How to publish a Bun-only, raw-TypeScript CLI to npm | `bunx`/`npx` honor a bin's shebang, so the launcher must declare `#!/usr/bin/env bun`; a `node` shebang makes `bunx` run Node and the Bun branch unreachable. |

Conclusions → [`adr/0005-raw-typescript-distribution.md`](../adr/0005-raw-typescript-distribution.md).

