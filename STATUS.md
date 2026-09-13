# STATUS

> **Phase 0 — complete.** 0a and 0b both ran green against a real target repo
> (`FreshlyBrewedCode/factory-spike`), producing a real PR
> (https://github.com/FreshlyBrewedCode/factory-spike/pull/3) and a 1059-line evidence log.
> Findings: `docs/phase0-findings.md`. Exit ADR: `docs/adr/0001-write-back-isolation-effect-boundary.md`.
> Phase 1 is next — see [Phases](#phases).

Project pitch, stack and constraints live in `AGENTS.md`. This file tracks where we are,
what we have decided, and what is still unknown.

## Where we are

Complete greenfield — no code, no scaffold, no dependencies installed. What exists is:

- a research pass (2026-09-13) over the two reference sources named in `AGENTS.md` plus the
  wayful dispatch script,
- a second pass over the five remaining `@tanstack/ai` sandbox doc pages, and
- a design session that turned the phase-0 open questions into decisions D7–D14.

All three are recorded below so phase 0 does not re-litigate them.

## Research findings (2026-09-13, first pass)

### mattpocock/sandcastle — narrower than the pitch implies

Read: [README](https://raw.githubusercontent.com/mattpocock/sandcastle/refs/heads/main/README.md).

Sandcastle is **not** a workflow engine. It is an orchestration library: `run()`,
`createSandbox()`, git worktrees, branch strategies, lifecycle hooks, `resume()` / `fork()`.
The unit of composition is a *git commit*, not a workflow node. There is no step graph, no
tool registry, no approval-gate primitive. "Workflows" are plain TypeScript control flow
against a warm sandbox:

```ts
await using sandbox = await createSandbox({ branch: "agent/fix-42", sandbox: docker() })
await sandbox.run({ agent: claudeCode(...), promptFile: ".sandcastle/implement.md" })
const tests = await sandbox.exec("npm test")   // non-zero exitCode is returned, not thrown
if (tests.exitCode !== 0) { /* ... */ }
```

Worth stealing: `exec` returning rather than throwing (that is the branching primitive),
worktrees as a first-class concept separate from the sandbox, and dirt-sensitive cleanup
(a dirty worktree is preserved on close, a clean one removed).

Worth knowing: branch strategies are `head`, `merge-to-head`, `branch`. `fork()` is
session-only — it isolates the transcript but not the worktree, so concurrent forks race
unless given distinct branches.

### @tanstack/ai sandboxes — strong inbound, no outbound

Read: [`docs/sandbox/overview.md`](https://raw.githubusercontent.com/tanstack/ai/main/docs/sandbox/overview.md),
[`workspace.md`](https://raw.githubusercontent.com/tanstack/ai/main/docs/sandbox/workspace.md),
[`portable-snapshots-fork.md`](https://raw.githubusercontent.com/tanstack/ai/main/docs/sandbox/portable-snapshots-fork.md).

The model is `chat()` middleware, not a run API:

```ts
chat({ threadId, adapter: opencodeText(...), messages, middleware: [withSandbox(def)] })
```

- `defineSandbox({ id, provider, workspace, lifecycle })` binds provider + workspace into a
  reusable definition; `withSandbox(def)` turns it on for a run.
- Harness adapters: `opencodeText`, `claudeCodeText`, `codexText`, `grokBuildText`,
  `acpCompatible`. Adapters declare `requires: [SandboxCapability]`, so a chat call without
  a sandbox middleware fails immediately rather than at runtime.
- Providers: `dockerSandbox`, `sbxSandbox`, `localProcessSandbox`, plus Daytona / Vercel /
  Sprites. Provider and auth are decoupled (`authMode` defaults to `'api-key'`; `'host'` for
  a machine with an existing CLI login).
- Execution is three stages: `withSandbox.setup` (resume → restore snapshot → create +
  bootstrap) → `adapter.chatStream` (spawn CLI in sandbox, stream **AG-UI chunks**) →
  `withSandbox.onFinish` (snapshot or destroy per `lifecycle`).

**Workspaces cover repo materialization well** — `defineWorkspace({ source, packageManager,
setup, scripts, secrets })`, plus `skills` / `plugins` / `instructions`. `source` accepts
`githubRepo({repo, ref, depth})`, `gitSource({url})`, a raw `{type:'git'}` literal,
`{type:'local', path}`, or `{type:'none'}`. Clones default to shallow single-branch. `setup`
runs over a **persistent shell** (cwd/env carry across steps).

**The gap: there is no write-back.** Nothing in the workspace docs covers branch, commit,
push, or merge-back — `ref` selects what to check out and that is all. `fork` is not a
substitute: it *copies* one named checkpoint into a thread that must be empty, with no merge
path. Sandcastle's `merge-to-head` has no equivalent here.

Also flagged in the docs and likely to bite during bootstrap: agent CLIs ship their native
binary as a platform-specific *optional* dependency, so `npm install -g` can exit 0 and leave
a CLI that dies later with `Missing optional dependency`. Invoke the CLI in the same setup
step (`npm install -g X && X --version`) so failure surfaces at bootstrap.

### wayful `dispatch-ready-issues.sh` — a reconciliation loop

Read: `../wayful/scripts/dispatch-ready-issues.sh`.

The GitHub plumbing is incidental; the safety semantics are the part to port:

1. Read Ready items in the project's own manual column order (`orderBy: POSITION`).
2. Skip hard-blocked issues — an open blocker counts as blocking *unless* it already has a
   linked PR (OPEN or MERGED both count as "work exists").
3. **Move to In Progress first, and treat that move as the claim/idempotency lock.** If the
   move fails (WIP limit), skip dispatch entirely.
4. While any failed auto-run exists, dispatch nothing new; instead retry each failed run with
   exponential backoff (`base * 2^count`, capped at 1440 min).
5. Reschedule self until the Ready column drains.

## Research findings (2026-09-13, second pass)

Read: `provisioning.md`, `lifecycle.md`, `providers.md`, `policy.md`, `events.md`,
`takeover.md`, plus the [OpenCode adapter page](https://tanstack.com/ai/v0/docs/adapters/opencode).
These five facts drove D7–D14.

### F1 — There is no host-side exec API

`withSandbox` is chat middleware and returns no handle. Nothing in overview / lifecycle /
providers / policy shows the *application* running a command in the sandbox. Only the agent
does, or `setup` at bootstrap. `scripts` on `defineWorkspace` exists to give Policy stable
names to match; the docs never say who invokes it, and the implication is the agent.

Consequence: on any non-local provider, Factory cannot shell into the box after a run. Our
write-back therefore depends on either the agent doing it, or the working tree being
somewhere Factory can already reach — which is D8.

### F2 — Sandbox identity is a key, and the adapter is not part of it

`sandboxInstanceKey = hash(threadId, sandbox id, provider, workspace hash, tenant)`.
Same `threadId` + same definition ⇒ same sandbox, *including across different adapters*.
`lifecycle.reuse: 'thread'` binds one sandbox per thread; `'none'` provisions per run.
`destroyOnComplete: false` keeps it alive between runs.

What is **not** specified: what happens when two runs share one key simultaneously. No
queuing, locking, or contention behaviour is documented. Concurrency inside one key is
undefined behaviour, not a supported mode.

### F3 — Session resume is opt-in, so fresh sessions are free

`opencodeText` emits `opencode.session-id` as a CUSTOM event; you resume a CLI session
*only* by threading it back via `modelOptions.sessionId`. Omit it and the run gets a fresh
session with no history. Combined with F2, one `threadId` gives one persistent sandbox while
every step still starts blind — exactly the shape D10 wants.

`opencodeText(model, { directory, permissionMode })` takes a **`directory`** (project path),
so pointing the harness at a Factory-owned directory is a first-class option, not a hack.

### F4 — Cancellation does not follow from closing the stream

Closing the IO stream does **not** terminate the agent process. An explicit cancel tears
down the sandbox regardless of `destroyOnComplete`, and the docs call it "the only reliable
way to stop the agent burning tokens." Killability is measured per provider:
`localProcess` ✅, `docker` ✅, `sprites` ✅ (unverified), `sbx` / `daytona` / `vercel` ❌.

Disconnect is a third case distinct from both completion and abort.

### F5 — TanStack persistence cannot reconstruct a run, and opencode has no journal

The message store persists text, tool-call names/args and tool results. It drops reasoning
**and every CUSTOM event** (`file.changed`, `sandbox.file`, session ids). All harness text
lands as a *single final assistant message*. So their persistence can never replay a run
timeline.

Separately: `opencodeText` and `acpCompatible` do not read NDJSON off stdout, so they have
**no journal even when a run is durable** — durable attach and takeover are unavailable for
our primary adapter. See D12 for why this is acceptable.

Useful events that *do* exist while a run is live: `file.changed` (after completion,
`{ path: '.', diff }` — the full working-tree diff), `sandbox.file` (per create/change/
delete), `sandbox.file.diff` (opt-in via `fileEvents: { diff: true }`). All typed as
`KnownCustomEvent`; match `chunk.name` against an exact literal, since `endsWith()` does not
narrow.

### Host environment (verified 2026-09-13)

| | |
|---|---|
| `gh` | authed as `FreshlyBrewedCode`, scopes `repo, project, read:org, gist`, protocol **ssh** |
| orgs | `BTGD2020`, `frebreco` |
| ssh → github | works |
| git identity | set **per-repo**, not globally: `FreshlyBrewedCode` / `karl@git.frebreco.de` |
| credential.helper | unset — SSH is the only working git transport |
| bun | 1.4.2 |
| opencode | 1.18.29, host login present (`~/.local/share/opencode/auth.json`) |
| opencode providers | `cpa` (tailnet, custom) and `opencode-go` (hosted gateway) |
| spike model | `opencode-go/deepseek-v4.1-flash` (confirmed available) |

## Decisions

D1–D6 come from the first research pass; D7–D14 from the 2026-09-13 design session.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Workflows are imperative**, plain `async (ctx) => {...}` TypeScript — no step graph, no declarative DSL. | This is what makes sandcastle pleasant. (`AGENTS.md` already says "imperative"; the earlier note that it said "declaritive" was stale.) |
| D2 | **Factory owns git write-back** (branch / commit / push / PR). TanStack AI provides inbound only. | Forced by the write-back gap. Also fits dispatch better than `merge-to-head`: the PR is exactly what the blocker check in the wayful script reads. |
| D3 | **One typed, append-only run-event log is the spine** shared by all three columns — runtime emits, sqlite stores, SSE replays, SPA renders. Define the event type in phase 1, before anything persists it. | Keeps the UI a thin client. F5 raises the stakes: TanStack's own persistence drops CUSTOM events and collapses harness text into one message, so our log is the *only* replay path that will ever exist. |
| D4 | **Effect owns the server** (lifecycle, sqlite, dispatch, scheduling). Workflow authoring stays plain async TS. The runtime is the bridge. | Effect-ifying the authoring surface costs the ergonomics that are the point of column 1. |
| D5 | Workflow modules export **`id` + input schema + the function** — a registration surface, not a step graph. | The daemon must enumerate and validate workflows without executing arbitrary files. |
| D6 | **Web UI deferred to phase 4; the HTTP/SSE API ships in phase 3** alongside a `factory watch` CLI. | Keeps the slice vertical without paying SPA cost early, and proves the API before a client depends on it. |
| D7 | **`localProcessSandbox` for phase 0 and the POC.** Docker deferred. | Start small. Host credentials, host `gh`, host opencode login all work with zero provisioning, and `localProcess` is `killable: true` so it still answers the cancellation question (F4). Accepted cost: zero isolation, no snapshots, and the spike proves nothing about credential injection. See Deferred. |
| D8 | **Factory owns the working tree.** Factory clones on the host into a directory it chose and hands that path to the harness (`opencodeText({ directory })`, and `source: { type: 'local', path }` on the workspace). | Three payoffs at once: (a) `localProcess` has no durable resume and re-bootstraps each run, so a sandbox-owned clone could wipe earlier steps — a host directory cannot; (b) F1 says Factory can never exec in the box, but it can always exec on a directory it owns; (c) the later docker move becomes a bind-mount question rather than a redesign. |
| D9 | **Write-back is a deterministic step in the workflow script**, not an agent instruction. Host-side `git` + `gh pr create` through `ctx.exec`, with git identity set repo-locally. | Makes D2 true rather than nominal. Commit message and branch name stop depending on whether the agent felt like producing good ones. `ctx.exec` returns exit codes rather than throwing (sandcastle's branching primitive). |
| D10 | **One `threadId` per run ⇒ one sandbox; every agent step is a fresh session.** Never pass `modelOptions.sessionId`. Context between steps is composed explicitly by the workflow script — nothing is inherited. | F2 + F3 make this free. The *tree* is the shared state between steps; the transcript deliberately is not. Agent steps returning structured metadata for later prompts is a wanted bonus, not a designed feature — add it when a real requirement appears. |
| D11 | **PR title and body come from an ordinary agent step in the workflow script**, working in the tree and returning structured output. Factory consumes `{ title, body }`; it does not generate them and does not hardcode the step. | Keeps Factory out of the business of knowing what a PR should say. It is just another step, composable and replaceable like any other. |
| D12 | **Crash recovery is deprioritized.** Factory runs as a long-lived server process. | TanStack's durability / attach / takeover machinery targets serverless hosts that lose the process between turns. Moot regardless: F5 says `opencodeText` has no journal, so none of it applies to our primary adapter anyway. Phase 2 shrinks to "mark interrupted runs and keep history queryable." |
| D13 | **Spike shape: workflow script → imported utilities → a runtime that executes the workflow.** Three pieces, even in 0a. No `defineWorkflow`, no registry, no schemas, no Effect. | The seam between "what a workflow author writes" and "what runs it" is the single most important thing phase 1 inherits. Getting it wrong in a flat script means discovering it late. |
| D14 | **0a dumps every raw stream chunk to NDJSON.** No schema, no types. | A corpus, not a log. Phase 1 designs D3's event type against real recorded chunks instead of the docs' summary of them. Costs about five lines. |
| D15 | **`localProcessSandbox({dir})` is how D8 is implemented, not `workspace.source: {type:'local', path}`** — the latter is dead code in the installed package. Pair it with `workspace: defineWorkspace({source:{type:'none'}, setup:[]})`. | 0a-1 finding #1: `bootstrapWorkspace()` has no `'local'` case; empirical inode/single-directory check confirmed in-place edits. D8's outcome (Factory owns the tree) held; its stated mechanism didn't. |
| D16 | **Keep `defineWorkspace(...)` configured under `localProcessSandbox` (even `{source:{type:'none'}, setup:[]}`), and clean the resulting stray `.tanstack-projected-*`/`data/` artifact before staging**, rather than trying to avoid `defineWorkspace` entirely. | A `workspace` object is required to get `lifecycle.reuse:'thread'` binding at all. The artifact is a reproducible library bug (0a-1 finding #5), not something workflow authors should know about — write-back owns the cleanup and hard-fails if any survives. |
| D17 | **Keep the explicit `Effect.onInterrupt` → `abortController.abort()` wiring in phase 1's agent-step Effect wrapper**, even though 0b's control experiment showed `Stream.fromAsyncIterable`'s implicit `.return()`-on-scope-close was sufficient in the tested case. | Cheap, never harmful, and covers the untested non-cooperative-abort case (a generator stuck somewhere `.return()` can't cleanly unstick). |
| D18 | **Use `Schema.TaggedError<T>()(tag, fields)` over `Data.TaggedError` for typed errors crossing the Effect boundary.** | Matches current-generation v4 guidance (`oxlint`'s `effecttsgo` rules); used for `AgentStepChunkError` with `Schema.Defect()` wrapping `cause: unknown`. |

## Open questions

All resolved in phase 0 — full verdicts and evidence pointers in
`docs/adr/0001-write-back-isolation-effect-boundary.md` (§4, "Which open questions turned out
wrong"). Summary:

| Question | Verdict |
|---|---|
| Structured output mechanism (D11) | confirmed at runtime |
| `source: {type:'local'}` in place or copy, needed at all under `localProcess`? | refuted — dead code; `localProcessSandbox({dir})` is the real mechanism (D15) |
| `threadId` + omitted `sessionId` behaves as F2/F3 predict? | confirmed, behaviorally |
| `localProcess` re-bootstrap destroys tracked files between steps? | refuted (did not destroy) — but only the `unchanged` outcome was exercised |
| Which CUSTOM events arrive from `opencodeText`? | refined — only `sandbox.file`, `opencode.session-id`, `structured-output.*`; never `file.changed`/`sandbox.file.diff` |
| Policy needed on `localProcess`? `acceptEdits` behave as documented? | refuted as relevant (policy never consulted) / confirmed (`acceptEdits` worked) |
| Cancellation across the Effect boundary (0b) | confirmed, with a refinement to F4 (§3 of the ADR) |

**Genuinely still unknown, carried into phase 1+** (also in the Deferred table below):

- True sandbox-instance-level reuse, independent of the marker-file's disk-state idempotency.
- Whether the explicit `abort()` wiring is ever load-bearing (only tested against a generator
  suspended at a clean yield point; a non-cooperative case was never constructed).
- Multi-chunk `delta` accumulation for a single `TEXT_MESSAGE` (never observed in either 0a-2
  run's corpus; verified by code inspection only).

## Deferred, with triggers

Recorded so they stay visible rather than becoming invisible "later"s.

| Deferred | Trigger to revisit |
|---|---|
| `dockerSandbox` + credential injection via `createSecrets` | First untrusted repo, or first time two runs must be concurrent |
| Host-side patch write-back (consume `file.changed` diff, `git apply` on host) | Any move off `localProcess` — D9's host-side git stops working the moment the tree is in a container |
| Private-repo clone auth inside a sandbox (`secret:` refs are documented only on `gitSkill`, not on `source`) | Same trigger as docker |
| Concurrency isolation — N sandboxes with one worktree each, rather than one shared tree (F2: contention within a key is undefined) | Phase 3, when the dispatcher can start more than one run |
| Durable attach / takeover, and adapters that have journals (`claudeCodeText`, `codexText`) | Only if Factory stops being a long-lived process (D12) |
| Portability of the spike off this machine | Reduced already — `opencode-go` is a hosted gateway rather than the tailnet `cpa` provider — but a second machine still needs an opencode login |
| Sandbox-instance-level reuse probe (nonce file written at bootstrap, compared byte-for-byte across steps) — distinguishes true reuse from disk-state idempotency | Phase 1, when the run context's sandbox lifecycle is designed against D10 |
| Non-cooperative abort case (generator stuck inside something `.return()` can't unstick, e.g. an in-flight `fetch()` with no cancellation token) | First real timeout/cancel bug report against a non-tool-call step |
| `@tanstack/ai-sandbox`/`ai-sandbox-local-process` stray-artifact workaround (`cleanStrayArtifacts` in `writeback.ts`, root-caused in 0a-1 finding #5 — a path-double-resolution bug in `handle.js`'s `resolve()`) | Drop the workaround once an upstream release fixes the marker-path resolution — recheck on every `@tanstack/ai-sandbox*` version bump |

## Phases

### Phase 0 — Spike & scaffold — complete

Produce *decisions*, not architecture. All spike code is throwaway and may be hardcoded.

- **0c — Starved scaffold (first).** `bun init`, tsconfig, oxfmt, oxlint (type-aware +
  effect rules), `bun test`. No Effect, no layers, no structure — just enough that 0a lives
  in the repo with types and formatting instead of in `/tmp`.

- **0a — Round-trip spike.** Hardcoded to `FreshlyBrewedCode/factory-spike` issue #1.
  Structured per D13 as workflow script + utilities + runtime. The full sequence:

  1. Factory clones the repo host-side into a directory it chose (D8)
  2. **Agent step 1** — implement, `opencode-go/deepseek-v4.1-flash`, fresh session
  3. `ctx.exec('bun test')` on the host — exit code returned, not thrown
  4. **Agent step 2** — fix, fresh session, same sandbox. **Asserts step 2's files are still
     present**, which is the single most important thing phase 0 can learn
  5. `ctx.exec('bun test')` again
  6. **Agent step 3** — read the tree, return structured `{ title, body }` (D11)
  7. Deterministic write-back: branch, commit, push, `gh pr create` (D9)
  8. Every chunk from every step appended to NDJSON throughout (D14)

  **Success = a PR URL on stdout.** Failure anywhere is informative; the assertion at step 4
  is the one that most changes later phases.

- **0b — Effect v4 ↔ TanStack AI boundary.** Narrowed to one assertion: wrap one
  `chatStream` as an Effect `Stream`, interrupt the fiber, confirm the explicit cancel fires
  and the opencode process is gone. Meaningful only once 0a has shown the stream shape.

**Exit:** an ADR written *from the findings* recording the write-back strategy as tested, the
isolation model, the Effect boundary, and which of the open questions above turned out to be
wrong. Deliberately not written in advance — a pre-spike ADR would be speculation with a
decision-record header.

**Spike repo:** `FreshlyBrewedCode/factory-spike`, private, seeded with a minimal bun TS
package (`package.json`, `src/index.ts` with one exported function, a passing
`src/index.test.ts`, tsconfig) so the agent has a pattern to imitate and `bun test` is a real
verification step. Issue #1: *"Add a `slugify(input: string): string` export, with tests."*
Not yet created.

### Phase 1 — Workflow runtime (column 1) ← **we are here**

The `defineWorkflow` surface, the run engine, run context (`ctx.agent()`, `ctx.exec()`,
typed output), and the event type from D3 — designed against the NDJSON corpus from D14.
In-memory; no server, no sqlite.

**Build a fake agent adapter here** so workflows are testable under `bun test` without
burning tokens — it pays for itself every later phase. CLI: `factory run <workflow.ts>`.

Cheap experiment worth doing here: run the same workflow under `claudeCodeText` to see what
a journal would have bought us (F5), before D12 hardens into an assumption.

**Exit:** a real implement → test → review workflow runs end-to-end against opencode.

### Phase 2 — Persistence & lifecycle

Effect layers, sqlite, event log as source of truth, run / step / artifact tables. Crash
recovery scoped down per D12: mark interrupted runs, keep history queryable. Still
CLI-driven.

**Exit:** kill the process mid-run, restart, and the run's history is intact and queryable.

### Phase 3 — Server & dispatch (column 3)

HTTP API + SSE replay over the log; run create / cancel / list / get. Dispatcher as a
reconciliation loop with a pluggable source (GitHub project first), porting the claim-lock,
WIP-limit, pause-on-failure and backoff semantics from the wayful script.

This is where concurrency stops being deferrable — see the Deferred table.

Optional and cheap: a ~100-line single-file HTML+SSE run viewer, to prove the event stream is
UI-shaped before React touches it.

**Exit:** the daemon picks up a Ready issue unattended, runs the workflow, opens a PR, and
the run is watchable over SSE.

### Phase 4 — Web UI (column 2)

React SPA, TanStack Router + Query, shadcn, tailwind. Board view + live run detail over SSE.
Thin, because the API predates it.

### Phase 5 — Harden

Per-run isolation and concurrency, docker + secrets (D7's deferral), observability,
cancellation correctness.

## Start here

1. **0c** — scaffold the repo, starved. Bun + tsconfig + oxfmt + oxlint + `bun test`.
2. **Create `FreshlyBrewedCode/factory-spike`** per the spec in phase 0, seeded, with issue #1.
3. **0a** — write the spike as workflow script / utilities / runtime (D13) and run the
   eight-step sequence above until a PR URL appears.
4. Record what the open questions turned out to be, then write the exit ADR.

Do **not** start on `defineWorkflow`, sqlite or the server until 0a has run green — the
write-back and isolation answers will shape the run context's API.
