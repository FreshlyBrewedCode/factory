# STATUS

> **Phases 0–3 complete.** Phase 1's exit criterion is met on both legs: the
> `defineWorkflow`/`startRun` runtime ran a real implement → test → review workflow end-to-end
> against opencode, opening
> [factory-spike#4](https://github.com/FreshlyBrewedCode/factory-spike/pull/4)
> (`docs/findings/3-live-e2e-run.md`), and the same workflow runs green under the corpus-replay
> adapter in `bun test` (`workflows/implement-issue.test.ts`). Phase 2's exit criterion is met:
> a `SIGKILL` mid-run, followed by a real process restart against the same sqlite file, leaves
> an intact, correctly-`"interrupted"` partial history (`docs/findings/4-crash-mid-run-recovery.md`).
> Phase 3's exit criterion is now met on both legs: fakes-provable (unattended Ready-item pickup,
> a run to completion, and SSE watchability, `src/server/integration.test.ts`) **and live** — a
> real `factory serve --dispatch-*` run against a real GitHub Project picked up an issue
> unattended and opened
> [factory-spike#5](https://github.com/FreshlyBrewedCode/factory-spike/pull/5)
> (`docs/findings/6-live-dispatch-run.md`). That live run also surfaced and fixed a genuine
> stray-artifact bug in write-back (below). Phase 0's spike opened
> [factory-spike#3](https://github.com/FreshlyBrewedCode/factory-spike/pull/3).

Project pitch, stack and constraints live in `AGENTS.md`. This file tracks where we are, what
we have decided, and what is still unknown.

|                   |                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Conclusions       | `docs/adr/0001-write-back-isolation-effect-boundary.md` (phase 0) · `0002-workflow-authoring-surface.md` (authoring syntax) · `0003-run-event-type.md` (D3's event type) · `0004-server-dispatch.md` (D22–D24, phase 3) |
| Evidence          | `docs/findings/` (one document per subtask)                                                                                                                              |
| Pre-spike reading | `docs/research/2026-09-13-pre-spike-reading.md` (annotated where the spike overturned it)                                                                                |

## Where we are

Phase 1's runtime (`defineWorkflow`, `startRun`, the CLI), phase 2's persistence
(`src/persistence/store.ts`, the `factory runs`/`factory log` CLI surface), and phase 3's
server/dispatch (`src/server/`) are built and validated against fakes **and live** — the phase 3
live dispatch run (`docs/findings/6-live-dispatch-run.md`) closed the last gated leg. Still
missing: the UI (phase 4) proper; a throwaway visual mock exists for brainstorming and has had one
refinement pass (`prototypes/phase4-ui/index.html`,
`docs/findings/7-phase4-ui-prototype-refinement.md`). Phase 4 now has an agreed step plan with
per-step validation criteria and one new decision (D26, live-data transport) — see its section.

### On disk

| Path                                                              | What it is                                                                                                                                                               | Fate                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `src/events.ts`, `src/events.test.ts`                             | **D3's event type** (ADR 0003) and its corpus-validation suite                                                                                                           | keep — the spine                                                  |
| `src/workflow.ts`                                                 | `defineWorkflow` + the six-member `ctx` (ADR 0002, D19)                                                                                                                  | keep                                                              |
| `src/runtime/run.ts`, `run.test.ts`                               | `startRun` — `seq`/`stepId`/`execId` allocation, structured-output extraction, `RunEvent` emission, cancellation                                                         | keep — phase 2 persists this, doesn't replace it                  |
| `src/persistence/store.ts`, `store.test.ts`                       | The durable event log: `openStore`/`appendEvent`/`getRunEvents`/`listRuns` over `bun:sqlite`, one `events` table, `"interrupted"` status derived at read time (D12, D21) | keep — the durability layer phase 3's server reads/writes through |
| `src/cli.ts`, `cli.test.ts`, `cli.crash.test.ts`                  | `factory run <workflow.ts>` (now also appends to sqlite), `factory runs`, `factory log <runId>`                                                                          | keep — phase 3's server wraps this, doesn't replace it            |
| `src/lib/exec.ts`, `writeback.ts`, `tree-snapshot.ts`, `clone.ts` | Harvested from the 0a/0b spike (ADR 0001 §5): host exec, deterministic write-back, tree-survival assertions, clone/reset                                                 | keep                                                              |
| `src/replay/adapter.ts`, `adapter.test.ts`                        | Corpus-replay fake adapter (`createCorpusReplayAdapter`, `createSlowFakeAdapter`)                                                                                        | keep — the only opencode-free path through the runtime            |
| `workflows/implement-issue.ts`, `implement-issue.test.ts`         | The one real workflow: implement → test → fix/review → test → PR metadata → write-back. Live-validated (factory-spike#4) and replay-validated                            | keep                                                              |
| `test/corpus/`                                                    | The nine recorded NDJSON corpora, promoted out of gitignored `.factory/runs/` into committed fixtures (128 KB)                                                           | keep — tests and the replay adapter both read these               |
| `test/fixtures/echo-workflow.ts`, `slow-workflow.ts`              | Minimal workflows for CLI-level tests — `echo-workflow` for one fast agent step, `slow-workflow` for a long-running `ctx.exec` to kill mid-flight                        | keep                                                              |
| `src/server/http.ts`, `http.test.ts`                              | HTTP API + SSE replay-then-tail over the event log (D22, ADR 0004)                                                                                                       | keep                                                              |
| `src/server/ready-source.ts`                                      | Pluggable `ReadySource` — `makeGitHubProjectsSource` + `makeFakeReadySource` (D23, ADR 0004)                                                                             | keep                                                              |
| `src/server/dispatch.ts`, `dispatch.test.ts`                      | Reconciliation loop — WIP limit, event-log-derived backoff, `Effect.repeat` scheduling (D24, ADR 0004)                                                                   | keep                                                              |
| `src/server/runs.ts`                                               | In-process active-run registry backing the WIP limit and cancel                                                                                                          | keep                                                              |
| `src/server/pubsub.ts`                                             | Live event fan-out for SSE tailing                                                                                                                                       | keep                                                              |
| `src/server/daemon.ts`, `viewer.ts`, `viewer.html`                 | `factory serve` wiring (`startDaemon`) + optional single-file HTML+SSE viewer                                                                                            | keep                                                              |
| `src/server/integration.test.ts`                                   | Phase 3's exit criterion, the fakes/replay-provable parts, end to end through `reconcileOnce` -> `startTrackedRun` -> the event log -> SSE                              | keep                                                              |
| `src/index.ts`, `src/index.test.ts`                               | 0c smoke test, proving `bun test` runs. Its function happens to be named `slugify`, unrelated to the spike target — a coincidence, not a dependency                      | still unreplaced; harmless, low priority                          |
| `docs/adr/`, `docs/findings/`, `docs/research/`                   | Decisions, evidence, reading notes                                                                                                                                       | keep                                                              |
| `docs/design/`                                                    | wayful's UI design guideline + reference screenshots, copied verbatim. Phase 4's rough visual reference; wayful's repo stays canonical                                   | keep                                                              |
| `prototypes/phase4-ui/index.html`                                 | The throwaway phase 4 visual mock — self-contained HTML/CSS/JS, no backend, simulated feed. Not the SPA, carries none of the stack                                       | throwaway — delete once phase 4's S3 renders real data            |
| `flake.nix`, `flake.lock`                                         | Nix dev shell: pins bun 1.4.2 and puts playwright's browser libs on `LD_LIBRARY_PATH`. Required for anything that drives a browser                                       | keep — phase 4 tests run through `nix develop`                    |
| `.factory/`                                                       | gitignored: the host-side clone, the raw run dumps, and (new in phase 2) `factory.db`                                                                                    | keep (regenerable)                                                |

Toolchain: bun 1.4.2, oxfmt, oxlint (type-aware, `@effect/tsgo` rules active and verified
firing). Scripts: `test`, `typecheck`, `lint`, `format`. **`format` is deliberately scoped to
explicit paths** — a bare `oxfmt .` reformats Markdown, including this file. `lint` exits 0
across the repo; the remaining output is all `effecttsgo` advisory warnings (async functions,
`Date.now()`, `console.*`, `process.env`) that flag idiomatic-Effect alternatives rather than
defects — none currently block the exit code.

Dependencies (verified against `node_modules` 2026-09-14, not just the manifest):
`@tanstack/ai` `0.54.0`, `-opencode` `0.4.5`, `-sandbox` `0.5.7`, `-sandbox-local-process`
`0.2.5`; `effect` `4.0.0-rc.115` (no stable v4 exists yet — recheck when phase 4 adds the SPA
dependencies). `@tanstack/ai-event-client` `0.11.3` is present transitively, not declared;
phase 4's S4 decides whether it becomes a direct dependency.

### What phase 0 proved

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

### What phase 0 did not prove

Isolation, concurrency, credential injection, and any non-`localProcess` provider — all out
of scope by D7. Persistence, the server, dispatch and the UI were not started. TanStack's own
persistence was never enabled, so F5's claim about it remains unverified.

## Host environment (verified 2026-09-13)

|                    |                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------- |
| `gh`               | authed as `FreshlyBrewedCode`, scopes `repo, project, read:org, gist`, protocol **ssh** |
| orgs               | `BTGD2020`, `frebreco`                                                                  |
| git identity       | set **per-repo**, not globally: `FreshlyBrewedCode` / `karl@git.frebreco.de`            |
| credential.helper  | unset — SSH is the only working git transport                                           |
| bun                | 1.4.2                                                                                   |
| opencode           | 1.18.29, host login present (`~/.local/share/opencode/auth.json`)                       |
| opencode providers | `cpa` (tailnet, custom) and `opencode-go` (hosted gateway)                              |
| spike model        | `opencode-go/deepseek-v4.1-flash`                                                       |

## Decisions

D1–D6 from the first research pass, D7–D14 from the pre-spike design session, D15–D18 forced
by phase 0's findings, D19 from the pre-phase-1 design session, D20 from the corpus analysis,
D21 from phase 2's persistence design.

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Workflows are imperative**, plain `async (ctx) => {...}` TypeScript — no step graph, no declarative DSL.                                                                                                                                                                                                                                                                                                                                                                                         | This is what makes sandcastle pleasant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D2  | **Factory owns git write-back** (branch / commit / push / PR). TanStack AI provides inbound only.                                                                                                                                                                                                                                                                                                                                                                                                  | Forced by the write-back gap. Also fits dispatch better than `merge-to-head`: the PR is exactly what the blocker check in the wayful script reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D3  | **One typed, append-only run-event log is the spine** shared by all three columns — runtime emits, sqlite stores, SSE replays, SPA renders. Define the event type in phase 1, before anything persists it. _(Done — D20 / ADR 0003.)_                                                                                                                                                                                                                                                              | Keeps the UI a thin client. Phase 0 strengthened this: the harness emits nothing about exec results, assertions or write-back, so our log is the only replay path that will ever exist.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D4  | **Effect owns the server** (lifecycle, sqlite, dispatch, scheduling). Workflow authoring stays plain async TS. The runtime is the bridge.                                                                                                                                                                                                                                                                                                                                                          | Effect-ifying the authoring surface costs the ergonomics that are the point of column 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D5  | Workflow modules export **`id` + input schema + the function** — a registration surface, not a step graph.                                                                                                                                                                                                                                                                                                                                                                                         | The daemon must enumerate and validate workflows without executing arbitrary files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D6  | **Web UI deferred to phase 4; the HTTP/SSE API ships in phase 3** alongside a `factory watch` CLI.                                                                                                                                                                                                                                                                                                                                                                                                 | Keeps the slice vertical without paying SPA cost early, and proves the API before a client depends on it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D7  | **`localProcessSandbox` for phase 0 and the POC.** Docker deferred.                                                                                                                                                                                                                                                                                                                                                                                                                                | Host credentials, host `gh`, host opencode login all work with zero provisioning, and `localProcess` is killable so it still answers the cancellation question. Accepted cost: zero isolation, no snapshots, nothing proven about credential injection.                                                                                                                                                                                                                                                                                                                                                   |
| D8  | **Factory owns the working tree.** Factory clones on the host into a directory it chose and hands that path to the harness. _(Mechanism superseded by D15 — the original wording named `source: {type:'local', path}`, which turned out to be dead code.)_                                                                                                                                                                                                                                         | Factory can always exec on a directory it owns, earlier steps cannot be wiped by a re-bootstrap, and the later docker move becomes a bind-mount question rather than a redesign.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D9  | **Write-back is a deterministic step in the workflow script**, not an agent instruction. Host-side `git` + `gh pr create` through `ctx.exec`, with git identity set repo-locally.                                                                                                                                                                                                                                                                                                                  | Makes D2 true rather than nominal. Branch name and commit message stop depending on whether the agent felt like producing good ones. `ctx.exec` returns exit codes rather than throwing.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D10 | **One `threadId` per run ⇒ one sandbox; every agent step is a fresh session.** Never pass `modelOptions.sessionId`. Context between steps is composed explicitly by the workflow script.                                                                                                                                                                                                                                                                                                           | The _tree_ is the shared state between steps; the transcript deliberately is not. Validated in 0a-2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D11 | **PR title and body come from an ordinary agent step** working in the tree and returning structured output. Factory consumes `{ title, body }`; it does not generate them and does not hardcode the step.                                                                                                                                                                                                                                                                                          | Keeps Factory out of the business of knowing what a PR should say. Validated in 0a-2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D12 | **Crash recovery is deprioritized.** Factory runs as a long-lived server process.                                                                                                                                                                                                                                                                                                                                                                                                                  | TanStack's durability machinery targets serverless hosts. Moot regardless: `opencodeText` has no journal. Phase 2 shrinks to "mark interrupted runs and keep history queryable."                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D13 | **Workflow script → imported utilities → a runtime that executes the workflow.** Three pieces, even in the spike.                                                                                                                                                                                                                                                                                                                                                                                  | The seam between "what a workflow author writes" and "what runs it" is the thing phase 1 inherits. Held up across 0a-1, 0a-2 and 0b without strain.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D14 | **Dump every raw stream chunk to NDJSON.** No schema, no types.                                                                                                                                                                                                                                                                                                                                                                                                                                    | A corpus, not a log. Phase 1 designs D3's event type against real recorded chunks. Three corpora now exist under `.factory/runs/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D15 | **`localProcessSandbox({dir})` is how D8 is implemented, not `workspace.source: {type:'local', path}`** — the latter is dead code in the installed package. Pair it with `workspace: defineWorkspace({source:{type:'none'}, setup:[]})`.                                                                                                                                                                                                                                                           | `bootstrapWorkspace()` has no `'local'` case; an empirical single-directory check confirmed in-place edits. D8's outcome held; its stated mechanism did not.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D16 | **Keep `defineWorkspace(...)` configured under `localProcessSandbox`, and clean the resulting stray `.tanstack-projected-*` / `data/` artifact before staging.**                                                                                                                                                                                                                                                                                                                                   | A `workspace` object is required to get `lifecycle.reuse:'thread'` at all. The artifact is a reproducible library bug, not something workflow authors should know about — write-back owns the cleanup and hard-fails if any survives.                                                                                                                                                                                                                                                                                                                                                                     |
| D17 | **Keep the explicit `Effect.onInterrupt` → `abortController.abort()` wiring**, even though 0b showed `Stream.fromAsyncIterable`'s implicit `.return()`-on-scope-close was sufficient in the tested case.                                                                                                                                                                                                                                                                                           | Cheap, never harmful, and covers the untested non-cooperative-abort case.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D18 | **Use `Schema.TaggedError<T>()(tag, fields)` over `Data.TaggedError`** for typed errors crossing the Effect boundary.                                                                                                                                                                                                                                                                                                                                                                              | Matches current v4 guidance and the `effecttsgo` lint rules.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D19 | **Workflow authoring surface: `defineWorkflow(id, {input, output?, agent?, run})` with a six-member `ctx` (`dir`, `agent`, `exec`, `assert`, `log`, `writeBack`).** Ownership rule: the runtime owns the tree, the log, and cancellation; the workflow owns everything else. `ctx.assert` records a callback's outcome as a typed event but never throws; `ctx.log` is the generic escape hatch.                                                                                                   | ADR 0002, designed against the spike's proven seam. Resolves the `ctx.agent()`-vs-`agentStep` naming drift and gives D3's event type a settled emission surface. Pre-implementation — phase 1's exit criterion falsifies it cheaply (in-memory, nothing persisted). Write-back on `ctx` is a border case with a stated demotion trigger: the first second workflow.                                                                                                                                                                                                                                       |
| D20 | **D3's event type: a typed Factory spine with harness chunks carried opaquely in AG-UI form.** `RunEvent = {runId, seq, ts, payload}`; 13 payload tags covering ADR 0002's emission surface, plus one `AgentChunk` member holding the chunk verbatim as `Schema.Json`. **`seq` — Factory-assigned, monotonic — is the only ordering key. Termination always carries an explicit outcome (`completed`/`failed`/`cancelled`). Correlation is by runtime-assigned `stepId`/`execId`, never by name.** | ADR 0003, designed against the nine corpora. Opaque because these chunks are AG-UI, a published cross-vendor protocol whose transport (SSE, NDJSON, resumable offsets) and client TanStack already ships — enumerating opencode's 16 types would break on the planned `claudeCodeText` comparison and buy nothing. The other three clauses are forced by measurement, not taste: chunk timestamps invert by up to 1473 ms because `sandbox.file` carries an mtime; cancellation emits no chunk whatsoever; and step names are not unique, so 0a-2's `{step, chunk}` envelope does not generalise.         |
| D21 | **Persist the event log with plain synchronous functions over `bun:sqlite` (not `@effect/sql-sqlite-bun`, not installed), in a single `events` table** (`run_id, seq, ts, tag, payload`, PK `(run_id, seq)`) — no separate `runs`/`steps`/`artifacts` tables.                                                                                                                                                                                                                                      | D4 scopes "Effect owns the server" to phase 3's daemon; phase 2 is still CLI-driven, so wrapping synchronous in-process sqlite I/O in Effect here would add a layer with nothing to bridge — matches `ctx.exec`/`ctx.writeBack` staying plain async functions. A run's identity, outcome and timing are all derivable from its own event rows (`RunStarted`, and the terminal event or its absence), so a second table would only be a cache that can drift from the log it caches. `"interrupted"` status is derived at read time, not written at crash time — nothing observes the crash as it happens. |
| D22 | **Plain `Bun.serve` for HTTP + SSE, not Effect.** Request/response handling and the SSE replay-then-tail stream are ordinary functions.                                                                                                                                                                                                                                                                                                                                                           | ADR 0004. Same reasoning as D21: synchronous callback-shaped I/O with nothing for Effect to bridge. Effect's actual job in phase 3 is the dispatcher's scheduling loop, not request handling.                                                                                                                                                                                                                                                                                                                                                                                                          |
| D23 | **`ReadySource`: a two-method pluggable interface** (`listReady`/`claim`), ported from the wayful script's GraphQL query + `gh project item-edit` claim, with the same soft/hard blocker distinction.                                                                                                                                                                                                                                                                                             | ADR 0004. `makeGitHubProjectsSource` is the only real implementation today; `makeFakeReadySource` backs `dispatch.test.ts`/`integration.test.ts`. A failed claim is "lost the race, skip", not an error.                                                                                                                                                                                                                                                                                                                                                                                              |
| D24 | **No separate retry-state file.** Backoff is derived at reconcile time from the sqlite event log (`RunStarted.input.issueNumber` as the join key), doubling per consecutive failure. WIP limit of 1 is enforced via the current process's in-memory active-run registry, not sqlite. Per-issue backoff, not the wayful script's global pause-on-any-failure.                                                                                                                                    | ADR 0004. Nothing to keep in sync with the log it would cache. D12's "interrupted ≠ active" applies to dispatch too: a dead process's run doesn't block new dispatch after a restart. Global pause doesn't fit Factory — workflows are one-shot (D19), so a retry is always a fresh run, and global pause would starve unrelated issues for no offsetting benefit.                                                                                                                                                                                                                                  |
| D25 | **`porcelainPaths` (`src/lib/writeback.ts`) always passes `--untracked-files=all` to `git status --porcelain`.** | Found by phase 3's live dispatch run, not by any prior test: plain `--porcelain` collapses a wholly-new untracked directory into one `?? dir/` line instead of listing files inside it, which let a nested D16 marker slip past `isStrayPath` and ship into a real PR (factory-spike#5). `docs/findings/6-live-dispatch-run.md`, `src/lib/writeback.test.ts`. |
| D26 | **Live data reaches the SPA by polling the runs list and per-run SSE for run detail.** A single multiplexed WebSocket for the whole app is deferred, not rejected. SSE frames gain `id: ${seq}` and the handler honours `Last-Event-ID` so a reconnect resumes instead of replaying. The client keeps one `subscribeToRun(runId, sinceSeq, onEvent)` seam, so swapping transport later is one file. | **The transcript is not a separate stream** — `AgentChunk` is a `RunEventPayload` member sharing the same `seq` space (ADR 0003), so there is nothing to multiplex it *with*. The only multiplexing available is across runs, and D24 pins WIP to 1: at most one run is live today, so the saved connections pay for concurrency that does not exist yet. What a WebSocket would genuinely buy — resumable reconnect — `seq` + `Last-Event-ID` buys for about five lines. Against that, a WS rewrite must reproduce `sseStream`'s subscribe-before-read → buffer → dedupe-by-`seq` ordering (`http.ts:51-94`) per *dynamic* subscription, which is the subtlest thing phase 3 built. Revisit on the trigger in Deferred. |

## Still unknown

Everything phase 0 set out to answer is answered — verdicts and evidence pointers in ADR §4.
What remains genuinely open:

- **True sandbox-instance reuse**, independent of the marker file's disk-state idempotency.
  The evidence is consistent with reuse but does not prove it.
- **Whether the explicit `abort()` wiring is ever load-bearing.** Only tested against a
  generator suspended at a clean yield point.
- **Multi-chunk `delta` accumulation** — now measured precisely and still unverified: every
  delta in every corpus was single-chunk (24 `TEXT_MESSAGE_CONTENT`, 32 `TOOL_CALL_ARGS`, 13
  `REASONING_MESSAGE_CONTENT`, all exactly one). That is a property of
  `opencode-go/deepseek-v4.1-flash`, not a guarantee. The accumulation code has never run
  against a genuinely streaming provider.
- **Whether `@tanstack/ai-event-client` is usable for transcript rendering** — a narrower question
  than ADR 0003 assumed. Inspected 2026-09-14: `0.11.3` ships three source files — `index.ts`
  (AG-UI chunk/part/usage *types*), `envelope.ts` (a devtools event envelope) and
  `devtools-middleware.ts` (a bridge to `@tanstack/devtools-event-client`). **No React components,
  no renderer.** So D20's bet is really "typed chunk accessors vs. a hand-written reducer over
  `AgentChunk`", and it touches only the transcript: the runs list, run overview and step list all
  read Factory-owned typed payloads with no AG-UI involvement. That is why the spike moved from the
  front of phase 4 to S4. Still untested.
- **What a non-opencode adapter's stream actually looks like.** The protocol has 33 event
  types, opencode emits 16, and the `claudeCodeText` comparison has not run. D20 is designed to
  absorb the difference, but that is an argument, not evidence.

## Deferred, with triggers

| Deferred                                                                                   | Trigger to revisit                                                                                                                                            |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dockerSandbox` + credential injection via `createSecrets`                                 | First untrusted repo, or first time two runs must be concurrent                                                                                               |
| Host-side patch write-back (consume a diff, `git apply` on host)                           | Any move off `localProcess` — D9's host-side git stops working the moment the tree is in a container                                                          |
| Private-repo clone auth inside a sandbox                                                   | Same trigger as docker                                                                                                                                        |
| Concurrency isolation — N sandboxes with one worktree each, rather than one shared tree    | Phase 5, or whenever D24's WIP limit of 1 is lifted. Phase 3 shipped at WIP 1, so this trigger did not fire there as expected                                  |
| Durable attach / takeover, and adapters that have journals (`claudeCodeText`, `codexText`) | Only if Factory stops being a long-lived process (D12)                                                                                                        |
| Portability off this machine                                                               | A second machine still needs an opencode login                                                                                                                |
| Non-cooperative abort case (a generator stuck where `.return()` cannot unstick it)         | First timeout/cancel bug against a non-tool-call step                                                                                                         |
| A single multiplexed WebSocket carrying every live feed, replacing polling + per-run SSE (D26) | The first of: D24's WIP limit lifting above 1, the SPA needing more than one live run on screen, or per-run connection count becoming a real problem      |
| The stray-artifact workaround (`cleanStrayArtifacts` in write-back)                        | Delete once an upstream release fixes the marker-path resolution — recheck on every `@tanstack/ai-sandbox*` bump                                              |
| Promoting `sandbox.file` to a typed file-change event (a "files changed" UI affordance)    | Same upstream fix as the stray artifact: today its paths are in two incompatible namespaces and 9 of 15 occurrences are about the stray marker, not real work |
| A Factory-owned transcript renderer (a reducer over `AgentChunk`), instead of `@tanstack/ai-event-client` | Phase 4's S4 spike failing its stated pass/fail criterion. Scope narrowed — see "Still unknown": the client is types + devtools middleware, so only the transcript was ever at stake                                                                                         |

## Phases

### Phase 0 — Spike & scaffold — **complete**

0c scaffolded the repo starved; 0a-1 got one agent step through `@tanstack/ai` +
`localProcessSandbox`; 0a-2 ran the eight-step round trip to a real PR; 0b wrapped the stream
as an Effect `Stream` and verified fiber-interrupt cancellation by PID. Four library/doc
contradictions were found and root-caused to source. See the ADR and `docs/findings/`.

### Phase 1 — Workflow runtime (column 1) — **complete**

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

### Phase 2 — Persistence & lifecycle — **complete**

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

### Phase 3 — Server & dispatch (column 3) — **complete**

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

### Phase 4 — Web UI (column 2)

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
served today** by `GET /api/runs`, `/api/runs/:id` and `/api/runs/:id/events`. The gaps:

| # | Gap | Closed by |
| --- | --- | --- |
| G1 | `listRuns` orders by `run_id ASC` (`store.ts:95`). Since `startTrackedRun` moved to `run-${crypto.randomUUID()}`, that ordering is effectively random — and the runs page is chronological. | S1 |
| G2 | `listRuns` reads **every event of every run** (`summarizeRun` → `getRunEvents`) to build a summary. Fine at nine runs; wrong shape for a page that refreshes. | S1 |
| G3 | SSE frames carry no `id:` (`http.ts:61`) and the handler ignores `Last-Event-ID`, so any reconnect replays the whole run. `seq` already makes resume trivially correct (D20). | S1 |
| G4 | `POST /api/runs` demands `workflowPath` + `dir` as filesystem strings (`http.ts:117`); a browser cannot supply them. D5's registration surface was never built, and there is no `/api/workflows` or `/api/dispatch` at all. | S5 |

#### Plan

Six steps, ordered so the SPA is on screen against real data as early as possible. The two pages
with no backend whatsoever (Workflows, Dispatch) and the transcript — the only part resting on an
unvalidated library bet — are deliberately last.

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
_Validated by:_ `typecheck` + `lint` clean with TSX in scope, `/` serving the SPA, `/api/*` still
answering same-origin, and the **first playwright smoke test** — wired here, while there is nothing
to break, rather than at the exit criterion. Two known friction points to settle in this step:
`format` is deliberately scoped to explicit paths, and `.oxlintrc.json` has no React/JSX config.
Prove playwright runs under `nix develop` (AGENTS.md) now, not at S6.

**S3 — Runs list, run overview, step list.** Factory-owned typed payloads only — no transcript, no
AG-UI. Ports finding 7's refined layout onto real data.
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

**S4 — Transcript.** The `@tanstack/ai-event-client` spike, moved here from the front of the phase
(see "Still unknown" for why it is narrower than ADR 0003 assumed).
_Validated by:_ a pass/fail criterion stated before the spike — can it render a real corpus
`AgentChunk` sequence (text deltas, tool calls, reasoning) without us re-typing chunk types? If not,
the deferred Factory-owned reducer fires. **Known limit, to be recorded rather than glossed:**
corpus replay cannot validate multi-delta accumulation — every delta in every corpus was
single-chunk (24 text / 32 tool-args / 13 reasoning, all exactly one), so that stays open until a
genuinely streaming provider runs.

**S5 — Workflows + Dispatch pages.** Needs G4: `GET /api/workflows`, `GET /api/dispatch`, and a
workflow-id-based `POST /api/runs`.
_Validated by:_ `http.test.ts` for the endpoints; `makeFakeReadySource` to drive Ready/claimed/
blocked deterministically for the page. Backoff is derived from the event log (D24), so a db seeded
with failed runs at chosen timestamps asserts the backoff rendering without waiting on wall-clock.

**S6 — Exit criterion, both legs**, matching the precedent phases 1 and 3 set. _Fakes:_ the whole
playwright suite green in one pass through `nix develop`. _Live:_ confirmed with the user first,
then a real `factory serve --dispatch-*` watched from the browser as a dispatched run streams to a
real PR. Output: a findings document and ADR 0005 (transport per D26, the dispatch API shape, and
S4's verdict).

**Exit:** the SPA renders the runs list and a live run detail from the real API — the fakes leg
provable in `bun test`/playwright without network or AI, and one live dispatched run watched end to
end in the browser.

### Phase 5 — Harden

Per-run isolation and concurrency, docker + secrets (D7's deferral), observability,
cancellation correctness.

## Start here

Phases 0–3 are complete on every exit criterion, fakes and live (see each phase's section above,
and ADR 0004 for D22–D24).
[factory-spike#5](https://github.com/FreshlyBrewedCode/factory-spike/pull/5) — the PR the phase
3 live run opened, which carried the stray-artifact file its own D25 fix came too late to
prevent — was closed with the user's confirmation, not amended
(`docs/findings/6-live-dispatch-run.md`).

**Next: phase 4, step S2** — the SPA scaffold: React + TanStack Router/Query + tailwind +
shadcn, bundled by Bun and served from the same `Bun.serve` as the API (`/`), plus the first
playwright smoke test wired through `nix develop`. S1 closed all three server-side gaps — run
ordering, cheap summaries, resumable SSE — and needs no UI. The full step plan, the four API
gaps and the validation criteria for every step are in the phase 4 section above. Read D6 and
D26 first, then `src/server/http.ts`'s route surface — the SPA is a client of what already
exists, not a redesign.

Left over from earlier phases, not exit-blocking, worth doing opportunistically:

- Run `workflows/implement-issue.ts` under `claudeCodeText` to see what a journal would have
  bought us, before D12 hardens into an assumption (D20 also wants this as the first real test
  of the opaque-passthrough bet).
- File the two root-caused library bugs upstream, so D16's workaround can eventually go. The
  marker-path one now has a second symptom worth citing: it pollutes the `sandbox.file` event
  stream with `/workspace` + host-absolute paths (finding 8).
- The stdout-marker-plus-settle-delay pattern in `src/cli.crash.test.ts` works but isn't a real
  synchronization primitive (finding 4) — revisit if it ever flakes in CI.
