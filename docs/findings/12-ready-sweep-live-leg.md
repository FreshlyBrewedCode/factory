# 12 — The Ready-sweep live leg (issue #18)

2026-09-16, on branch `feat/retire-dispatch-18`. The sweep ran against the real GitHub
Project board (`FreshlyBrewedCode/factory-spike dispatch`, project number **4**, Status
options `311093b9`=Ready / `99ec82f6`=In Progress / `cbe8f45b`=Done) with a real daemon
(`factory serve --config .factory/live-leg-18.config.ts --db .factory/live18.db`), the
sample workflows (`sample/workflows/ready-sweep.ts` on a scratch workspace,
`implement-issue.ts` as the child), and the board item `PVTI_lAHOALOhUc4BjbMMzg60cE0`
(factory-spike#1, slugify).

## What was proven live

1. **The scheduled wrapper fires on the daemon's scheduler** (`runOnStart` leg): the
   sweep started, ran `gh api graphql` in its scratch dir, parsed the real board and found
   0 Ready items (the item was on Done at the time) → `RunFinished` in 856 ms with
   `dispatched: []`. Real query, real board, no clone (workspaceKind `scratch`).
2. **Manual-trigger sweep dispatches a real nested child**: with the item moved to Ready,
   `POST /api/schedules/ready-sweep/run` started the sweep; its log shows the real
   GraphQL result (`readyCount: 1, issueNumber: 1`), then
   `RunDispatched{childRunId: run-38d3296f…, childWorkflowId: implement-issue,
   input: {issueNumber: 1}, dedupeKey: "issue:1"}`, then `RunFinished` in 876 ms. The
   child is a first-class run (clone workspace, `scheduleId: none` — it is a dispatch
   child, not a scheduled fire).
3. **Two consecutive sweeps over the same Ready item dispatch exactly once**: a second
   trigger while the child ran produced `DispatchCollision{key: "issue:1",
   holderRunId: run-38d3296f…}`, a `collision-summary` log naming the holder, and a
   visible `RunFailed` whose message names the key and the holding run. **Zero** new
   dispatches; the collision is also in the second sweep's `RunDispatched`-free log —
   nothing is silently dropped (D39/D40).
4. **Cron ticks behave the same as manual triggers** — earlier in the same daemon
   session (1-minute cron, max concurrency 2, child in flight) every minute-tick fired
   the sweep, which failed at dispatch with `ConcurrencyLimitError` *visibly* (an empty
   failed run per tick is the documented behaviour with backoff out of scope, issue #20).

## What did not complete, and why

The child's own agent round trip (implement → test → PR) did **not** complete live:
the agent step stalled ~10 minutes on the first `TEXT_MESSAGE_CONTENT` chunk in two
independent runs (run-97766379… and run-38d3296f…, both needlessly cancelling: root
cause is the provider corridor, not factory code —

```
$ opencode run -m opencode-go/deepseek-v4.1-flash "say hi"
Error: The latest version of this model is only available hosted in China
and requires explicit opt in: https://opencode.ai/workspace/wrk_01KREH…/go
$ opencode run -m opencode-go/glm-5.3-flash "Reply: corridor-ok"   # returns empty
```

— i.e. the `opencode-go` gateway wall changed for these models today (2026-09-16),
outside this session's control). The agent path itself remains live-validated by
phases 0–5 (`docs/findings/3-live-e2e-run.md`, `11-phase5-live-leg.md`); nothing in
#18 touches it. Before cancelling the stalled child we also hit a genuine defect the
leg exposed for later: `POST /api/runs/:id/cancel` never resolves while the agent
step's stream is wedged — `handle.cancel()` waits on a `resultPromise` that never
finishes, so the HTTP cancel request hangs (observed twice, request never completed;
the process had to be killed). Filed below.

## Residue found by the leg (not #18's scope)

- **Cancel is not unstickable.** Cancelling a run whose agent stream is hung blocks
  forever — the SSE stream's rupture never wakes `startRun`'s await chain. Phase 6
  cancellation-hardening candidate alongside the existing stream-liveness fix.
- The 1-minute cron with a hung provider produces one failed sweep run per tick —
  noise until issue #20's backoff (explicitly out of scope for #18).

Conclusions → D43 (`docs/decisions.md`); the retirement itself is ADR 0004's
supersession + `docs/phases-completed.md`'s phase 3 section unchanged as history.
