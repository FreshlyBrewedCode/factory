# Finding 6 — phase 3's live dispatch run

**Date:** 2026-09-14
**Run:** `run-239ecffa-b909-4637-874d-ae94cc07458c`, via `factory serve --dispatch-*` against a
real GitHub Project
**Result:** [factory-spike#5](https://github.com/FreshlyBrewedCode/factory-spike/pull/5), OPEN —
but see "The bug this run shipped" below before treating it as clean evidence

## What ran

No GitHub Project existed yet for `factory-spike`, so one was created: project #4
("factory-spike dispatch", `PVT_kwHOALOhUc4BjbMM`), with its default "Todo" Status option
renamed to "Ready" (`311093b9`) via a `updateProjectV2Field` GraphQL mutation — matching the
wayful script's expected Status vocabulary (D23). Issue #1 was added to the project and set to
Ready.

`factory serve` was started with the full `--dispatch-*` flag set (`DispatchWiring` —
`src/server/daemon.ts`) pointed at this project. `Effect.repeat(Schedule.spaced(...))` ran the
wrapped effect immediately on the first tick, not after waiting one interval: the dispatch loop
claimed issue #1 (moving its Status to "In Progress") and started a run within seconds of the
process starting, confirmed by `[dispatch] {"action":"dispatched","issueNumber":1,"runId":"run-
239ecffa-b909-4637-874d-ae94cc07458c"}` on stdout.

Routine reconcile passes are silent by design (`runDispatchLoop`'s `console.log` only fires for
non-routine actions), and `RunFinished` is never printed to stdout — it is an internal
`RunEvent`, not a console line. Completion was confirmed instead via
`GET /api/runs/:id` (HTTP polling), which reported `"status":"RunFinished"` with a `prUrl` once
`workflows/implement-issue.ts` finished running for real against opencode.

## Relation to the phase-3 exit criterion

STATUS.md's phase 3 exit criterion has two legs:

1. ✅ **Fakes/replay-provable**: unattended pickup, run to completion, SSE watchability, WIP-limit
   enforcement — `src/server/integration.test.ts` (ADR 0004).
2. ✅ **This run** — the same cycle live: the daemon picked up a Ready issue unattended, ran
   `workflows/implement-issue.ts` against real opencode, and opened a real PR
   (factory-spike#5), with a matching `RunFinished` event carrying `prUrl`. The write-back call
   path itself was already proven live in phase 1 (`docs/findings/3-live-e2e-run.md`); what this
   run adds is that the *dispatcher* drives that call unattended, not a human running `factory run`
   directly.

Both legs are now satisfied.

## The bug this run shipped

PR #5 contains a stray file it should not: `tmp/factory-live-dispatch/work/issue-1/.tanstack-
projected-1e95f9272dfe038f`, the D16 marker artifact `cleanStrayArtifacts` (`src/lib/
writeback.ts`) exists specifically to catch and remove before anything is staged.

Root cause: `cleanStrayArtifacts` matches individual paths from `git status --porcelain` against
`STRAY_ARTIFACT_PATTERNS` (`/\.tanstack-projected-/`, `/^data(\/|$)/`). Plain `--porcelain`
(without `--untracked-files=all`) collapses a **wholly new, never-before-tracked directory**
into a single `?? dir/` summary line instead of enumerating the files inside it — standard git
behavior, not a factory-specific bug. This run's D16 marker landed at a bogus, absolute-host-path-
concatenated location (D16's known failure mode) that happened to fall under a directory git had
never seen before (`tmp/factory-live-dispatch/work/issue-1/`, from this run's `--dispatch-work-
dir`), so `git status --porcelain` reported it as `?? tmp/` — a path matching neither stray-
artifact pattern. The marker slipped through undetected, got `git add`ed, and shipped into a
real, public PR.

Reproduced deliberately in a throwaway repo (`/tmp/strayrepro`): a nested file under a fresh
directory shows as `?? dir/` under plain `--porcelain` and as the full nested path under
`--porcelain --untracked-files=all`. Prior live/replay runs used directory structures where the
marker's parent directory was already tracked or previously seen by git, so this collapsing case
was never exercised before.

**Fix:** `porcelainPaths` (`src/lib/writeback.ts`) now passes `--untracked-files=all`, forcing
git to always enumerate individual file paths regardless of whether their parent directory is
new. Pinned by `src/lib/writeback.test.ts`, which reproduces the exact directory shape this run
produced and asserts `cleanStrayArtifacts` removes the marker and `git status --porcelain
--untracked-files=all` reports clean afterward.

This is a genuine, previously-latent defect in code already validated against fakes — the
existing test suite's directory shapes never happened to trigger git's collapsing behavior. It
was found by the live leg specifically, not by anything the fakes-provable half of phase 3 could
have caught, since `cleanStrayArtifacts` was never exercised against a wholly-new untracked
directory in any prior test.

PR #5 itself has not been amended or closed — it is left as live evidence of both the exit
criterion (a real, unattended dispatch → PR cycle) and the bug it happened to surface, pending a
decision on how to handle it.
