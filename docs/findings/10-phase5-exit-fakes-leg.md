# 10. Phase 5 P6 — exit criterion, fakes leg met (live leg pending)

2026-09-15, branch `feat/phase-5`. Phase 5's exit criterion (P6) has two legs, fakes and live.
This document records the **fakes leg**: the whole validation stack green in one pass on HEAD,
and how each clause of the exit criterion is proven by tests without network or AI. The live
leg — two concurrent real runs started from the browser and watched to real PRs — is gated on
user confirmation and is not yet run; ADR 0005 therefore stays Proposed.

## What P1–P5 each delivered

Pointers to the full records; each is validated on its own fakes leg already.

| Step | Delivered | Evidence |
| --- | --- | --- |
| P1 — per-run working trees + admission | `factory.config.ts`/`src/config.ts` (D27), `src/lib/workspace.ts` (D28's allocator: mirror refresh → per-runId clone → last-N eviction), `src/server/admission.ts` (`admitRun`, D29) consulted by both `POST /api/runs` (409) and `dispatch.ts` | [`9-phase5-p1-workspaces.md`](./9-phase5-p1-workspaces.md); `src/server/concurrency.test.ts` (two concurrent runs through the real server over real sqlite, RunStarted dirs disjoint; admission at the HTTP boundary 201/409/201), `src/server/admission.test.ts`, a `dispatch.test.ts` skip-at-the-boundary case |
| P2 — `GET /api/workflows` | The config's workflow array as the registry, input schemas as JSON Schema (D30) | `src/server/http.test.ts` — registry lists the fixture workflow's id with a JSON-Schema `object` input; no-config path serves `[]` |
| P3 — `POST /api/runs {workflowId, input}` + `factory start` | D31's id-based start (resolve → decode through the workflow's own Schema → admission → config-supplied tree) and the thin HTTP client with `--watch` | `src/server/http.test.ts` — decode-failure 400, unknown id 404, the D29 limit (409 then 201 once a slot frees), the success path (config workspace under a local seed repo, real sqlite, SSE to terminal); `src/cli.start.test.ts` — three real subprocess runs of `factory start` against a real `startDaemon` |
| P4 — start and cancel in the UI | The New-run dialog (D33's single-depth form + raw-JSON escape hatch) and cancel from run detail and running rows; the legs also caught and fixed a disconnect-SSE daemon-kill bug | `e2e/new-run.e2e.ts`, `e2e/cancel.e2e.ts` (below); the fix's regression test in `http.test.ts`; `src/web/lib/start-form.test.ts` pins the projection |
| P5 — `implement-issue` reusable | D32: `branch` moved into the PR-metadata step's structured output, `repoSlug`/`baseBranch` from config, reactive collision retry (suffix with short runId, retry once, report the branch used) | `src/lib/writeback.test.ts` — rejected-push and `gh pr create` "already exists" collision retries against the local bare-repo fixture + the corpus-replay test (`workflows/implement-issue.test.ts`) asserting the end-to-end shape |

## The exit criterion, clause by clause, with the fakes leg's evidence

The criterion: *"a person who has never seen the CLI can start a run from the browser, watch its
transcript stream, cancel it; a script can do the same through `factory start`; and two runs can
be in flight at once."*

**Clause 1 — start, watch, cancel from the browser.** Two playwright specs against the real
daemon (real `factory serve` wiring, a config registry of fixtures, a local seed repo for D28's
workspace allocation, real sqlite, real SSE):

- `e2e/new-run.e2e.ts` — the dialog lists `GET /api/workflows`' registry, the single-depth form
  fills `{issueNumber}`-shaped input, submit POSTs `{workflowId, input}` and navigates to run
  detail where the run runs to `RunFinished` on screen; the raw-JSON fallback leg covers both the
  client-side "invalid JSON" guard and the server's 400 displayed inline.
- `e2e/cancel.e2e.ts` — an in-flight run cancelled from run detail, and a running row cancelled
  from the runs list, both landing `RunCancelled` in the store and reading as cancelled in the UI.
- `e2e/transcript.e2e.ts` — the transcript clause: a replayed step renders text, tool calls and
  reasoning from the event log, and a live slow-fake step's transcript fills in as chunks stream,
  per-step isolated.

**Clause 2 — the same from a script via `factory start`.** `src/cli.start.test.ts` drives
`bun src/cli.ts start` as real subprocesses against a real `startDaemon` over real sqlite:

- POSTing `{workflowId, input}` and printing the returned `runId`;
- `--watch` tails the SSE stream until a terminal event (`RunStarted` → `AgentStepFinished` →
  `RunFinished`, exit 0);
- an unknown workflow id maps the server's 404 to one hint on stderr and a non-zero exit.

Script-side **cancellation** is not a `factory start` verb — `factory start` starts and watches;
a script cancels through the same HTTP endpoint the UI uses
(`POST /api/runs/:id/cancel`, phase 3's contract, covered by `http.test.ts`). The criterion's
"the same" is read here as start-and-watch (the sentence's antecedent), with cancel available to
the script author over plain HTTP; if the live leg's human reviewer reads "cancel" as required of
`factory start` itself, that is a one-verb addition post-phase.

**Clause 3 — two runs in flight at once.** `src/server/concurrency.test.ts` starts two runs
concurrently through real `fetch` against `serve()` over slow-fake adapters and a real sqlite
store: both get 201, both trees exist under the workspace root named by their runIds, each tree
contains only its own markers, both reach `RunFinished`, and the `RunStarted` events point at two
distinct directories. A second test drives the admission boundary at the HTTP surface
(`maxConcurrentRuns: 1`: 201 → 409 while in flight → 201 after terminal). These run against the
real server on real processes, just not through a browser — the criterion's fakes leg allows
exactly this ("provable in `bun test`/playwright without network or AI").

## Validation stack, one pass on HEAD (2026-09-15)

| Command | Result |
| --- | --- |
| `bun test` | 119 pass, 0 fail, 964 expect() calls, 21 files (~12 s) |
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0 — remaining output is advisory `effecttsgo` warnings only (the `load-workflow.ts`/workspace `allow` list unchanged); no findings |
| `nix develop -c bun run test:e2e` | 11 playwright specs passed in one pass (17.1 s), including `new-run.e2e.ts` and `cancel.e2e.ts` |

Nothing broke; no code changes were required this step. The commit here is docs-only.

## What the fakes leg cannot prove (the live leg's questions)

ADR 0005 §"Still unknown after this phase" names them; they are exactly the things fakes cannot
exercise by construction:

1. **Mirror staleness under real concurrent load.** D28's mirror is refreshed before each
   allocation behind a mutex, and `git remote update --prune` is fast against the host's local
   seed, so the fakes never observe a race between refresh and clone that a real network clone
   (seconds-long, not milliseconds) could open. The mirror cache remains one more piece of state
   that can go stale.
2. **N concurrent `localProcess` agent contention.** Every concurrency test uses replay/slow-fake
   adapters — no two real agent processes have ever been spawned at once (D7 bought zero
   isolation; the sandbox handle's process-side behaviour under real CPU/memory pressure is
   unmeasured).
3. **D32's reactive collision in real use.** The collision path (rejected push, or a `gh pr
   create` "already exists") reproduces only under a rival branch/stateful-`gh` test fixture; two
   concurrent live runs choosing the same branch is the first chance reality has to reach it.

The live leg must also, per phase 1/3/4's precedent, show the round trip end to end on a real PR
— the only thing no fake can attest.

## Polish notes (deliberately not diff work)

- `docs/findings/README.md` had not been indexed for finding 9; this step adds a phase-5 section
  covering 9 and 10.
- **ADR numbering collision:** two files carry `0005` — `0005-poc-manual-runs.md` (phase 5,
  indexed in STATUS) and `0006-raw-typescript-distribution.md` (distribution). Both predate this
  step; worth renumbering one on the next docs touch so cross-references stay unique.
- `factory start` has no `cancel` verb (see clause 2 above) — arguably in-scope before the live
  leg, one small CLI addition if wanted.
