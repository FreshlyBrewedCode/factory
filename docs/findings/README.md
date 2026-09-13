# Phase 0 findings

Evidence log for the phase-0 spike work described in `STATUS.md`, split into one document per
spike subtask. Each is written for a reader who was not there — every claim cites the exact
source file/line or the exact NDJSON/`ps`/`git` output it's based on, not just "the docs say".

| Document | Subtask | Headline finding |
|---|---|---|
| [`0a-1-single-agent-step.md`](./0a-1-single-agent-step.md) | One opencode agent step through `@tanstack/ai` + `localProcessSandbox` | `workspace.source` is dead code for `localProcessSandbox`; the provider's `dir` option is what pins the sandbox in place, and reading the installed packages resolved most of phase 0's open questions about CUSTOM events, structured output, and permissions. |
| [`0a-2-round-trip.md`](./0a-2-round-trip.md) | The full eight-step round trip: clone, implement, test, fix, test, PR metadata, write-back, open PR | The round trip ran green end-to-end and opened a real PR with agent-generated title/body (tier 1, confirmed at runtime); the strengthened step-4 assertion confirmed the fix step's own sandbox re-bootstrap does not destroy or revert tracked files. |
| [`0b-effect-boundary.md`](./0b-effect-boundary.md) | The Effect v4 ↔ TanStack AI boundary: does fiber interruption kill the opencode process? | Interruption reliably killed the process in all 4 runs — but it also died in the control condition with no explicit `abort()` wired, via `Stream.fromAsyncIterable`'s own scope-finalizer, refining (not confirming as originally stated) fact F4. |

The conclusions drawn from this evidence — the write-back strategy, the isolation model, the
Effect boundary decision, and which pre-phase-0 open questions turned out to be wrong — live in
[`docs/adr/0001-write-back-isolation-effect-boundary.md`](../adr/0001-write-back-isolation-effect-boundary.md),
not here.
