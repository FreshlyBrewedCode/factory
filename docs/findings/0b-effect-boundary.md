# 0b — Effect boundary

Covers the 0b spike subtask: the Effect v4 to TanStack AI boundary, specifically whether fiber
interruption actually kills the opencode process. Ran 2026-09-13, commit `22d1961`. Headline
result: interruption reliably killed the process in all 4 runs, and — the most important
finding — the process died even in the control condition with no explicit `abort()` wiring,
via `Stream.fromAsyncIterable`'s own scope-finalizer `.return()` call. See A3 below.

Scope: the Effect v4 ↔ TanStack AI boundary. Does fiber interruption
actually kill the opencode process, and what does it take to make that
happen? Not the full round trip, not the server/dispatch layer (D4) — one
agent step, wrapped as an Effect `Stream`, interrupted mid-flight, with `ps`
evidence before/after (the task's explicit instruction: "trust `ps`, not the
types").

## What was built

Two new files under `src/spike/`, alongside (not replacing) the plain-async
0a code, per D13's seam — this is runtime/lib-layer code, not something a
workflow author would write:

- **`src/spike/lib/effect-agent-step.ts`** — `agentStepEffect(options)`: the
  same `chat()` + `withSandbox(localProcessSandbox)` + `opencodeText` +
  `AbortController` plumbing as `lib/agent-step.ts`, but returns
  `{ effect: Effect.Effect<EffectAgentStepResult, AgentStepChunkError>,
  abortController }` instead of a `Promise`. The chunk stream is
  `Stream.fromAsyncIterable(iterable, onError)`, bookkeeping (chunk counts,
  custom-event names, `finalAssistantText`, structured output, `runError`)
  is done via `Stream.mapEffect`, and the whole thing is drained with
  `Stream.runDrain`. Every chunk is still appended to the NDJSON sink first,
  unconditionally (D14).
- **`src/spike/effect-boundary-experiment.ts`** — the harness. For each of 4
  runs (2× `interruptBehavior: "abort"`, 2× `"none"`): reset the clone,
  start the effect via `Effect.runFork`, wait for `onChunk` to report at
  least 3 chunks (not just fiber start), grace-wait 1.5s, snapshot `ps`,
  call `Effect.runPromise(Fiber.interrupt(fiber))` and time it, snapshot
  `ps` again immediately, then poll `ps` every 1s for up to 30s watching for
  the pre-interrupt PIDs to vanish, then inspect the fiber's raw `Exit` via
  `Effect.runPromise(Fiber.await(fiber))`, then `git status --porcelain` the
  clone. Entry point: `bun run src/spike/effect-boundary-experiment.ts`.
  The driving prompt asks the agent to run a 200-second bash `for`/`sleep`
  loop via its own bash tool, so there's a wide, deterministic window to
  interrupt into mid-tool-call, well before natural completion.

## The interruption-to-abort wiring (the part phase 1 inherits)

```ts
// src/spike/lib/effect-agent-step.ts (abridged to the load-bearing part)
const rawStream = Stream.fromAsyncIterable(
  iterable, // chat()'s returned AsyncIterable<unknown>
  (cause) => new AgentStepChunkError({ cause }),
);

const processed = Stream.mapEffect(rawStream, (chunk) =>
  Effect.promise(async () => {
    /* bookkeeping + NDJSON append, mirrors lib/agent-step.ts */
  }),
);

const drain = Stream.runDrain(processed);

const guarded =
  options.interruptBehavior === "abort"
    ? Effect.onInterrupt(drain, () =>
        Effect.sync(() => {
          options.onInterruptFinalizer?.();
          abortController.abort();
        }),
      )
    : drain;
```

`Effect.onInterrupt(effect, finalizer)` is the correct primitive: per its own
doc comment in `node_modules/effect/dist/Effect.d.ts` ("Runs the specified
finalizer effect if this effect is interrupted"), the finalizer fires only
on interruption, not on every exit. Two alternatives were checked and
rejected: `Effect.ensuring`/`Stream.ensuring` fire on **every** exit
(success, failure, *and* interrupt — doc comment confirms this, so it can't
isolate "was this actually cancelled"), and there is no `Stream.onInterrupt`
or `Stream.acquireRelease` in this v4 RC (`Stream.d.ts` has neither — only
`Stream.ensuring`, `Stream.unwrap`, `Stream.scoped`). The finalizer is
attached to the **effect returned by `Stream.runDrain`**, not to the
`Stream` value itself — Effect's stream combinators don't expose an
interrupt-specific hook, so the wiring has to happen one level up, at the
point where the stream becomes a run-able `Effect`.

## Effect v4 API notes for phase 1

- `Stream.fromAsyncIterable(iterable, onError)` exists as documented, but
  it is not a bare wrapper — read `Channel.fromAsyncIterable` in
  `node_modules/effect/dist/Channel.js` (~line 1422): it registers its own
  scope finalizer that calls the source iterator's `.return()` on early
  scope closure (e.g. fiber interruption), **independent of anything this
  file adds**. `chat()`'s returned `AsyncIterable` is an async generator
  (`node_modules/@tanstack/ai-opencode/src/adapters/text.ts`'s `async
  *chatStream`), so `.return()` on it injects a return completion at its
  current `yield` point and runs the generator's own `finally` block. This
  is a real, load-bearing behavior of `Stream.fromAsyncIterable` that isn't
  obvious from the public docs, and it turned out to matter — see A3 below.
- No `Stream.onInterrupt`, no `Stream.acquireRelease` in this RC. Confirmed
  by reading `Stream.d.ts` in full, not just grepping for the expected name.
- `Fiber.interrupt(fiber): Effect<void>` — per its doc comment, "the
  returned Effect completes only after the interrupted fiber has completed"
  (including running its finalizers). This does **not** mean the real-world
  side effect the finalizer triggered (here, the opencode process exiting)
  has also completed by the time the promise resolves — see A6.
- `Fiber.await` is exported under that name but implemented internally as
  `await_` (`Fiber.d.ts` line ~174, aliased `await_ as await` at the bottom
  of the file) — a naive `grep "declare const await:"` misses it.
- `Data.TaggedError` exists and works as expected, but the current-generation
  guidance (surfaced by `oxlint`'s `effecttsgo(prefer-schema-over-json)`-
  adjacent rules and the v4 docs) points at `Schema.TaggedError<T>()(tag,
  fields)` instead; used that here (`AgentStepChunkError`) with
  `Schema.Defect()` for the wrapped `cause: unknown` field — both exist and
  are exported from the top-level `effect` package (`index.d.ts` confirms
  `Schema`, `Data`, `Effect`, `Stream`, `Fiber`, `Exit`, `Cause` are all
  re-exported as namespaces).
- `oxlint`'s `effecttsgo` rule set flags essentially every plain
  `async function`, `Date.now()`, `setTimeout`, `console.log`, and
  `node:fs`/`node:path` import in both new files as "consider the Effect
  API instead" — all warnings, zero errors, same as every other file in
  `src/spike/`. This spike/harness code intentionally stays host-side plain
  async (matching D13's "workflow/runtime stays plain async, Effect owns
  the actual runtime layer once it exists" framing) — the warnings are
  expected noise, not something this task fixed.

## Run evidence

One full harness run completed cleanly end-to-end:
`harnessRunId=harness-1789309619614`,
`.factory/runs/harness-1789309619614/{stdout.log,results.json}`, model
`opencode-go/deepseek-v4.1-flash`, target clone
`.factory/factory-spike` (reset fresh before each of the 4 experiments). A
first attempt (`harness-1789309541316`) was killed mid-run by an
unrelated environment interruption after 2 of 4 experiments (no
`results.json` was written for it) — its partial log is consistent with the
successful run below wherever they overlap (same `finalizerRan=true`,
`abortController.aborted=true`, same defunct→gone pattern) but is not cited
as primary evidence; only the completed run is.

## A1 — does the finalizer actually run?

**Yes, every time `interruptBehavior: "abort"` was configured (2/2 runs);
never when it wasn't (0/2 runs, as designed — the control condition
registers no interrupt-specific finalizer at all).** Proof is a boolean
flip inside the finalizer closure itself (`onInterruptFinalizer`), not
inference from `ps`:

```
abort#1: finalizerRan=true  abortController.aborted=true
abort#2: finalizerRan=true  abortController.aborted=true
control#3: finalizerRan=false  abortController.aborted=false
control#4: finalizerRan=false  abortController.aborted=false
```

(from `.factory/runs/harness-1789309619614/results.json`, fields
`finalizerRan`/`abortControllerAbortedAfterInterrupt`).

## A2 — is the opencode process actually gone after interruption?

**Yes, in all 4 runs.** Verbatim `ps -eo pid,ppid,cmd` evidence (filtered
for `/opencode/i`, excluding `grep`, exactly as `runtime.ts`'s
`opencodeProcessSnapshot()` does) for the two `abort` runs:

```
[exp:abort#1] ps BEFORE interrupt (chunks=5, pids=["7528"]):
   7528    7490 opencode serve --hostname=0.0.0.0 --port=4096
[exp:abort#1] Fiber.interrupt awaited in 1490ms. finalizerRan=true abortController.aborted=true
[exp:abort#1] ps IMMEDIATELY AFTER awaited interrupt (pids=["7528"]):
   7528    7490 [.opencode-wrapp] <defunct>
[exp:abort#1] settle poll @2508ms: pidsRemaining=[]

[exp:abort#2] ps BEFORE interrupt (chunks=5, pids=["7627"]):
   7627    7490 opencode serve --hostname=0.0.0.0 --port=4096
[exp:abort#2] Fiber.interrupt awaited in 903ms. finalizerRan=true abortController.aborted=true
[exp:abort#2] ps IMMEDIATELY AFTER awaited interrupt (pids=["7627"]):
   7627    7490 [.opencode-wrapp] <defunct>
[exp:abort#2] settle poll @1924ms: pidsRemaining=[]
```

PID 7528/7627 (the `opencode serve` process, parented directly by the
harness's own `bun run` process, PID 7490 — no intermediate shell) is
present and running immediately before interrupt, is a `<defunct>` zombie
immediately after `Fiber.interrupt`'s promise resolves, and is **fully gone**
(not even a zombie entry) by the first settle poll ~1-1.6s later. No
`forceKilledPids` were needed in either run (`results.json`:
`"forceKilledPids": []`). The `<defunct>`→gone transition happening on its
own (no explicit `wait()`/reap call anywhere in this codebase) means Bun's
own child-process management reaps it, not this harness.

## A3 — control experiment (interrupt without wiring `abort()`)

**Surprising result: the process died anyway, on a timeline indistinguishable
from the `abort`-wired runs. F4's prediction ("closing the IO stream does
not terminate the agent process") did NOT hold for this specific pathway.**
This is the single most important finding of 0b — flagged in
BLOCKERS/CONTRADICTIONS below, not buried here.

```
[exp:control#3] ps BEFORE interrupt (chunks=5, pids=["7716"]):
   7716    7490 opencode serve --hostname=0.0.0.0 --port=4096
[exp:control#3] Fiber.interrupt awaited in 1774ms. finalizerRan=false abortController.aborted=false
[exp:control#3] ps IMMEDIATELY AFTER awaited interrupt (pids=["7716"]):
   7716    7490 [.opencode-wrapp] <defunct>
[exp:control#3] settle poll @2790ms: pidsRemaining=[]

[exp:control#4] ps BEFORE interrupt (chunks=5, pids=["7859"]):
   7859    7490 opencode serve --hostname=0.0.0.0 --port=4096
[exp:control#4] Fiber.interrupt awaited in 1725ms. finalizerRan=false abortController.aborted=false
[exp:control#4] ps IMMEDIATELY AFTER awaited interrupt (pids=["7859"]):
   7859    7490 [.opencode-wrapp] <defunct>
[exp:control#4] settle poll @2741ms: pidsRemaining=[]
```

`finalizerRan=false` and `abortControllerAbortedAfterInterrupt=false`
confirm no explicit `abort()` was ever dispatched in these two runs — this
module registered no interrupt-specific finalizer at all for
`interruptBehavior: "none"`. Yet the process reached the identical
`<defunct>`→gone end state, on a comparable timeline (settle at 2790ms/
2741ms vs. 2508ms/1924ms for the abort-wired runs — well within the same
order of magnitude, not "eventually, much later").

**Reconciling this with F4 and the Effect v4 API note above**: F4 was
established in 0a using a plain `for await` loop that, on early exit
(`break`/`return`/exception), does **not** reliably call `.return()` on the
underlying async iterator — that's an ordinary JS gotcha with manual
`for await`, and 0a never exercised abandoning the loop early at all (every
0a run reached `RUN_FINISHED` normally). `Stream.fromAsyncIterable`,
however, is not a plain `for await` — per the Channel.js finding above, it
**always** registers a scope finalizer that calls `.return()` on the
iterator when its scope closes, and fiber interruption closes that scope.
So `Fiber.interrupt` alone, with **zero** explicit wiring from this file,
still reaches `chat()`'s async generator's `.return()`, which reaches the
generator's own `try/finally` (`server.dispose()` → `proc.kill()`, per
`adapters/text.ts`), which kills the process — the same destination F4 said
only explicit `abort()` could reach, just via a different route this file
didn't build. **This is a refinement of F4 scoped to "consumption via
`Stream.fromAsyncIterable`", not a wholesale contradiction of F4's original
claim about the raw `for await` case** (which was never re-tested here and
is still presumed true).

**Caveat, stated plainly**: this experiment's agent was always caught
mid-way through a long bash-tool-call, i.e. the generator was very likely
suspended at a clean internal `await`/`yield` point (waiting on the next
item from its internal event queue) when `.return()` landed. Whether
`.return()` alone is equally effective if the generator is suspended
somewhere `.return()` can't cleanly unstick — e.g. mid-way through an
in-flight `fetch()` with no cancellation wiring of its own — was **not**
tested. The explicit `abort()` wiring may still be the only reliable path
in that case; A3 only shows it isn't *always* necessary, not that it's
never necessary. Given this uncertainty, phase 1 should **keep** the
explicit `Effect.onInterrupt` → `abort()` wiring (it is strictly redundant
here, never harmful, and cheap) rather than relying on
`Stream.fromAsyncIterable`'s implicit `.return()` alone.

## A4 — fiber exit shape

**Clean `Interrupt`, in all 4 runs — never a defect, never a hang.** Every
run's `Effect.runPromise(Fiber.await(fiber))` (called after the process was
confirmed settled) returned `Exit.isFailure(exit) &&
Exit.hasInterrupts(exit) === true`, with `Cause.pretty(exit.cause)`:

```
InterruptError: All fibers interrupted without error {
  [cause]: InterruptCause: The fiber was interrupted by:
      at fiber (#2)
}
```

(fiber numbers #2/#5/#8/#11 differ per run — each experiment forks a fresh
fiber tree). This directly answers "does the `for await` loop throw,
surfacing as an Effect defect?" — **no**: `Channel.fromAsyncIterable`'s
`Effect.tryPromise({ try: () => iter.next(), catch: onError })` wraps the
iterator's `.next()`, but interruption itself is delivered as a genuine
Effect interrupt signal (via the scope closing, per the Channel.js finding
above), not as a thrown JS exception racing the `.next()` call. No run in
this session produced a `Die`/defect exit or an unresolved `Fiber.await`
call.

## A5 — sandbox/tree state after interrupt

**No corruption or half-written files beyond the pre-existing, already
root-caused `data/…/.tanstack-projected-<hash>` stray artifact from
[0a-1](./0a-1-single-agent-step.md) finding #5 — same bug, not something interruption newly caused.** Every
run's `git status --porcelain` after interrupt showed exactly `?? data/`
(from `results.json`, field `gitStatusAfter`, identical across all 4 runs).
Inspecting the actual clone directory after the harness finished:

```
$ find .factory/factory-spike/data -type f
.factory/factory-spike/data/src/factory/.factory/factory-spike/.tanstack-projected-1e95f9272dfe038f
```

— byte-for-byte the same nested-path shape [0a-1](./0a-1-single-agent-step.md) finding #5 root-caused
(the `handle.js` `resolve()` double-resolution bug), reproduced here again
because `defineWorkspace(...)` was configured the same way. No tracked file
(`src/`, `package.json`, etc.) was touched, truncated, or reverted in any
of the 4 runs; no partial/half-written non-artifact files were found.
**Interruption specifically does not appear to leave anything worse behind
than a normal completed run already does** — the known artifact bug is
orthogonal to cancellation.

## A6 — timing: interrupt call to process actually gone

**Not synchronous, and the awaited `Fiber.interrupt` promise resolving is
not sufficient on its own to conclude the process is gone — it only
guarantees the *finalizer effect* (including the `abort()` call, when
wired) has run to completion.** Concretely, from `results.json`:

| run | `interruptAwaitedMs` (time for `Effect.runPromise(Fiber.interrupt(fiber))` to resolve) | state at that moment | `disappearedAtMsSinceInterruptStart` (first settle poll with 0 remaining PIDs) |
|---|---|---|---|
| abort#1 | 1490ms | `<defunct>` (zombie, not yet reaped) | 2508ms |
| abort#2 | 903ms | `<defunct>` | 1924ms |
| control#3 | 1774ms | `<defunct>` | 2790ms |
| control#4 | 1725ms | `<defunct>` | 2741ms |

In every run, the process had already **exited** (visible as `<defunct>`)
by the moment `Fiber.interrupt`'s promise resolved — but it takes roughly
another ~0.2-1s (bounded above by the 1000ms settle-poll granularity used
here, so the true gap could be smaller) after that for the zombie entry to
be reaped and disappear from `ps` entirely. So: **`Fiber.interrupt`'s await
is a reliable signal that the kill was *initiated* and the underlying
process has *exited* (already `<defunct>` by the time it resolves), but a
caller that needs "confirmed fully gone from the process table" (e.g.
before reusing a port or directory) should poll briefly afterward rather
than trusting the awaited promise alone.** The `interruptAwaitedMs` values
themselves (903-1774ms) also show interruption is not instantaneous even at
the Effect level — cooperative interruption + the generator's own
`finally`-block teardown (`session.abort()`'s best-effort HTTP call,
`server.dispose()`) takes on the order of one second, consistent across
both `abort` and `control` conditions.

## Still untested (0b)

- **Whether the explicit `abort()` wiring is ever load-bearing** — A3 shows
  it wasn't necessary in this exact scenario (generator suspended at a
  clean internal yield point mid-tool-call), but a generator stuck inside
  something `.return()` can't cleanly interrupt (e.g. an in-flight HTTP
  call with no cancellation token of its own) was never constructed. The
  wiring is kept for phase 1 regardless, as cheap insurance.
- **Interruption very early**, before the chunk-flow threshold (i.e.
  interrupting before the opencode server process has even fully started)
  — every run here waited for ≥3 chunks plus a 1.5s grace period first.
- **Interruption of a step that has already reached `RUN_FINISHED`** (i.e.
  racing interrupt against natural completion) — not attempted; every
  interrupt in this session landed while the agent was still mid-tool-call.
- **Concurrent/overlapping fibers on the same or different sandboxes being
  interrupted independently** — every run here was strictly sequential
  (one experiment fully settles, including its own clone reset, before the
  next starts).
- **The exact sub-second gap** between the underlying OS process actually
  exiting and `Fiber.interrupt`'s promise resolving, and between exit and
  zombie-reap — only bounded (≤1490-1774ms for the former, ≤~1s for the
  latter, per the 1000ms settle-poll granularity used here), not measured
  precisely; a tighter poll interval or an OS-level exit-event hook would
  narrow this for phase 1 if it matters there.
- One harness run (`harness-1789309541316`) was killed mid-execution by an
  unrelated environment interruption after producing 2 of 4 experiments'
  worth of (consistent, corroborating, but not separately relied-upon)
  evidence — its `stdout.log` survives at
  `.factory/runs/harness-1789309541316/stdout.log` for reference but no
  `results.json` was written for it.

## Verification run (pre-commit)

See the final report for pasted output of `bun run typecheck`, `bun run
lint`, `bun run format`, and `bun test`.
