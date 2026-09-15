# 9. Phase 5 P1 — per-run working trees and the admission limit, landed

2026-09-15, branch `feat/phase-5`. Implements D27 (config module), D28 (per-run working trees)
and D29 (one admission function). Evidence lives in the P1 tests; this document records the
shape chosen and the deviations, written for a reader who was not there.

## What was built

| Path | What it is |
| --- | --- |
| `src/config.ts` | `defineConfig` / `loadFactoryConfig` / `toRunEnvironment` (D27). Defaults: `workspaceRoot` `.factory/workspaces`, `maxConcurrentRuns` 3, `retainedWorkspaces` 10 |
| `src/lib/workspace.ts` | D28's allocator: mirror refresh (mutex per mirror path) → per-runId clone → last-N eviction (oldest-first, by `mtime`) |
| `src/server/admission.ts` | D29's `admitRun(maxConcurrentRuns, activeRunCount)` — pure, shared |
| `src/server/runs.ts` | `startTrackedRun` now async; without an explicit `dir` it allocates a workspace, so the shared start path owns tree creation for both the API and the dispatcher |
| `src/server/http.ts` / `daemon.ts` / `dispatch.ts` | `runEnv` plumbed; 409 over the limit; `ReconcileDeps` swapped from `hasActiveRun(): boolean` to `maxConcurrentRuns` + `activeRunCount()` through `admitRun` |
| `src/cli.ts` | `factory serve --config <path>` |

## Choices and deviations

- **The mirror lives inside the workspace root** (`<workspaceRoot>/.mirror.git`), as ADR 0005
  sketched. Eviction filters it out of the mtime sort, so the mirror is never a survivable tree
  candidate.
- **Mirror refresh goes through `git remote update --prune`**, not a re-clone; first allocation
  creates the mirror with `git clone --mirror`. A stale-mirror-from-a-different-sshUrl hazard is
  accepted: the config binds one repo per daemon (D27), so the mirror never changes provenance.
- **Allocation mutex is in-process** (a promise queue keyed by mirror path). Concurrent
  allocations from the same daemon serialize only the refresh; clones and eviction touch distinct
  `runId` directories. A second daemon process sharing the same workspace root would race the
  mirror refresh — out of scope for a POC, noted as a limit.
- **Backward compatibility is deliberately total**: with no `runEnv` configured, the server keeps
  the phase 3 contract (`POST /api/runs {workflowPath, dir, clone}`), no limit, legacy dispatch
  wiring including `resetClone`. The dispatcher keeps supplying real filesystem paths (D31).
- **`startTrackedRun` became async** — allocation is one or two git invocations. Call sites
  (`http.ts`, `daemon.ts`, `integration.test.ts`) all awaited it in the same pass.

## Validation

`src/server/concurrency.test.ts` (two tests):

1. Two runs started concurrently via real `fetch` against `serve()` over Bun.serve, slow-fake
   adapters, a real sqlite store, and a local seed repo standing in for the configured `sshUrl`
   (a plain local path — `git clone` accepts local paths, so no network). Asserts 201+201, both
   trees exist under the workspace root named by their runIds, each tree contains only its own
   marker files, both reach `RunFinished` in the store, the two `RunStarted` events point at two
   distinct directories, and the final files land in the right tree.
2. Admission at the HTTP boundary: `maxConcurrentRuns: 1`, first start 201, second start 409
   while the first is in flight, and a third start 201 after the first reaches a terminal state.

Plus the boundary tests the plan required at their own seams: `admission.test.ts` (pure
function: below/at/over the limit; limit 1 reproduces D24's old WIP behaviour) and a
`dispatch.test.ts` case over `maxConcurrentRuns: 2` with `activeRunCount() === 2` — the pass is
skipped (`skipped-wip-limit`), no claim consumed.

Full suite at the time of commit: `bun test` 96 green, `bun run typecheck` and `bun run lint`
(exit 0; advisory `effecttsgo` warnings only) clean.

**Not covered here:** the between-two-live-runs-in-the-browser playwright leg; it rides with
phase 5's exit criterion (P6), where the live leg exercises concurrency anyway.
