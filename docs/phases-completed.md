# Completed phases — the full record

Phases 0 through 4, as they were written while they ran: what each step did, what it proved, and
where the evidence lives. `STATUS.md` keeps a few bullets per phase and points here.

Nothing in this file is current status. It is kept because the "Done" entries carry file pointers
and the reasoning behind choices later phases inherit — deleting it would lose the *why* behind
work that is still load-bearing. Decisions live in `docs/decisions.md`, evidence in
`docs/findings/`, and conclusions in `docs/adr/`.

## Phase 0 — Spike & scaffold

0c scaffolded the repo starved; 0a-1 got one agent step through `@tanstack/ai` +
`localProcessSandbox`; 0a-2 ran the eight-step round trip to a real PR; 0b wrapped the stream
as an Effect `Stream` and verified fiber-interrupt cancellation by PID. Four library/doc
contradictions were found and root-caused to source. See the ADR and `docs/findings/`.

### What it proved

Unattended, against `FreshlyBrewedCode/factory-spike` issue #1:

1. Host-side clone into a Factory-owned directory, agent step (implement), `bun test`,
   agent step (fix/review), `bun test`, agent step (PR metadata), deterministic write-back,
   PR opened. Every chunk recorded to NDJSON throughout.
2. **The tree survives sandbox reuse.** Step 2's contribution was byte-intact after the fix
   step's own sandbox re-bootstrap — the assertion phase 0 most needed to make.
3. **Fresh sessions carry no history**, confirmed behaviourally, not just by distinct ids.
4. **Structured output works at runtime** — `outputSchema` → `structured-output.complete`
   carried a parsed `{title, body}` that became the PR's title and body verbatim.
5. **Fiber interruption kills the agent process**, confirmed by PID in the process table,
   with a clean Effect `Interrupt` exit.

### What it did not prove

Isolation, concurrency, credential injection, and any non-`localProcess` provider — all out
of scope by D7. Persistence, the server, dispatch and the UI were not started. TanStack's own
persistence was never enabled, so F5's claim about it remains unverified.


## Phase 1 — Workflow runtime (column 1)

The `defineWorkflow` surface, the run engine, run context, and D3's event type. In-memory;
no server, no sqlite. CLI: `factory run <workflow.ts>`.

**Done:**

- ~~Design the event type first, against the NDJSON corpora.~~ `src/events.ts` + ADR 0003 +
  `docs/findings/1-event-type-corpus-analysis.md`. Three corpus findings changed the design
  from what the sketch below assumed: chunk timestamps cannot order events, cancellation emits
  nothing at all, and step names are not unique — so `{step, chunk}` did _not_ generalise as
  written, and correlation moved to runtime-assigned ids.
- ~~Promote the corpora to committed fixtures.~~ `test/corpus/`, which also unblocks the
  replay adapter.
- ~~Make the fake adapter a corpus replayer.~~ `src/replay/adapter.ts` — `createCorpusReplayAdapter`
  (contiguous per-step blocks, verified no interleaving) plus `createSlowFakeAdapter` for
  cancellation timing control.
- ~~Build the run engine.~~ `src/workflow.ts` (`defineWorkflow`, the six-member `ctx`) +
  `src/runtime/run.ts` (`startRun`, `seq`/`stepId`/`execId` allocation, tier-1/tier-2
  structured-output extraction, `RunEvent` emission).
- ~~Unify on Effect `Schema`.~~ `workflow.ts` re-exports `Schema`; `AgentCallOptions.output`,
  `WorkflowConfig`/`WorkflowDefinition` `input`/`output` are all `Schema.Codec<T, E>` (not
  `Schema.Schema<T>` — Effect v4 RC's `decodeUnknownSync` needs `DecodingServices = never`,
  which only `Codec` gives by default), converted to JSON Schema only at `ctx.agent`'s
  `outputSchema` boundary.
