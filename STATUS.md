# STATUS

> **Phases 0–4 complete; phase 5 (usable POC) is in progress — P1–P5 done, P6's fakes leg met,
> its live leg pending the user's confirmation.** Phase 4 was rescoped on
> 2026-09-15: S1–S4 landed, and S5/S6 dissolved into the new phase 5 — the Workflows/Dispatch pages
> are dropped, the workflow registry became phase 5's P2, and the live leg moved to phase 5's exit
> where concurrency makes it worth watching. Every completed phase met its exit criterion on both
> legs, fakes and live — the round trip (factory-spike#3), a live workflow run (#4) and a live
> unattended dispatch (#5) all opened real PRs. Per-phase detail is in
> [`docs/phases-completed.md`](docs/phases-completed.md).
>
> **Phase 5 is the first end state a person can use** — start a run from the browser or
> `factory start`, watch it, cancel it, several at once. Decided 2026-09-15 as D27–D33 / ADR 0005;
> **P1–P5 (config, per-run trees, admission, the workflow registry, `POST /api/runs {workflowId,
> input}`, `factory start`, the New-run dialog + cancel in the UI, and D32's reusable
> `implement-issue`) are built; the phase's exit criterion (P6) has its fakes leg met
> (finding 10) — the live leg, two concurrent browser-started runs to real PRs, awaits the
> user's go-ahead.**

Project pitch, stack and constraints live in `AGENTS.md`. This file tracks where we are, what
we have decided, and what is still unknown.

|                   |                                                                                                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Conclusions       | `docs/adr/0001-write-back-isolation-effect-boundary.md` (phase 0) · `0002-workflow-authoring-surface.md` (authoring syntax) · `0003-run-event-type.md` (D3's event type) · `0004-server-dispatch.md` (D22–D24, phase 3) · `0005-poc-manual-runs.md` (D27–D33, phase 5 — **Proposed**; built, fakes leg met, live leg pending) |
| Decisions         | [`docs/decisions.md`](docs/decisions.md) — the full register, D1–D33 with rationale. This file keeps only the index                                                                                                                                                                                          |
| Completed phases  | [`docs/phases-completed.md`](docs/phases-completed.md) — phases 0–4 in full. This file keeps a few bullets each                                                                                                                                                                                              |
| Evidence          | `docs/findings/` (one document per subtask)                                                                                                                                                                                                                                                                  |
| Pre-spike reading | `docs/research/2026-09-13-pre-spike-reading.md` (annotated where the spike overturned it)                                                                                                                                                                                                                    |

## Where we are

**All three columns exist and are validated, fakes and live.** The workflow runtime (phase 1), the
durable event log (phase 2), the server and dispatcher (phase 3) and the SPA (phase 4) are built;
`bun test` is 133 green and the playwright suite is 11 specs through `nix develop`.

**The workflow registry is live end to end, and `implement-issue` is now reusable (D32).**
`POST /api/runs` accepts
`{workflowId, input}` against the config's registry (D31, landed with `factory start`), the SPA's
New-run dialog drives it from D33's single-depth form, and cancel buttons wrap the phase 3
`POST /api/runs/:id/cancel` on run detail and running rows. D32 closed the loop: the workflow's
input is now just `{ issueNumber }`, the agent supplies the branch name with the PR metadata, and
`repoSlug`/`baseBranch` come from config through the run environment.

Everything up to here is history; it lives in [`docs/phases-completed.md`](docs/phases-completed.md).
The live state is the four sections below: what is on disk, what is still unknown, what is deferred,
and phase 5.

### On disk

| Path                                                                     | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Fate                                                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `src/events.ts`, `src/events.test.ts`                                    | **D3's event type** (ADR 0003) and its corpus-validation suite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | keep — the spine                                                    |
| `src/workflow.ts`                                                        | `defineWorkflow` + the six-member `ctx` (ADR 0002, D19)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | keep                                                                |
| `src/runtime/run.ts`, `run.test.ts`                                      | `startRun` — `seq`/`stepId`/`execId` allocation, structured-output extraction, `RunEvent` emission, cancellation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | keep — phase 2 persists this, doesn't replace it                    |
| `src/persistence/store.ts`, `store.test.ts`                              | The durable event log: `openStore`/`appendEvent`/`getRunEvents`/`listRuns` over `bun:sqlite`, one `events` table, `"interrupted"` status derived at read time (D12, D21)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | keep — the durability layer phase 3's server reads/writes through   |
| `src/cli.ts`, `cli.test.ts`, `cli.start.test.ts`, `cli.crash.test.ts`    | `factory run <workflow.ts>` (now also appends to sqlite), `factory start <workflowId>` (D31's thin HTTP client: prints the runId, `--watch` tails SSE), `factory runs`, `factory log <runId>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | keep — phase 3's server wraps `run`, `start` is its explicit client |
| `src/lib/exec.ts`, `writeback.ts`, `tree-snapshot.ts`, `clone.ts`        | Harvested from the 0a/0b spike (ADR 0001 §5): host exec, deterministic write-back, tree-survival assertions, clone/reset                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | keep                                                                |
| `src/replay/adapter.ts`, `adapter.test.ts`                               | Corpus-replay fake adapter (`createCorpusReplayAdapter`, `createSlowFakeAdapter`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | keep — the only opencode-free path through the runtime              |
| `workflows/implement-issue.ts`, `implement-issue.test.ts`                | The one real workflow: implement → test → fix/review → test → PR metadata → write-back. Live-validated (factory-spike#4) and replay-validated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | keep                                                                |
| `test/corpus/`                                                           | The nine recorded NDJSON corpora, promoted out of gitignored `.factory/runs/` into committed fixtures (128 KB)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | keep — tests and the replay adapter both read these                 |
| `test/fixtures/echo-workflow.ts`, `slow-workflow.ts`, `live-workflow.ts` | Minimal workflows for tests — `echo-workflow` for one fast agent step, `slow-workflow` for a long-running `ctx.exec` to kill mid-flight, `live-workflow` (S3) for the playwright live leg                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | keep                                                                |
| `src/server/http.ts`, `http.test.ts`                                     | HTTP API + SSE replay-then-tail over the event log (D22, ADR 0004); `serve()` also mounts the phase 4 SPA under `/` and `/*` (S2); run summaries gained an `active` bit to tell a running run from an interrupted one (S3). `viewerHtml` deleted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | keep — `serve()` is now the UI+API composition root                 |
| `src/server/ready-source.ts`                                             | Pluggable `ReadySource` — `makeGitHubProjectsSource` + `makeFakeReadySource` (D23, ADR 0004)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | keep                                                                |
| `src/server/dispatch.ts`, `dispatch.test.ts`                             | Reconciliation loop — WIP limit, event-log-derived backoff, `Effect.repeat` scheduling (D24, ADR 0004)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | keep                                                                |
| `src/server/runs.ts`                                                     | In-process active-run registry backing the WIP limit and cancel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | keep                                                                |
| `src/server/pubsub.ts`                                                   | Live event fan-out for SSE tailing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | keep                                                                |
| `src/server/daemon.ts`                                                   | `factory serve` wiring (`startDaemon`, dispatch opt-in via `--dispatch-*` flags)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | keep                                                                |
| `src/web/`                                                               | Phase 4 SPA: `index.html` + `main.tsx`/`router.tsx`/`app-shell.tsx`, shadcn primitives, Tailwind design tokens (S2); S3 added `api.ts`/`hooks.ts`, the `lib/run-events.ts` projection, `lib/status.ts`/`format.ts` and the `pages/` runs list + run detail; S4 added the pure `lib/transcript.ts` projection (`StreamProcessor` over one step's chunks, tool-call↔result join) and the `message-scroller` primitive, opening a full-panel transcript from a step; P4 added the pure `lib/start-form.ts` projection (D33's single-depth spec + input builder), the top-bar `components/new-run-dialog.tsx` (fields → `POST /api/runs {workflowId, input}` → navigate to run detail, raw-JSON escape hatch, 400/404/409 inline) and `components/cancel-run-button.tsx` (armed→confirm, wired to cancel on run detail and running rows); the dropped Workflows page stub is gone; bundled by Bun's fullstack bundler | keep                                                                |
| `e2e/`, `playwright.config.ts`                                           | Phase 4's playwright suite and its real-daemon webServer — the P4 legs drive the New-run dialog (form start + raw-JSON 400 inline) and cancel (detail + running rows) against a daemon that now serves a config registry (fixtures + seed repo + workspace allocation) — runs through `nix develop`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | keep — grows each step                                              |
| `src/server/integration.test.ts`                                         | Phase 3's exit criterion, the fakes/replay-provable parts, end to end through `reconcileOnce` -> `startTrackedRun` -> the event log -> SSE                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | keep                                                                |
| `src/index.ts`, `src/index.test.ts`                                      | 0c smoke test, proving `bun test` runs. Its function happens to be named `slugify`, unrelated to the spike target — a coincidence, not a dependency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | still unreplaced; harmless, low priority                            |
| `docs/adr/`, `docs/findings/`, `docs/research/`                          | Decisions, evidence, reading notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | keep                                                                |
| `docs/design/`                                                           | wayful's UI design guideline + reference screenshots, copied verbatim. Phase 4's rough visual reference; wayful's repo stays canonical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | keep                                                                |
| `prototypes/phase4-ui/index.html`                                        | The throwaway phase 4 visual mock — self-contained HTML/CSS/JS, no backend, simulated feed. Not the SPA, carries none of the stack                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | throwaway — S3 supersedes it on real data; delete on next cleanup   |
| `flake.nix`, `flake.lock`                                                | Nix dev shell: pins bun 1.4.2 and puts playwright's browser libs on `LD_LIBRARY_PATH`. Required for anything that drives a browser                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | keep — phase 4 tests run through `nix develop`                      |
| `.factory/`                                                              | gitignored: the host-side clone, the raw run dumps, and (new in phase 2) `factory.db`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | keep (regenerable)                                                  |

Toolchain: bun 1.4.2, oxfmt, oxlint (type-aware, `@effect/tsgo` rules active and verified
firing; the react plugin is now enabled for TSX — `rules-of-hooks`/`exhaustive-deps`, with
`react-in-jsx-scope` off for the automatic runtime). Scripts: `test`, `test:e2e`, `typecheck`,
`lint`, `format`. **`format` is deliberately scoped to explicit paths** — a bare `oxfmt .`
reformats Markdown, including this file; the script now names `src`, `e2e`, and the root configs.
`lint` exits 0 across the repo; the remaining output is all `effecttsgo` advisory warnings (async
functions, `Date.now()`, `console.*`, `process.env`, `global-fetch`) that flag idiomatic-Effect
alternatives rather than defects — none currently block the exit code. **Convention worth stating
out loud (recorded 2026-09-15, from the phase-5 review):** since phase 5, workflow inputs are
remote-facing — a browser or script client supplies them over `POST /api/runs` — so any workflow
impl (or fixture) that interpolates an input value into a shell command (`sh -c`, `ctx.exec`)
accepts arbitrary shell commands from anyone who can start a run. That is an operator hazard to
treat deliberately in phase 6, not an accident to keep quiet about.

Dependencies (verified against `node_modules` 2026-09-14, not just the manifest):
`@tanstack/ai` `0.54.0`, `-opencode` `0.4.5`, `-sandbox` `0.5.7`, `-sandbox-local-process`
`0.2.5`; `effect` `4.0.0-rc.115` (no stable v4 exists yet — recheck on the next dependency move;
the S2 SPA additions pulled no second copy). Phase 4 S2 added React `19.3.0`, `react-dom`,
`@tanstack/react-router` `1.170.36`, `@tanstack/react-query` `5.102.8`, `tailwindcss` `4.3.3`
via `bun-plugin-tailwind` `0.1.2`, the shadcn primitives (`class-variance-authority`, `clsx`,
`tailwind-merge`, `@radix-ui/react-slot`, `lucide-react`), and self-hosted
`@fontsource-variable/{inter,jetbrains-mono}` `5.3.0`; `@playwright/test` `1.63.0` (its bundled
Chromium revision `1243` matches the host's `~/.cache/ms-playwright`). S4 added `@shadcn/react`
`0.3.1` (the headless `message-scroller` behaviour, imported as
`@shadcn/react/message-scroller`; peer `react >=19` is satisfied by `19.3.0`). The generated
`message-scroller` wrapper repoints `cn` to `@/web/lib/utils` and trims `scroll-fade-b`, the one
utility absent from Tailwind v4.3.3 core (`scrollbar-thin`/`scrollbar-none`/
`scrollbar-gutter-stable` are core). `@tanstack/ai-event-client` `0.11.3` is present transitively
and stays undeclared: S4's spike found it ships types + a devtools middleware, no renderer
(`docs/findings/8-phase4-transcript-renderer.md`), so the transcript folds chunks with
`@tanstack/ai/client`'s `StreamProcessor` — already a direct dependency — instead.

### What phase 0 proved, and did not

Moved to [`docs/phases-completed.md`](docs/phases-completed.md). In short: the unattended round
trip, tree survival across sandbox reuse, no history in fresh sessions, working structured output,
and fiber-interrupt cancellation confirmed by PID. Isolation, concurrency and credential injection
were out of scope by D7 — **concurrency stops being deferred in phase 5 (D28).**

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

**Index only. The full register, with rationale for every decision, is
[`docs/decisions.md`](docs/decisions.md);** where a decision has an owning ADR, that ADR is the
deepest record. D1–D6 came from the first research pass, D7–D14 from the pre-spike design session,
D15–D18 were forced by phase 0's findings, D19–D21 from the phase 1/2 design sessions, D22–D25 from
phase 3, D26 from phase 4's transport question, and **D27–D33 from the 2026-09-15 POC design
session** — built in phase 5's P-steps (D32 landed with P5; the per-decision build state is in
the table).

| #   | Decision                                                                                                  | Owning record                       |
| --- | --------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| D1  | Workflows are imperative plain `async (ctx) => {...}` TypeScript — no step graph, no DSL                  | —                                   |
| D2  | Factory owns git write-back (branch / commit / push / PR); TanStack AI is inbound only                    | —                                   |
| D3  | One typed, append-only run-event log is the spine shared by all three columns                             | ADR 0003                            |
| D4  | Effect owns the server; workflow authoring stays plain async TS, the runtime bridges                      | —                                   |
| D5  | Workflow modules export `id` + input schema + the function — a registration surface                       | widened by D27                      |
| D6  | Web UI deferred to phase 4; the HTTP/SSE API ships in phase 3                                             | —                                   |
| D7  | `localProcessSandbox` for phase 0 and the POC; docker deferred                                            | ADR 0001                            |
| D8  | Factory owns the working tree and hands the path to the harness                                           | ADR 0001                            |
| D9  | Write-back is a deterministic step in the workflow script, not an agent instruction                       | ADR 0001                            |
| D10 | One `threadId` per run ⇒ one sandbox; every agent step is a fresh session                                 | ADR 0001                            |
| D11 | PR title and body come from an ordinary agent step's structured output                                    | widened by D32                      |
| D12 | Crash recovery deprioritized — Factory runs as a long-lived server process                                | ADR 0001                            |
| D13 | Workflow script → imported utilities → a runtime that executes the workflow                               | ADR 0001                            |
| D14 | Dump every raw stream chunk to NDJSON — a corpus, not a log                                               | ADR 0001                            |
| D15 | `localProcessSandbox({dir})` is how D8 is implemented, not `workspace.source`                             | ADR 0001                            |
| D16 | Keep `defineWorkspace(...)`, and clean the stray `.tanstack-projected-*` artifact                         | ADR 0001                            |
| D17 | Keep the explicit `Effect.onInterrupt` → `abortController.abort()` wiring                                 | ADR 0001                            |
| D18 | `Schema.TaggedError<T>()(tag, fields)` over `Data.TaggedError`                                            | —                                   |
| D19 | `defineWorkflow(id, {input, output?, agent?, run})` with a six-member `ctx`                               | ADR 0002                            |
| D20 | The event type: a typed Factory spine with AG-UI chunks carried opaquely                                  | ADR 0003                            |
| D21 | Plain synchronous functions over `bun:sqlite`, a single `events` table                                    | —                                   |
| D22 | Plain `Bun.serve` for HTTP + SSE, not Effect                                                              | ADR 0004                            |
| D23 | `ReadySource`: a two-method pluggable interface (`listReady`/`claim`)                                     | ADR 0004                            |
| D24 | No retry-state file — backoff derived from the event log; WIP via the in-process registry                 | ADR 0004, superseded in part by D29 |
| D25 | `porcelainPaths` always passes `--untracked-files=all` to `git status --porcelain`                        | ADR 0004                            |
| D26 | Live data reaches the SPA by polling the runs list + per-run SSE for run detail                           | amended by D29                      |
| D27 | **`factory.config.ts` is the project's entry point**, with workflows imported into it — built (P1)        | ADR 0005                            |
| D28 | **One working tree per run**, cloned from a local bare mirror; last N retained — built (P1)               | ADR 0005                            |
| D29 | **One `maxConcurrentRuns`** behind a single admission function; 409 over the limit — built (P1/P3)        | ADR 0005                            |
| D30 | **`GET /api/workflows`** served from the config's array, schemas as JSON Schema — built (P2)              | ADR 0005                            |
| D31 | **`POST /api/runs {workflowId, input}`**; `factory start` is a thin HTTP client — built (P3)              | ADR 0005                            |
| D32 | **Write-back metadata is agent-supplied**, branch included; collisions resolved reactively — built (P5)  | ADR 0005                            |
| D33 | **The start form is single-depth**, with a raw-JSON escape hatch — built (P4)                             | ADR 0005                            |

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
- **`@tanstack/ai-event-client` for transcript rendering — answered, 2026-09-14: no.** Finding 8
  shows `0.11.3` ships types plus a devtools middleware and no renderer whatsoever, so the
  deferred Factory-owned reducer fired — but narrowed to a thin projection over the chunk-folding
  `StreamProcessor` already exported by `@tanstack/ai/client`. The browser leg of
  `e2e/transcript.e2e.ts` proves it bundles and runs in the SPA, and the live step-switch leg
  exercises a fresh processor per step.
- **Malformed-chunk tolerance in the transcript.** `AgentChunk.chunk` is `Schema.Json` (ADR 0003's
  accepted cost) and is cast to `StreamChunk` unchecked. The corpora prove every _valid_ recorded
  chunk folds; whether `StreamProcessor` throws on a malformed known-type chunk is untested
  (finding 8 §6). The fold is not wrapped defensively today.
- **What a non-opencode adapter's stream actually looks like.** The protocol has 33 event
  types, opencode emits 16, and the `claudeCodeText` comparison has not run. D20 is designed to
  absorb the difference, but that is an argument, not evidence.

## Deferred, with triggers

| Deferred                                                                                       | Trigger to revisit                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dockerSandbox` + credential injection via `createSecrets`                                     | First untrusted repo. **Trigger narrowed by D28:** "first time two runs must be concurrent" no longer applies — phase 5 gets concurrency from per-run working trees on the host, with no isolation gained and none claimed                                                                                                                                                             |
| Host-side patch write-back (consume a diff, `git apply` on host)                               | Any move off `localProcess` — D9's host-side git stops working the moment the tree is in a container                                                                                                                                                                                                                                                                                   |
| Private-repo clone auth inside a sandbox                                                       | Same trigger as docker                                                                                                                                                                                                                                                                                                                                                                 |
| ~~Concurrency isolation — N sandboxes with one worktree each, rather than one shared tree~~    | **Fired, and resolved smaller than written (D28).** The sandbox was never the shared resource — D10 already gives one per run via `threadId` — so phase 5 allocates a working tree per run and nothing else changes. Kept here as a record that the original framing was pessimistic                                                                                                   |
| Queued runs — a `RunQueued` state so work can be scheduled ahead of capacity                   | Wanted, not scoped (D29). Revisit once the POC is in hand: it needs a new event tag (ADR 0003), restart survival, ordering and cancel-before-start — a second scheduler beside the dispatcher. D29's admission function is the seam it would swap into                                                                                                                                 |
| Multi-repo / multi-project — more than one target repository per daemon                        | D27 ships a singular `repo` key for the POC. Revisit when a second project is real; the config shape should absorb it as a plural key rather than a redesign                                                                                                                                                                                                                           |
| Durable attach / takeover, and adapters that have journals (`claudeCodeText`, `codexText`)     | Only if Factory stops being a long-lived process (D12)                                                                                                                                                                                                                                                                                                                                 |
| Portability off this machine                                                                   | A second machine still needs an opencode login                                                                                                                                                                                                                                                                                                                                         |
| Non-cooperative abort case (a generator stuck where `.return()` cannot unstick it)             | First timeout/cancel bug against a non-tool-call step                                                                                                                                                                                                                                                                                                                                  |
| A single multiplexed WebSocket carrying every live feed, replacing polling + per-run SSE (D26) | **Trigger revised by D29.** "D24's WIP limit lifting above 1" fires in phase 5 but was the wrong proxy: the SPA opens SSE only on run detail, which shows one run, and the runs list is polled — so N concurrent runs still means one connection. The substantive clauses stand: the SPA needing more than one live run on screen, or per-run connection count becoming a real problem |
| The stray-artifact workaround (`cleanStrayArtifacts` in write-back)                            | Delete once an upstream release fixes the marker-path resolution — recheck on every `@tanstack/ai-sandbox*` bump                                                                                                                                                                                                                                                                       |
| Promoting `sandbox.file` to a typed file-change event (a "files changed" UI affordance)        | Same upstream fix as the stray artifact: today its paths are in two incompatible namespaces and 9 of 15 occurrences are about the stray marker, not real work                                                                                                                                                                                                                          |

## Phases

Phases 0–4 are complete; each is a few bullets here. **The full record — every step, what it
proved, and where its evidence lives — is [`docs/phases-completed.md`](docs/phases-completed.md).**
Phase 5 is next and is written out in full, because it is the one nobody has built yet.

### Phase 0 — Spike & scaffold — **complete**

- Proved the unattended round trip end to end: host clone → agent → `bun test` → agent → write-back
  → real PR ([factory-spike#3](https://github.com/FreshlyBrewedCode/factory-spike/pull/3)).
- The tree survives sandbox reuse; fresh sessions carry no history; fiber interruption kills the
  agent process. Four library/doc contradictions found and root-caused to source.
- Did **not** prove isolation, concurrency or credential injection — out of scope by D7.

### Phase 1 — Workflow runtime (column 1) — **complete**

- `defineWorkflow` + the six-member `ctx` (ADR 0002), `startRun`, and D3's event type designed
  against nine recorded corpora (ADR 0003).
- **Exit met, both legs:** a live implement → test → review run opened
  [factory-spike#4](https://github.com/FreshlyBrewedCode/factory-spike/pull/4), and the same
  workflow runs green under the corpus-replay adapter in `bun test`.

### Phase 2 — Persistence & lifecycle — **complete**

- The durable event log: plain synchronous functions over `bun:sqlite`, one `events` table,
  `"interrupted"` derived at read time (D21).
- **Exit met:** `SIGKILL` mid-run, real process restart, intact and correctly-`"interrupted"`
  partial history.

### Phase 3 — Server & dispatch (column 3) — **complete**

- HTTP + SSE over the event log (D22), a pluggable `ReadySource` (D23), and a reconciliation loop
  with an event-log-derived backoff (D24). ADR 0004.
- **Exit met, both legs:** fakes-provable in `integration.test.ts`, and a live unattended
  `factory serve --dispatch-*` run opened
  [factory-spike#5](https://github.com/FreshlyBrewedCode/factory-spike/pull/5).
- That live run found D25 — a stray artifact shipping into a real PR, invisible to every prior test.

### Phase 4 — Web UI (column 2) — **complete (rescoped)**

- The SPA on screen against real data: runs list, run detail, step list (S1–S3) and the step
  transcript folded through TanStack's `StreamProcessor` (S4, finding 8).
- **Rescoped 2026-09-15:** S5/S6 dissolved into phase 5 — Workflows/Dispatch pages dropped, the
  workflow registry became phase 5's P2, and the live leg moved to phase 5's exit. Phase 4's ADR is
  **0006**, not 0005.
- **Exit met** on its fakes-only terms: `bun test` 83 green, playwright per finding 8.

### Phase 5 — Usable POC: manual runs

The first end state a person can actually use: `factory serve`, open the browser, start a run
against a chosen workflow, watch it stream, cancel it — and do the same from a script. Several runs
at once. Automatic dispatch stays out of the UI and keeps working from `--dispatch-*` flags, so
nothing phase 3 built is discarded or paused.

Decisions D27–D33, ADR 0005, agreed in the 2026-09-15 design session. The one that reshaped the
phase: **multi-run is required, not deferred.** Tracing it found the deferral's "N sandboxes with
one worktree each" framing was pessimistic — D10 already gives one sandbox per run, so the only
shared resource is the working directory (D28).

**P1 — Per-run working trees and concurrency — done (2026-09-15).** `factory.config.ts` (D27):
`src/config.ts` (`defineConfig`, `loadFactoryConfig`, `toRunEnvironment`) — repo/identity/base
branch/slug, the workflow array _as_ the registry, workspace root (default
`.factory/workspaces`), `maxConcurrentRuns` (default 3), `retainedWorkspaces` (default 10, validated
**>= maxConcurrentRuns** at load); loaded by `factory serve --config <path>`. Working tree per run
(D28): `src/lib/workspace.ts` allocates
`<workspaceRoot>/<runId>/` from a bare mirror `<workspaceRoot>/.mirror.git` refreshed (mutex
serialized) from the configured `sshUrl` before each allocation, last-N evicted-oldest-first
(**except trees of runs this process still holds** — M2 review fix, and defineConfig refuses a
retention below the concurrency limit); the
start path `startTrackedRun` (`src/server/runs.ts`) is now async and allocates when no explicit
`dir` is given, and the allocated tree's `origin` is re-pointed at the configured `sshUrl` so D9's
push reaches the real remote rather than the mirror. One admission function (D29):
`src/server/admission.ts`'s `admitRun` over a single
`maxConcurrentRuns`; since the M1 review fix the slot is **reserved in the registry before any
await** inside `startTrackedRun` (so two near-simultaneous `POST /api/runs` cannot both slip
through — exactly one 201, one 409), consulted by `POST /api/runs` (409 over the limit) and
`dispatch.ts` (skips the pass), replacing `hasActiveRun`'s boolean. Legacy dispatch honesty, restated
after the M3 review: with no config, the `--dispatch-*` path posts phase 3's
original input shape (`{issueNumber, branch, repoSlug, baseBranch}`) and supplies
`repoSlug`/`baseBranch` from the `--dispatch-*` wiring, so phase-3-era workflow files loaded by
path keep working; the shipped `implement-issue` workflow's own input is D32's `{issueNumber}`
(and its extra legacy input fields are simply ignored on decode), and the
dispatcher additionally passes `repo` from the wiring so a D32-era workflow routed through the
legacy flags still gets a working `ctx.writeBack`. _Validated by:_ `src/server/concurrency.test.ts` —
two concurrent runs through the real server against slow-fake adapters over real sqlite, trees
independently intact, RunStarted dirs disjoint, plus a race regression: two near-simultaneous
POSTs at limit 1 yield exactly one 201 and one 409 —
plus the admission boundary tests (409 once the limit binds, dispatcher skipping at the
boundary) in `admission.test.ts` and `dispatch.test.ts`, and the registry-level
reservation/deferred-cancel tests in `runs.test.ts`. _Not covered here:_ the phase-5
plan also named a playwright leg with two live runs on screen; it rides with the exit criterion
(P6) rather than the fakes-provable P-step.

**P2 — `GET /api/workflows`** from the config's array, input schemas as JSON Schema (D30) — **done
(2026-09-15).** `src/server/http.ts` now takes the loaded `FactoryConfig` directly (the derived
`runEnv` option is gone), and `GET /api/workflows` maps the config's workflow array to
`{id, inputSchema}`, reusing the exact conversion `ctx.agent`'s `outputSchema` boundary performs
(`Schema.toJsonSchemaDocument(...).schema`, `run.ts:146`). No filesystem scan (D27). With no
config the endpoint serves an empty list, keeping the legacy path-based API unchanged; `daemon.ts`
passes `options.config` through and dropped its duplicate `toRunEnvironment`. _Validated by:_
`src/server/http.test.ts` — two TDD tests over the real server against
`test/fixtures/factory.config.ts` (a fixture config with a typed-input fixture workflow): the
registry lists the fixture's id with a JSON-Schema `object` input carrying its fields, and the
no-config path serves `[]`. Registering the config's array took
`FactoryConfig.workflows` to `WorkflowDefinition<any, any>` — the variance-erased form; the
concrete generics are unsound as array members since `run`'s input parameter is contravariant.
**P3 — `POST /api/runs {workflowId, input}` + `factory start` — done (2026-09-15).** D31, closing
the rest of G4. Resolving, decoding and starting live in `POST /api/runs`'s new `workflowId`
branch (`src/server/http.ts`): the id resolves against `options.config.workflows` (unknown → 404
with an `See GET /api/workflows` hint), `input` is decoded through the workflow's own Effect
Schema _before_ the run starts (`SchemaParser.decodeUnknownSync`, `run.ts`'s decode now belts and
braces — failure → 400), admission runs first (409 over `maxConcurrentRuns`, D29), and the
`dir`/clone/identity come solely from the config via D28's workspace allocation — nothing
filesystem-shaped from the caller. The path-based body survives unchanged for the dispatcher
(D31 retains it legitimately); a `workflowId` POST against a no-config daemon 404s (empty
registry). `factory start <workflowId> --input <json>` (`src/cli.ts`) is a thin HTTP client:
`--url` or `FACTORY_URL` (default `http://localhost:3000`), 201 → prints the `runId`;
404/400/409 all map to a one-hint stderr line and a non-zero exit; `--watch` tails
`GET /api/runs/:id/events` until a terminal event (exit 0 on RunFinished, 1 on RunFailed, 130 on
RunCancelled). `factory run` is untouched as the no-daemon path. _Validated by:_
`src/server/http.test.ts` — decode-failure 400, unknown id 404 (both against
`test/fixtures/factory.config.ts`), the D29 limit (409, then 201 once a slot frees) and the
success path (run allocated into a config workspace under a local seed repo, real sqlite events,
SSE to terminal) — plus `src/cli.start.test.ts`, three subprocess runs of
`bun src/cli.ts start` against a real `startDaemon` over real sqlite: runId printed, `--watch`
streaming RunStarted → AgentStepFinished → RunFinished with exit 0, and a 404 mapped to a
non-zero exit with the workflow id on stderr.

**P4 — Start and cancel in the UI — done (2026-09-15).** The New-run dialog sits in the top bar
(`src/web/components/new-run-dialog.tsx`) — no Workflows page, per the rescope — listing
`GET /api/workflows`' registry and generating D33's single-depth form from the chosen workflow's
input JSON Schema (`lib/start-form.ts`: a pure projection that renders `string`/`number`/
`boolean` properties one level deep — including Effect `Schema.Number`'s `anyOf` encoding with
the Infinity/NaN enum sidecar — and falls back to a raw-JSON textarea for anything else). Submit
posts `POST /api/runs {workflowId, input}`: 400/404/409 from the same D31 decode display inline,
201 navigates to the new run's detail page. Cancel reached the phase 3 cancel endpoint from two
surfaces: run detail's header while the run is active, and running rows in the runs list — one
`components/cancel-run-button.tsx` with an armed→`confirm cancel` two-click pattern (4s window)
in the achromatic instrument-panel language. `api.ts` gained `fetchWorkflows`/`startRun`/`cancelRun`
(`ApiError` carries the status and the server's operator hint), `hooks.ts` grew
`useWorkflows`/`useStartRun`/`useCancelRun` over React Query. The dropped Workflows page stub and
its nav item are gone. **The P4 legs also surfaced a phase 3 server bug** (P4's dialog/cancel
flows disconnect SSE clients mid-run constantly): a disconnected SSE client was never
unsubscribed from the fan-out, so a later event `enqueue`d into Bun's already-closed controller
and threw outside request context, killing the whole `serve()` process — `sseStream` now marks
itself closed by its own `cancel()` hook and try/catches the enqueue (`http.ts`), with a
regression test in `http.test.ts` proven to fail with the fix reverted. _Validated by:_ the
playwright legs `e2e/new-run.e2e.ts` (dialog → form → start → navigate → streaming → finished;
nested schema → raw-JSON fallback → both the client-side "invalid JSON" and the server's 400
inline) and `e2e/cancel.e2e.ts` (cancel from run detail and from a running row, both landing
`RunCancelled` in the store and shown cancelled in the UI) against the real daemon, whose
`e2e/server.ts` now serves a config (fixture registry + a local seed repo for D28's workspace
allocation), while `lib/start-form.test.ts` pins the projection in `bun test`.

**P5 — `implement-issue` becomes reusable — done (2026-09-15).** `branch` joined the PR-metadata
step's structured output (`PrMetadataOutput`, branch optional in the schema so recorded corpora
that predate it still decode), the tier-3 domain fallback (`resolvePrMetadata`) remains the
extraction-failure safety net and hardcodes `factory/issue-<n>`; `repoSlug`/`baseBranch` left the
workflow input and the `ctx.writeBack` call signature — the runtime now supplies them through
`StartRunOptions.repo` (`runtime/run.ts`), carried by `startTrackedRun` from the `FactoryConfig`
in `http.ts` and `daemon.ts` and, on the no-daemon `factory run` path, from the operator's
`factory.config.ts` when one exists. Collision handling is reactive in `writeBack`: push the hint;
if the push is rejected (branch exists remotely) or `gh pr create` reports the PR exists, the
runtime suffixes with the first 8 chars of the runId (minus its `run-` prefix), re-branches, and
retries once; `WriteBackResult` now carries the `branch` it actually used (`collided` flag
included), surfaced to the SPA as `WriteBackFinished.usedBranch` so the join on the started branch
stays intact. **Known limit:** the collision path may only ever be reached in a test —
agent-generated branch names differ per task, so nothing in normal use has ever hit it. The test
is its only exercise until a live run does collide. _Validated by:_ `src/lib/writeback.test.ts` —
three new tests against the local bare-repo fixture (push rejected by a rival branch on the
remote → retry lands on `factory/<hint>-<short runId>` and lands on the remote; a `gh pr create`
"already exists" failure retried the same way via a stateful fake `gh`; a clean push reported
un-collided with the branch it was given) — plus the corpus-replay test
(`workflows/implement-issue.test.ts`) updated to the new shape and asserting the fallback
`prBranch` end to end.

**P6 — Exit criterion, both legs**, matching the precedent phases 1, 3 and 4 set. _Fakes leg —
met (2026-09-15, finding 10):_ the whole validation stack green in one pass on HEAD — `bun test`
119 green, `typecheck`/`lint` exit 0, and the full playwright suite (11 specs) through
`nix develop` — with every fakes-provable clause of the exit criterion mapped to named tests and
specs in `docs/findings/10-phase5-exit-fakes-leg.md` (browser: `e2e/new-run.e2e.ts` +
`cancel.e2e.ts` + `transcript.e2e.ts`; script: `src/cli.start.test.ts`'s three real-subprocess
legs, script-side cancel being the same HTTP endpoint the UI uses; concurrency:
`src/server/concurrency.test.ts`). Nothing broke; the commit is docs-only. _Live leg — pending
user confirmation:_ two concurrent real runs started from the browser and watched to real PRs,
covering what fakes cannot prove — mirror staleness under real concurrent load, N concurrent real
`localProcess` agent processes, and D32's collision path reached in reality. Output: a live
findings document, and ADR 0005 moved from Proposed to Accepted.

**Exit:** a person who has never seen the CLI can start a run from the browser, watch its
transcript stream, and cancel it; a script can do the same through `factory start`; and two runs
can be in flight at once — the fakes leg provable in `bun test`/playwright without network or AI,
and the live leg watched end to end in the browser.

### Phase 6 — Harden

Isolation (docker + secrets, D7's deferral — note D28 gave phase 5 _concurrency_ without it, and
claimed no isolation in doing so), observability, cancellation correctness, and whatever phase 5's
live leg surfaces. Candidate bullets already queued from the phase-5 review pass: workflow inputs
are remote-facing since phase 5, so shell-command-from-input remains an operator hazard to close
(validate/escape or drop the pattern), and the daemon-wide admission-reservation story should get
a dispatcher-side admission-failure state that survives the claimed item (today a lost admission
race between reconcile and a manual start surfaces as a reconcile error and leaves the claimed
item stuck in progress).

## Start here

Phases 0–4 are complete on every exit criterion — fakes and live for 0–3, fakes-only for 4 by its
rescope. Bullets per phase are above; the full record is
[`docs/phases-completed.md`](docs/phases-completed.md).

**Next: phase 5's live leg (P6's second half) — gated on the user confirming.** The fakes leg is
met: 2026-09-15's one-pass validation run is recorded in
[`docs/findings/10-phase5-exit-fakes-leg.md`](docs/findings/10-phase5-exit-fakes-leg.md), which
also maps each exit-criterion clause to the tests that prove it and names what stays
unproven until the live leg. What remains for phase 5: **two concurrent real runs started from
the browser and watched to real PRs**, then a live findings document and ADR 0005 moved from
Proposed to Accepted — after which phase 5 closes. P1–P5 landed 2026-09-15; **every D27–D33
decision is built.**

Read **ADR 0005** first — it carries D27–D33 and, more usefully, the reasoning for the two things
that look like bigger jobs than they are. The short version:

- **Concurrency was a directory allocation, not a sandbox redesign — and P1 proved it.** D10
  already gives one sandbox per run via `threadId` (`run.ts:159`), so P1 only had to stop
  `resetClone`'s single shared `dir` being the last shared resource: `src/lib/workspace.ts`
  allocates a tree per runId from a refreshed local mirror.
- **There was no concurrency limit before P1.** One number in the config and one
  admission function (`src/server/admission.ts`) now cover both `POST /api/runs` (409) and
  the dispatcher (skip) — see `src/server/concurrency.test.ts`.

For the live leg, read **ADR 0005**'s exit-criterion shape and phase 1/3/4's precedent
(`docs/phases-completed.md`): two concurrent browser-started runs watched to real PRs, the thing
the fakes cannot attest. The P4 playwright legs (`e2e/new-run.e2e.ts`, `e2e/server.ts`) show the
daemon/config wiring a human runs `factory serve` against. P5's residue worth carrying into the
live leg: D32's collision retry has only ever been exercised by its test
(`src/lib/writeback.test.ts`), so a live run that collides stays a genuine unknown.

Left over from earlier phases, not exit-blocking, worth doing opportunistically:

- Run `workflows/implement-issue.ts` under `claudeCodeText` to see what a journal would have
  bought us, before D12 hardens into an assumption (D20 also wants this as the first real test
  of the opaque-passthrough bet).
- File the two root-caused library bugs upstream, so D16's workaround can eventually go. The
  marker-path one now has a second symptom worth citing: it pollutes the `sandbox.file` event
  stream with `/workspace` + host-absolute paths (finding 8).
- The stdout-marker-plus-settle-delay pattern in `src/cli.crash.test.ts` works but isn't a real
  synchronization primitive (finding 4) — revisit if it ever flakes in CI.
