# Pre-spike reading notes (2026-09-13)

Two research passes and a design session, all done **before** any code ran. They produced
decisions D1–D14 in `STATUS.md`.

These notes are kept as written, with **post-spike verdicts** added inline where phase 0
contradicted them. They are annotated rather than corrected in place: the point is to preserve
what we believed and why, so a future wrong turn is traceable to the reading that caused it.

Evidence that overturned these claims lives in `docs/findings/`. The conclusions drawn from it
live in `docs/adr/0001-write-back-isolation-effect-boundary.md`.

## First pass

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

> **Post-spike:** still accurate, and the `exec`-returns-not-throws primitive was adopted and
> validated in 0a-2. Nothing here was contradicted.

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

> **Post-spike:** the write-back gap is confirmed and drove D2/D9, which worked. But the
> `source` list above is **wrong for `localProcessSandbox`**: `bootstrapWorkspace()` only
> handles `source.type === 'git'`; `'local'` and `'none'` are no-ops, so
> `{type:'local', path}` does nothing. `localProcessSandbox({dir})` is the real mechanism —
> see D15 and `docs/findings/0a-1-single-agent-step.md`. The `npm install -g` hazard was never
> hit, because `localProcess` uses the host's existing opencode install.

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

> **Post-spike:** untouched by phase 0 — nothing dispatch-related was built. Still the plan
> of record for phase 3.

## Second pass — facts F1–F5

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

> **Post-spike: unfalsified, never directly tested.** D8 made it moot — Factory execs against
> a host directory it owns, so it never needed a sandbox exec API. Becomes live again on any
> move to docker.

### F2 — Sandbox identity is a key, and the adapter is not part of it

`sandboxInstanceKey = hash(threadId, sandbox id, provider, workspace hash, tenant)`.
Same `threadId` + same definition ⇒ same sandbox, *including across different adapters*.
`lifecycle.reuse: 'thread'` binds one sandbox per thread; `'none'` provisions per run.
`destroyOnComplete: false` keeps it alive between runs.

What is **not** specified: what happens when two runs share one key simultaneously. No
queuing, locking, or contention behaviour is documented. Concurrency inside one key is
undefined behaviour, not a supported mode.

> **Post-spike: refined.** Observed behaviour is *consistent with* reuse (`sandbox.file` fires
> only on the first step of a thread) but does not prove it — the gate is a disk-state marker
> check, so a freshly recreated handle pointed at an already-marked directory looks identical.
> A nonce probe is deferred to phase 1. The concurrency gap is unchanged and untested.

### F3 — Session resume is opt-in, so fresh sessions are free

`opencodeText` emits `opencode.session-id` as a CUSTOM event; you resume a CLI session
*only* by threading it back via `modelOptions.sessionId`. Omit it and the run gets a fresh
session with no history. Combined with F2, one `threadId` gives one persistent sandbox while
every step still starts blind — exactly the shape D10 wants.

`opencodeText(model, { directory, permissionMode })` takes a **`directory`** (project path),
so pointing the harness at a Factory-owned directory is a first-class option, not a hack.

> **Post-spike: confirmed behaviourally.** Distinct session ids per step, and no trace of any
> prior step's prompt or response in a later step's chunk stream.

### F4 — Cancellation does not follow from closing the stream

Closing the IO stream does **not** terminate the agent process. An explicit cancel tears
down the sandbox regardless of `destroyOnComplete`, and the docs call it "the only reliable
way to stop the agent burning tokens." Killability is measured per provider:
`localProcess` ✅, `docker` ✅, `sprites` ✅ (unverified), `sbx` / `daytona` / `vercel` ❌.

Disconnect is a third case distinct from both completion and abort.

> **Post-spike: refined, and this is the most consequential correction phase 0 made.** Under
> `Stream.fromAsyncIterable` consumption the process died even with *zero* explicit `abort()`
> wiring, because `Channel.fromAsyncIterable` always calls `.return()` on the source iterator
> at scope close, reaching the generator's own `finally` → `proc.kill()`. The raw
> `for await` + `break` case F4 describes was never retested and is still presumed true. We
> keep the explicit wiring regardless (D17). See `docs/findings/0b-effect-boundary.md` A3.

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

> **Post-spike: the persistence claim is untested; the event list is refuted.** We never
> enabled TanStack persistence, so "it cannot replay a timeline" remains unverified. But
> `file.changed` and `sandbox.file.diff` **never arrived** across every run recorded — the
> opencode adapter only ever emits `opencode.session-id` / `opencode.todo`, and `sandbox.file`
> comes from the sandbox middleware's watcher, not the adapter. The full observed inventory is
> in `docs/findings/0a-2-round-trip.md`. This strengthens rather than weakens D3: our own
> event log really is the only replay path that will exist.