- ~~Harvest, don't rewrite.~~ `exec`/`writeback.ts`/`tree-snapshot.ts`/`clone.ts` were already
  in `src/lib/`; `fullRoundTrip` is now `workflows/implement-issue.ts` on the `defineWorkflow`
  surface. `src/spike/` deleted in one commit per ADR 0001 §5.
- ~~Run the sandbox-reuse nonce probe.~~ `docs/findings/2-sandbox-reuse-nonce-probe.md` —
  confirmed live, three runs: a nonce written in session 1 is read back correctly by session 2
  (same `threadId`/`dir`, no shared transcript), both via the read tool's own
  `TOOL_CALL_RESULT` and a direct host filesystem check.
- ~~Pin the cancellation guarantee with a test.~~ `src/runtime/run.test.ts` — asserts Factory's
  own `RunOutcome.outcome === "cancelled"` and an `AgentStepFinished{outcome:"cancelled"}`
  event (never `RunFailed`), using `createSlowFakeAdapter` for deterministic timing.
- ~~Build the CLI: `factory run <workflow.ts>`.~~ `src/cli.ts` — dynamic-imports a workflow
  module's default export, optionally clones a fresh working tree, runs it through `startRun`
  with an injectable `AgentAdapter`, streams `RunEvent`s to stdout + an NDJSON file via Bun's
  `FileSink`, and maps `SIGINT` to the runtime's own `cancel()` rather than a process kill.
  `src/cli.test.ts` exercises the real logic (import, dir/clone handling, NDJSON writing,
  exit-code mapping) against `createSlowFakeAdapter`, no live opencode calls.
- ~~Run the phase-1 exit criterion's live leg.~~ Confirmed with the user first (the one
  hard-to-revert, shared-state action in this phase), then run for real: `run-1789368882906`
  via `src/cli.ts` against real opencode, opened
  [factory-spike#4](https://github.com/FreshlyBrewedCode/factory-spike/pull/4). The fix step
  found and fixed a real bug unprompted (dropped, not transliterated, accented characters) —
  `docs/findings/3-live-e2e-run.md`.
- ~~Run the same workflow green under corpus replay in `bun test`.~~
  `workflows/implement-issue.test.ts` — `implement-issue.ts` through `startRun`, replayed
  against `test/corpus/run-1789308170212.ndjson`, against a local bare-repo `origin` fixture and
  a faked `gh`. Along the way, fixed `hostExec` (`src/lib/exec.ts`): `Bun.spawn` snapshots the
  environment at process startup unless an explicit `env` is passed, so it wasn't actually
  inheriting a live-mutated `process.env` as its docstring claimed.

**Exit — met:** a real implement → test → review workflow ran end-to-end against opencode
(factory-spike#4), **and** the same workflow runs green under the corpus-replay adapter in
`bun test`.

**Deferred out of phase 1** (not exit-blocking, still open — see "Still unknown" and "Start
here"): the `claudeCodeText` comparison, filing the two root-caused library bugs upstream.

## Phase 2 — Persistence & lifecycle

The event log becomes durable. Crash recovery scoped down per D12. Still CLI-driven.

**Done:**

- ~~Decide the sqlite/Effect persistence approach.~~ D21 — plain synchronous functions over
  `bun:sqlite`, a single `events` table, no `runs`/`step`s/`artifacts` tables.
- ~~Implement event-log persistence.~~ `src/persistence/store.ts` — `openStore`, `appendEvent`,
  `getRunEvents`, `listRuns`; `store.test.ts` covers round-tripping, interrupted-vs-completed
  status, and multi-run listing.
- ~~Wire it into the CLI.~~ `src/cli.ts` opens the store on `factory run` and appends every
  `RunEvent` as it's emitted (`--db`, default `.factory/factory.db`); `factory runs` and
  `factory log <runId>` read it back. `src/cli.test.ts` asserts persisted events match the
  NDJSON log for a completed run.
- ~~Validate the exit criterion.~~ `src/cli.crash.test.ts` — `SIGKILL`s a real `factory run`
  subprocess mid-`ctx.exec`, then opens the same sqlite file from a fresh connection and
  confirms a correctly-`"interrupted"` partial history. `docs/findings/4-crash-mid-run-recovery.md`.

**Exit — met:** kill the process mid-run, restart, and the run's history is intact and
queryable.

## Phase 3 — Server & dispatch (column 3)

HTTP API + SSE replay over the log; run create / cancel / list / get. Dispatcher as a
reconciliation loop with a pluggable source (GitHub project first), porting the claim-lock,
WIP-limit, pause-on-failure and backoff semantics from the wayful script (recorded in
`docs/research/2026-09-13-pre-spike-reading.md`).

**Done:**

- ~~HTTP API + SSE server over the event log.~~ `src/server/http.ts` — `GET/POST /api/runs`,
  `GET /api/runs/:id`, `POST /api/runs/:id/cancel`, `GET /api/runs/:id/events` (subscribe-
  before-read replay-then-tail, de-duplicated by `seq`). D22, ADR 0004.
- ~~Pluggable `ReadySource` + GitHub Projects implementation.~~ `src/server/ready-source.ts` —
  `makeGitHubProjectsSource` (the wayful script's GraphQL query + claim, same soft/hard blocker
  distinction) and `makeFakeReadySource` for tests. D23, ADR 0004.
- ~~Reconciliation loop: WIP limit, backoff, dispatch.~~ `src/server/dispatch.ts` —
  `reconcileOnce` (plain async, directly testable) wrapped by `runDispatchLoop`
  (`Effect.repeat(Schedule.spaced(...))`). Backoff derived from the event log, no second store;
  WIP limit of 1 via `src/server/runs.ts`'s in-process registry; per-issue backoff instead of
  the wayful script's global pause. D24, ADR 0004. `dispatch.test.ts` caught and fixed a real
  off-by-one in the backoff-doubling exponent.
- ~~`factory serve` CLI + optional HTML+SSE viewer.~~ `src/server/daemon.ts` (`startDaemon`,
  dispatch opt-in via `--dispatch-*` flags), `src/server/viewer.ts`/`viewer.html` (~100-line
  single-file SSE viewer), wired into `src/cli.ts`'s `serve` subcommand.
- ~~Validate the exit criterion.~~ `src/server/integration.test.ts` — wires `reconcileOnce`
  directly against `makeFakeReadySource` and a real `serve()`, proving unattended pickup, a run
  to completion, SSE watchability (`RunStarted`...`RunFinished` over the wire), and WIP-limit
  enforcement across reconcile passes, all without live GitHub access. Along the way, fixed a
  fake-fidelity gap (`makeFakeReadySource.listReady` wasn't filtering out claimed items) and an
  async test-timing bug (a fire-and-forget dispatched run outliving its test's `finally` block,
  closing the db out from under it) — see ADR 0004 and `dispatch.ts`/`ready-source.ts` history.
- ~~Run the exit criterion's live leg.~~ Confirmed with the user first (same precedent as phase
  1's live E2E leg), then run for real: a new GitHub Project (`factory-spike dispatch`, #4, its
  default "Todo" option renamed to "Ready") wired via `factory serve --dispatch-*`, which picked
  up issue #1 unattended and opened
  [factory-spike#5](https://github.com/FreshlyBrewedCode/factory-spike/pull/5) —
  `docs/findings/6-live-dispatch-run.md`. This run also found and fixed a genuine stray-artifact
  bug: `git status --porcelain` collapses a wholly-new untracked directory into one summary line,
  which let a D16 marker slip past `cleanStrayArtifacts` and ship into the PR. Fixed by D25
  (`--untracked-files=all`), pinned by `src/lib/writeback.test.ts`.

Concurrency was expected to stop being deferrable here; it did not. Phase 3 shipped at a WIP limit
of 1 (D24), so the isolation work moved to phase 5 with a trigger rather than a phase — see
Deferred.

**Exit — met on both legs:** fakes-provable (`integration.test.ts` — unattended pickup, a run to
completion, SSE watchability, WIP-limit enforcement) and live (`docs/findings/6-live-dispatch-run.md`
— a real `factory serve --dispatch-*` run picked up a Ready issue unattended and opened a real
PR, factory-spike#5). The write-back call path itself (`ctx.writeBack` → PR open) was already
proven live in phase 1 (`docs/findings/3-live-e2e-run.md`); this run proved the dispatcher
driving that call unattended. PR #5 itself carried the stray-artifact file the live run's D25
fix came too late to prevent; it was closed with the user's confirmation rather than amended.

## Phase 4 — Web UI (column 2)

React SPA, TanStack Router + Query, shadcn, tailwind, bundled by Bun and served from the same
`Bun.serve` as the API. Runs list + live run detail over SSE. Thin, because the API predates it
(D6).

A throwaway visual mockup exists at `prototypes/phase4-ui/index.html` — one self-contained
HTML/CSS/JS file, no backend, with a simulated live run (streams a step, finishes, opens a PR,
then the dispatcher claims the next issue). Purely for UI/UX brainstorming; it borrows wayful's
design language, copied to `docs/design/design.md`, and is not the phase 4 SPA and carries none of
the stack.

**Prototype refinement (done).** One pass, section by section, to cut visual overload
(`docs/findings/7-phase4-ui-prototype-refinement.md`): the live-info rail became a plain
Workflows/Dispatch/Runs category menu with a page per category; the runs Kanban became a
chronological table with running runs grouped on top (pulsing dot, live duration); the run detail
dropped the pipeline strip, turned the header chips into a stacked meta table, kept Steps + Events,
gave the step list an indexed spine (dotted/greyed for pending, live duration in its own column,
third after the step type), and moved all step detail into collapsed-by-default disclosures in the
inspector, with the transcript filling the panel from a click (original prompt at top). Also fixed
a status-colour bug: agent/write-back `"completed"` was missing from the `[data-status]` mapping.

#### What the API already covers, and the four gaps

Read off the code, not off this file. The runs list, run overview and step list are **fully
served today** by `GET /api/runs`, `/api/runs/:id` and `/api/runs/:id/events`. S1 closed G1–G3;
G4 is the one remaining gap, and it moved out of this phase — it is phase 5's P2/P3:

| # | Gap | Status |
| --- | --- | --- |
| G1 | Run ordering: `listRuns` ordered by `run_id ASC`, effectively random once `startTrackedRun` moved to `run-${crypto.randomUUID()}` — and the runs page is chronological. | **closed (S1)** — now newest-first by start time, deterministic tiebreak |
| G2 | Cheap summaries: `listRuns` read **every event of every run** (`summarizeRun` → `getRunEvents`) to build a summary; wrong shape for a page that refreshes. | **closed (S1)** — one SQL aggregate per run, field-equivalent to the old read-every-event logic |
| G3 | Resumable SSE: frames carried no `id:` and the handler ignored `Last-Event-ID`, so any reconnect replayed the whole run. `seq` already makes resume trivially correct (D20). | **closed (S1)** — frames stamp `id: ${seq}`; reconnects resume instead of replaying |
| G4 | `POST /api/runs` demands `workflowPath` + `dir` as filesystem strings (`http.ts:117`); a browser cannot supply them. D5's registration surface was never built, and there is no `/api/workflows` or `/api/dispatch` at all. | **open — moved to phase 5** (P2/P3, D30–D31). `/api/dispatch` is no longer part of it: the Dispatch page is dropped |

#### Plan

Originally six steps, ordered so the SPA is on screen against real data as early as possible, with
the three most-unknown parts last — the two pages with no backend whatsoever (Workflows, Dispatch)
and the transcript, which rested on an unvalidated library bet until S4's spike. **S1–S4 shipped;
S5–S6 dissolved into phase 5** (see below). That ordering is why the rescope was cheap: everything
deferred was already at the end.

Standing rule for every step: **tests drive the real server and a real sqlite event log.** Nothing
mocks `fetch`. `test/corpus/` plus the two existing fake adapters make a realistic backend
deterministic, so the UI never needs stubbed data.

**S1 — API fixes.** G1, G2, G3. No UI, no new endpoints. **Done** — `listRuns` now orders
newest-first by start time (ties broken by `runId`) and builds every summary from SQL
aggregates without reading a run's events; SSE frames carry `id: ${seq}` and the handler honours
`Last-Event-ID`. All three pinned by new tests in `store.test.ts`/`http.test.ts` (54 passing).
_Validated by:_ `bun test` alone. The ordering test seeds runs with deliberately out-of-order
UUIDs and interleaved timestamps — today's suite cannot see G1. G2 is a refactor, so equivalence
of the summary fields is the criterion, not throughput (asserting perf here would be flaky and
prove nothing at POC scale). G3 reconnects with `Last-Event-ID` set and asserts nothing at or
below that `seq` arrives.

**S2 — SPA scaffold.** React + TanStack Router/Query + tailwind + shadcn, Bun fullstack bundler,
served from the same `Bun.serve` as the API — which is also why CORS never has to exist. Decide
`viewer.html`'s fate here (it becomes redundant at `/`).
**Done** — `serve()` is now the composition root: the API handler is mounted under `/api/*` and the
bundled `src/web/index.html` is served at `/` and `/*` (deep links return the shell), so UI and API
share one origin and CORS never has to exist. `viewer.ts`/`viewer.html` and the `viewerHtml` option
are deleted. The scaffold is `src/web/`: the design guideline's tokens as Tailwind v4 CSS variables,
the first shadcn primitives (`badge`, `button`, `cn`), an app shell (56px top bar, nav, inspector),
code-based TanStack Router with a page per category, and a `QueryClient` reading `/api/runs` through
one client API seam. `bunfig.toml` registers `bun-plugin-tailwind`; tsconfig gains the `@/` alias
and DOM libs; `.oxlintrc.json` enables the react plugin (`rules-of-hooks`, `exhaustive-deps`) for
TSX; `format` now names `src`, `e2e` and the root configs. Playwright is wired with its own
real-daemon `webServer` (`e2e/smoke.e2e.ts` via `test:e2e`, files ending `.e2e.ts` so `bun test`
leaves them alone), proven under `nix develop`. One criterion friction point turned into a real
incompatibility worth recording: Bun's `development: true` HMR crashes TanStack Router at boot
(`Cannot read properties of null (reading 'replaceRouteChunk')`, router-core's dev-only prototype
patch), so `serve()` runs `development: false` — the same runtime-bundled, cached, minified HTML
route, just without hot reload.
_Validated by:_ `typecheck` + `lint` clean with TSX in scope (the react plugin catches a
conditional-hook probe). `http.test.ts` fetches `/` and a deep link and asserts `text/html` +
`id="root"`, then fetches `/api/runs` and asserts same-origin JSON. The playwright smoke runs the
real `factory serve` CLI on a temp sqlite db through `nix develop`: the shell mounts at `/` with
`0 recorded` from a real `/api/runs`, and clicking the nav reaches the Dispatch/Workflows routes.

**S3 — Runs list, run overview, step list.** Factory-owned typed payloads only — no transcript, no
AG-UI. Ports finding 7's refined layout onto real data.
**Done** — `/` is the chronological runs table: live runs grouped above terminal ones, newest-first
from S1's `listRuns`, with the shared dot+label status language and a live duration. `/runs/:runId`
leads with a stacked meta table, then Steps/Events tabs; the steps list is the indexed spine
(numbered nodes, solid connectors, a terminal run row with a plain dot) and step detail is
progressive fields → disclosures, transcript deferred to S4. Data flows from `GET /api/runs`,
`GET /api/runs/:id` and a replay-then-tail SSE subscription (`src/web/api.ts`, D26); `listRuns`
gained an `active` bit at the HTTP layer, because the store cannot tell an in-flight run from an
interrupted one (D12/D24). The shell's placeholder inspector is gone; run detail owns its own
two-pane layout. No new endpoints. The pure projection carries its own unit tests
(`run-events.test.ts`, `format.test.ts`), the HTTP layer gains a test for the `active` bit
(`bun test` is now 72), and the playwright suite is 5 specs, green through `nix develop`.
_Validated by:_ two legs. **Static** — a real daemon on a temp db, driven through
`createCorpusReplayAdapter` so a committed corpus becomes a real event log with no AI in the loop;
playwright then asserts list ordering and status, run-detail meta against `RunSummary`, and that the
step list's count/kind/order match the `AgentStepStarted`/`ExecStarted`/`WriteBackStarted` events
that produced it. **Live** — `createSlowFakeAdapter` (built in phase 1 for exactly this timing
control): start a run, assert the row reads as running with a ticking duration, assert the detail
appends steps as they arrive, assert the terminal state lands. That second leg is column 2's
analogue of `integration.test.ts`. **No visual snapshot tests** — the design is still moving and
snapshots would be a maintenance tax, not a safety net; conformance to `docs/design/design.md` is
reviewed by eye on screenshots.

**S4 — Transcript. Done** — the spike's pass/fail criterion failed for
`@tanstack/ai-event-client` (it ships no renderer; `docs/findings/8-phase4-transcript-renderer.md`),
so the deferred Factory-owned reducer fired, but narrowed: the chunk-folding half is TanStack's
`StreamProcessor` (already installed via `@tanstack/ai/client`) and Factory owns only the
projection and the presentation. `src/web/lib/transcript.ts` — `deriveTranscript(events, stepId)`
filters `AgentChunk` payloads by `stepId` in `seq` order through a fresh `StreamProcessor`, strips
the harness's echoed prompt, and `toTranscriptRows` joins each tool call to its result by
`toolCallId`. `run-detail.tsx` opens a full-panel transcript from a step (finding 7): prompt header,
prose for text, the shared `Disclosure` for reasoning / tool-call / structured-output, a back
control, all inside shadcn's `message-scroller` (new `@shadcn/react` dependency; its
`defaultScrollPosition="start"`, `autoScroll` only while the step is live). No
`@tanstack/ai-event-client`/`-react`/`-react-ui` dependency was added.
_Validated by:_ `bun test` at 83 — 10 new `transcript.test.ts` cases over the real corpora (text,
reasoning, tool-call↔result join across interleaved calls, multiple messages per step, the prompt
dedupe, a step with no chunks). Playwright through `nix develop`, 7 specs: a static corpus-replay
leg derives the expected prompt/text/tool/reasoning from the same event log the UI renders, and a
live `createSlowFakeAdapter` leg asserts the transcript fills in as the step streams and isolates
per step. That browser leg is also the proof that `@tanstack/ai/client` bundles and runs in the SPA
— finding 8 §6's biggest unverified risk. **Known limit, recorded rather than glossed:** corpus
replay still cannot validate multi-delta accumulation — every delta in every corpus was
single-chunk (24 text / 32 tool-args / 13 reasoning, all exactly one; finding 8 §6).

**S5 and S6 — dissolved into phase 5** (2026-09-15, with the user). The Workflows and Dispatch
pages are dropped: dispatch keeps working from `--dispatch-*` flags but gets no UI in the POC, and
the workflow registry S5 needed is not a page — it is what a manual start button requires, so it
became phase 5's P2 (D30). G4 is closed there, not here. S6's fakes leg becomes phase 4's exit
below; its live leg moves to phase 5's, where there is something worth watching that phase 4 alone
cannot show. ADR 0005 was taken by phase 5's decisions; phase 4's ADR is **0006**.

**Exit:** the SPA renders the runs list, a live run detail and a step transcript from the real API,
provable in `bun test`/playwright without network or AI. The live leg moves to phase 5.

