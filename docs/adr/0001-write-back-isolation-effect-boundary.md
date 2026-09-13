# 0001. Write-back, isolation, and the Effect boundary — as tested in phase 0

## Status

Accepted, 2026-09-13. Written after the fact, from evidence, per `STATUS.md`'s phase-0 exit
criterion ("deliberately not written in advance — a pre-spike ADR would be speculation with a
decision-record header").

## Context

Phase 0 was a spike, not architecture: three runs (0a-1, 0a-2, 0b) against a real target repo,
`FreshlyBrewedCode/factory-spike`, under commits `167744d`, `cd3b241`, `b752f0b`, `49b41df`,
`22d1961`. It produced a real PR
([`factory-spike#3`](https://github.com/FreshlyBrewedCode/factory-spike/pull/3)) and a
1059-line evidence log — since split into one document per subtask under `docs/findings/`
(`docs/findings/0a-1-single-agent-step.md`, `docs/findings/0a-2-round-trip.md`,
`docs/findings/0b-effect-boundary.md`; index at `docs/findings/README.md`) — which this ADR
distills. Every claim below cites a specific section of that log (`0a-1 finding #N`, `0a-2
"<heading>"`, `0b A<N>`) or a `src/spike/**` file. Where the spike was inconclusive, this ADR
says so — it does not upgrade a caveat into a confident statement.

`STATUS.md` named four things this ADR must record: the write-back strategy as tested, the
isolation model, the Effect boundary, and which open questions turned out to be wrong. It
surfaced a fifth: what phase 1 must inherit rather than rediscover. This ADR is organized around
all five, in that order.

## Decision

### 1. Write-back strategy, as tested

D2 (Factory owns git write-back), D9 (write-back is a deterministic workflow step, not an agent
instruction) and D11 (PR title/body come from an ordinary agent step returning structured
output) all held up under an actual run, not just design.

**Mechanism that worked at runtime** (`src/spike/lib/writeback.ts`, exercised by
`fullRoundTrip` in `src/spike/workflow.ts`, steps 6-7):

- PR metadata: an agent step (`pr-metadata`) is called with `outputSchema` set
  (`PR_METADATA_SCHEMA`). The opencode text adapter simulates structured output — it injects
  the JSON Schema into the prompt and, on its own final assistant message, parses the text back
  into JSON, emitting a `structured-output.complete` CUSTOM event with the parsed value
  (`@tanstack/ai-opencode/src/adapters/text.ts`, read in full in 0a-1 finding #3). 0a-1 could
  only confirm this from source; 0a-2 confirmed it **at runtime**, on both its runs — the PR
  that actually opened has exactly the title/body the `structured-output.complete` event
  carried (0a-2 "Structured output verdict").
- `resolvePrMetadata` (`workflow.ts`) implements a three-tier fallback chain and reports which
  tier fired: tier 1 reads the `structured-output.complete` event (`mechanism:
  "structured-output-event"`); tier 2 manually `JSON.parse`s `finalAssistantText` if tier 1's
  value is absent or malformed; tier 3 is a hardcoded Factory-authored title/body so write-back
  never blocks on the agent having said something parseable. Both 0a-2 runs fired tier 1; tier 2
  was cross-checked as wired correctly by comparing `finalAssistantText` against the
  `structured-output.complete` event's raw JSON, but never needed to fire for real (0a-2
  "`finalAssistantText`: delta accumulation" section, last bullet).
- Write-back itself (`writeBack()`) is ordinary host `git` + `gh pr create` through `hostExec`,
  never an agent instruction: `git checkout -b`, `git add -- <staged paths>`, `git commit`,
  `git push -u origin <branch>`, `gh pr create --repo … --title … --body …`, with the PR URL
  extracted from `gh`'s stdout. Every step after the branch checkout returns an `ExecResult`
  rather than throwing, so a caller can see exactly where the chain broke; only a failed
  `checkout -b` or a surviving stray artifact (below) throws outright.

**Staging hazard, and how it's handled.** 0a-1 finding #5 root-caused a real, reproducible
library defect: merely configuring `defineWorkspace(...)` under `localProcessSandbox` — even
`{source: {type: 'none'}, setup: []}` — causes the sandbox middleware to write a stray
`.tanstack-projected-<hash>` marker file into the tree, nested under a bogus `data/...` path,
due to a path-double-resolution bug (`@tanstack/ai-sandbox-local-process`'s handle `resolve()`
re-roots an already-real absolute path as if it were virtual — traced through five layers of
source in 0a-1 finding #5, reproduced identically in every 0a-2 and 0b run). It does not corrupt
or delete anything real, but a naive `git add -A` would stage it. `writeback.ts` handles this as
a first-class concern, not an afterthought: `cleanStrayArtifacts()` matches
`git status --porcelain` output against `[/\.tanstack-projected-/, /^data(\/|$)/]` and removes
matches before anything is staged; `writeBack()` then re-checks `git status --porcelain` and
**throws** if any stray path survives cleanup, rather than silently staging garbage. Every run
from 0a-1 through 0b reproduced this artifact and had it cleaned this way
(`writeBackResult.cleanedArtifacts` shows `["data/"]` on every 0a-2/0b run that reached
write-back).

### 2. Isolation model, as tested

D7 (`localProcessSandbox` for phase 0/POC) and D8 (Factory owns the working tree) held, but the
spike found D8's originally-stated *mechanism* wrong.

**What actually pins the sandbox at a host directory:** the provider-level
`localProcessSandbox({dir: hostPath})`, not `workspace.source: {type: 'local', path}` as D8's
rationale text named. 0a-1 finding #1 reads the installed package directly:
`@tanstack/ai-sandbox/dist/esm/bootstrap.js`'s `bootstrapWorkspace()` has a case only for
`source.type === 'git'`; `'local'` and `'none'` both fall through as a no-op, and there is no
code path anywhere that reads `source.path`. `localProcessSandbox`'s `create()` resolves
`root = path.resolve(config.dir)` and `mkdir`s it — no copy step. This was confirmed empirically,
not just from source: after a run, exactly one `factory-spike` directory existed on disk, no
`os.tmpdir()`-based sandbox temp dir was ever created, and the agent's edits landed in that one
real clone (inode/path checks, `git diff`, 0a-1 finding #1). **Conclusion carried into D15
(below): use `provider: localProcessSandbox({dir: hostPath})` plus
`workspace: defineWorkspace({source: {type: 'none'}, setup: []})`; ignore `workspace.source` as
the "point at an existing host dir" mechanism.** This contradicts the sandbox docs' framing of
`source` as the primary way code gets into a sandbox, for this provider.

Tree survival across a fresh-session reuse boundary (D10, and the step STATUS.md called "the
single most important thing phase 0 can learn") was confirmed, with an honest caveat on
exercise depth. The strengthened assertion (`assertFixStepSurvived`, `src/spike/lib/tree-snapshot.ts`)
snapshots tracked files immediately after the implement step and again immediately after the fix
step completes — spanning the fix step's own sandbox re-bootstrap, not just the host-side
`bun test` in between. Verdict, from `run-1789308170212`: **PASS, no file reverted to the
`origin/main` seed, no tracked file vanished or was truncated** (0a-2 "The strengthened step-4
result"). The caveat: both 0a-2 runs' fix step made zero edits (outcome `unchanged` for both
files), so the assertion machinery's `edited` and `reverted-to-seed` classification branches
exist and are built to handle real divergence, but were never exercised against a real change
(0a-2 "Still untested").

**What this model does not prove**, cross-referenced against the Deferred table: no isolation
(host-process, host-filesystem, host-credential exposure, by design — D7's accepted cost), no
concurrency behavior (F2 already flags same-key concurrency as undefined; every phase-0 run was
strictly sequential), and no credential injection (`localProcessSandbox` inherits host
credentials wholesale; `createSecrets`/scoped injection is untested and deferred to the docker
trigger).

**Sandbox reuse across steps — proof-of-consistency, not proof-of-identity.** `CUSTOM:sandbox.file`
fired exactly 3 times, only during `implement`, in every phase-0 run (0a-1's single step, both
0a-2 three-step runs). This is *consistent with* `lifecycle: {reuse: 'thread'}` genuinely reusing
one sandbox handle across steps, and with the fast (~1.37s) inter-step gap. But 0a-2's "Sandbox
reuse" section states plainly why it is not conclusive: the marker file that triggers
`sandbox.file` is written to a real host path and gated on `handle.fs.exists(markerPath)` — a
disk-state check, not a sandbox-instance-identity check. A brand-new handle pointed at the same
already-marked directory would produce the identical observed signature. Nothing in the chunk
stream carries a sandbox/handle identity value. **This is a real, stated gap**, not resolved by
this ADR — the findings doc recommends a nonce-file probe (a `setup` script writing a random
value at bootstrap; byte-identical across steps ⇒ genuine reuse) for phase 1, carried forward in
the Deferred table below.

### 3. The Effect boundary

0b's scope: wrap one `chatStream` as an Effect `Stream`, interrupt the fiber, confirm the
explicit cancel fires and the opencode process is actually gone — checking `ps`, not trusting
the type signatures, per the task's own instruction.

**Wiring** (`src/spike/lib/effect-agent-step.ts`): the chunk stream is
`Stream.fromAsyncIterable(iterable, onError)`; per-chunk bookkeeping runs through
`Stream.mapEffect`; the whole thing is drained with `Stream.runDrain`. The interrupt-specific
cancel is attached with `Effect.onInterrupt(drain, () => Effect.sync(() => { onInterruptFinalizer?.(); abortController.abort(); }))`
— applied to the **effect returned by `Stream.runDrain`**, not to the `Stream` value, because
there is no `Stream.onInterrupt` or `Stream.acquireRelease` in this v4 RC (`Stream.d.ts` read in
full). `Effect.onInterrupt`'s finalizer fires only on interruption (per its own doc comment),
unlike `Effect.ensuring`/`Stream.ensuring`, which fire on every exit and so can't isolate "was
this actually cancelled" — both alternatives were checked and rejected (0b, "The
interruption-to-abort wiring").

**A1/A2 — the finalizer and the process, confirmed:** the finalizer ran on 2/2 `abort`-configured
runs (never on 2/2 controls, as designed — a boolean flip inside the closure, not inference from
`ps`), and in all 4 runs the opencode `serve` process went from running → `<defunct>` immediately
after `Fiber.interrupt`'s promise resolved → fully gone from `ps` within ~1-1.6s, with no
`forceKilledPids` needed (0b A1/A2, `results.json`).

**A4 — clean exit, confirmed:** every interrupted fiber's `Exit` was `Exit.isFailure(exit) &&
Exit.hasInterrupts(exit)`, never a `Die`/defect and never a hang.

**F4 refinement — the finding this ADR must state honestly, not launder.** F4 said "closing the
IO stream does not terminate the agent process; only an explicit `abort()` does." 0b's control
experiment (A3: `interruptBehavior: "none"`, no `abort()` ever dispatched — confirmed by
`finalizerRan=false`, `abortControllerAbortedAfterInterrupt=false` on both control runs) found
the process died anyway, on a timeline indistinguishable from the abort-wired runs (settle at
~2.7-2.8s vs. ~1.9-2.5s). Root cause, read from source: `Channel.fromAsyncIterable`
(`node_modules/effect/dist/Channel.js`) always registers its own scope finalizer that calls the
source async iterator's `.return()` on early scope closure — independent of anything the spike's
own code adds. `.return()` on `chat()`'s async-generator iterable reaches the generator's own
`finally` block (`server.dispose()` → `proc.kill()`), the same destination F4 said only explicit
`abort()` could reach, via a route F4 didn't anticipate. **Scope of this refinement, stated
precisely: it applies to consumption via `Stream.fromAsyncIterable` specifically. The raw
`for await` + early `break`/`return` case that F4 originally described (and that 0a's plain
`agent-step.ts` uses) was never retested and is still presumed to behave as F4 said** — a plain
`for await` loop does not reliably call `.return()` on early exit; that's an ordinary JS gotcha
distinct from `Stream.fromAsyncIterable`'s explicit scope-finalizer behavior. A further caveat
from the same experiment: every interrupt landed while the agent was mid-tool-call, i.e. the
generator was very likely suspended at a clean internal `yield` point when `.return()` arrived.
Whether `.return()` alone is equally effective against a generator stuck inside something it
can't cleanly unstick (e.g. an in-flight `fetch()` with no cancellation token of its own) was not
tested. **Recommendation, followed here as D17: keep the explicit `Effect.onInterrupt` → `abort()`
wiring in phase 1 regardless — it is strictly redundant given A3's result, never harmful, and
cheap, and covers the untested non-cooperative case that `.return()` alone might not.**

**A5/A6 — no new corruption, and interrupt is not instantaneous.** Post-interrupt tree state
showed nothing worse than the already-root-caused `data/...` stray artifact (same bug as
write-back's hazard above, orthogonal to cancellation). Timing: the process had already exited
(visible as `<defunct>`) by the time `Fiber.interrupt`'s promise resolved in every run, but full
zombie-reap took another ~0.2-1s beyond that — a caller needing "confirmed fully gone from the
process table" should poll briefly after `Fiber.interrupt` resolves rather than trust the
resolved promise alone.

**Effect v4 RC API notes phase 1 will hit** (0b, "Effect v4 API notes for phase 1"): no
`Stream.onInterrupt`, no `Stream.acquireRelease` in `effect@4.0.0-rc.115` (confirmed by reading
`Stream.d.ts` in full); `Fiber.await` is exported under that name but implemented internally as
`await_`, aliased at the bottom of `Fiber.d.ts` — a naive grep for `declare const await:` misses
it; `Schema.TaggedError<T>()(tag, fields)` is the current-generation idiom over
`Data.TaggedError` (surfaced by `oxlint`'s `effecttsgo` rules), used here for
`AgentStepChunkError` with `Schema.Defect()` wrapping the `cause: unknown` field.

### 4. Which open questions turned out wrong

Verdicts below are `confirmed` / `refuted` / `refined` / `unknown`, walked item-by-item against
`STATUS.md`'s "Open questions" list as it stood before phase 0, plus facts F1-F5.

| Open question (pre-phase-0 wording) | Verdict | Evidence |
|---|---|---|
| Structured output from a harness adapter — can it be given a schema at all, or must the agent write a file / must we parse the final message? | **Confirmed at runtime** (upgraded from source-only in 0a-1) | 0a-2 "Structured output verdict": both runs fired tier 1 (`structured-output.complete`), PR title/body matched exactly |
| Does `source: {type:'local', path}` operate in place or copy? Is a workspace `source` needed at all under `localProcess`? | **Refuted** — dead code in the installed package; not needed at all | 0a-1 finding #1: `bootstrapWorkspace()` has no `'local'` case; empirical inode/single-directory check |
| Does one `threadId` + omitted `sessionId` behave as F2/F3 predict (sandbox preserved, tree intact, transcript empty)? | **Confirmed**, behaviorally not just by ID distinctness | 0a-2 "Fresh session, no transcript history": prompt-echo-as-first-message, from-scratch re-reads, from-scratch re-derivation, all three steps |
| Does `localProcess` re-bootstrap destroy anything between steps, given `setup: []`? | **Confirmed no destruction** — but only the `unchanged` outcome was exercised | 0a-2 "strengthened step-4 result": PASS; `edited`/`reverted-to-seed` branches built but never fired for real |
| Which CUSTOM events actually arrive from `opencodeText`? | **Refined** — only `sandbox.file`, `opencode.session-id`, `structured-output.*`; never `file.changed` or `sandbox.file.diff`, contradicting `events.md` | 0a-1 finding #2 (source read of `translate.ts`) + 0a-2's full chunk-type inventory across 3 steps × 2 runs |
| Is a `SandboxPolicy` needed on `localProcess`? Does `permissionMode: 'acceptEdits'` behave as documented? | **Refuted as relevant** (policy) / **Confirmed** (`acceptEdits`) | 0a-1 finding #4: no import of `SandboxPolicyCapability` anywhere in the opencode adapter; `acceptEdits` ran 6/6 tool calls with no hang, no approval-request chunk |
| Cancellation across the Effect boundary — does interrupting the fiber invoke the explicit cancel, and does the process actually die? | **Confirmed**, with a refinement to F4 (see §3) | 0b A1/A2/A4: finalizer ran 2/2, process gone in all 4 runs, clean `Interrupt` exit |

Facts F1-F5, same treatment:

| Fact | Verdict | Evidence |
|---|---|---|
| F1 — no host-side exec API into the sandbox | **Unfalsified / not directly exercised** | The spike never needed one: D8 makes the host directory *be* the sandbox under `localProcess`, so `ctx.exec` runs on the host directly (`hostExec`, not a sandbox exec call). Still assumed true for non-local providers; no evidence against it |
| F2 — sandbox identity is a key (`threadId`+definition ⇒ same sandbox); concurrency within a key undefined | **Refined** — consistent with all evidence, but not independently provable with this spike's instrumentation | 0a-2 "Sandbox reuse across steps": the observable signal (`sandbox.file` firing once) is disk-state-based, not instance-identity-based; concurrency was never tested (every run sequential) |
| F3 — session resume is opt-in; fresh sessions are free | **Confirmed**, behaviorally | Same evidence as the `threadId`/`sessionId` open question above |
| F4 — cancellation does not follow from closing the stream; explicit cancel required | **Refined**, scoped to `Stream.fromAsyncIterable` consumption | 0b A3: control runs killed the process with zero explicit `abort()` wiring, via `Channel.fromAsyncIterable`'s own `.return()`-on-scope-close. Raw `for await`+`break` case never retested, presumed to still hold |
| F5 — TanStack persistence can't reconstruct a run; opencode has no journal; useful live events include `file.changed`, `sandbox.file`, `sandbox.file.diff` | **Core persistence-gap claim not directly tested** (no durability/replay was exercised); **the enumerated event list is refuted for opencode** | Persistence/replay: out of scope for phase 0, D12 still assumes this. Event list: 0a-1 finding #2 — `file.changed` and `sandbox.file.diff` never observed in any of 5 phase-0 runs; only `sandbox.file` (from the sandbox middleware, not "the harness adapter") ever fired |

### 5. What phase 1 inherits and must not rediscover

- **The D13 three-piece seam, as built**: `workflow.ts` (imperative `async (ctx) => {...}` over
  `WorkflowContext.agentStep`/`exec`), `lib/*.ts` (mechanical utilities: exec, clone, NDJSON
  sink, agent-step wiring, tree snapshots, write-back), `runtime.ts` (orchestration, `ps`
  snapshots, reporting). This boundary was deliberately exercised across three separate spike
  runs (0a-1, 0a-2, 0b) without needing to change — treat it as validated, not just proposed.
- **The NDJSON corpus** (`.factory/runs/<runId>/chunks.ndjson`, plus `summary.json`/`stdout.log`
  from 0a-2 onward, plus 0b's `results.json`) is the input for designing D3's event type. It is
  real recorded chunks across `RUN_STARTED`, `RUN_FINISHED`, `TEXT_MESSAGE_*`,
  `REASONING_*`, `TOOL_CALL_*`, and every `CUSTOM` name actually observed (§4 table) — do not
  design the event type from the docs' summary of what chunks look like.
- **Library bug workarounds, both load-bearing today:**
  - The `.tanstack-projected-<hash>` / `data/...` stray-artifact bug (§1) — `cleanStrayArtifacts`
    in `writeback.ts` is the workaround; it is a real path-double-resolution defect in
    `@tanstack/ai-sandbox-local-process`'s `handle.js` `resolve()`, not a design choice to keep.
  - `finalAssistantText`'s "buffer `delta` between `TEXT_MESSAGE_START`/`_END`, keep only the
    **last completed** message" logic (`agent-step.ts`/`effect-agent-step.ts`) — necessary
    because every step's *first* text message is a byte-for-byte echo of that step's own prompt,
    not a model turn; a naive "first message" or chunk-count-based reader overcounts by exactly
    one per step.
- **Open items the spike deliberately left**, not silently dropped (see Deferred table in
  `STATUS.md` for triggers): the sandbox-reuse nonce probe, the non-cooperative-abort case,
  multi-chunk delta accumulation (verified by code inspection only, never against a real
  multi-chunk message), concurrent/overlapping fibers, and docker.

## Consequences

**Benefits.** D2/D9/D11's write-back strategy, D7/D8's isolation model (mechanism corrected per
D15 below), and D14's Effect-fiber-interruption cancellation path are no longer speculative —
each ran against a real repo and a real process table. Phase 1 can build `defineWorkflow`, the
run context, and D3's event type directly against recorded evidence instead of docs.

**Costs and risks, stated plainly, not just benefits:**

- **Dependence on library internals for a behavioural guarantee.** The F4 refinement (§3) rests
  on reading `Channel.fromAsyncIterable` in `node_modules/effect/dist/Channel.js` — an
  implementation detail of `effect@4.0.0-rc.115`, not a documented contract. If a future RC or
  stable release changes `Stream.fromAsyncIterable`'s finalizer behavior, the "process dies even
  without explicit `abort()`" result could silently stop holding. This is exactly why D17 keeps
  the explicit `abort()` wiring as redundancy rather than relying on the implicit behavior alone.
- **RC pin.** `effect@4.0.0-rc.115` is a release candidate; its public API already has known
  gaps relevant here (no `Stream.onInterrupt`/`Stream.acquireRelease`) that had to be worked
  around one level up (§3). Upgrading is not risk-free — it could add the missing primitives
  (an improvement) or change interruption/finalizer semantics (a regression risk for the F4
  refinement above).
- **A real, unfixed library bug is now load-bearing infrastructure.** `cleanStrayArtifacts`
  exists only because of `@tanstack/ai-sandbox-local-process`'s path-resolution defect. Every
  future write-back inherits this workaround until upstream fixes it; if the bug's shape changes
  in a future release (different marker path pattern) `cleanStrayArtifacts`'s regex-based
  detection could stop matching and let it through undetected — the hard-fail check in
  `writeBack()` (throw if any stray path survives cleanup) is the safety net for a *known*
  pattern, not a general defense.
- **Sandbox-instance reuse is asserted, not proven.** Phase 1's run-context design can rely on
  `lifecycle: {reuse: 'thread'}` per F2's documented contract, but should not claim the spike
  independently verified object-level reuse — only that phase 0's evidence is consistent with it
  and does not contradict it. The nonce-probe is unbuilt; until it exists this remains an
  assumption inherited from the framework's documentation, not from measurement.
- **Narrow exercise depth on the two most consequential assertions.** The fix-step
  tree-survival assertion (D10) and the delta-buffering logic have each only been exercised
  along their "boring" path (`unchanged`, single-chunk messages respectively) — the code for the
  divergent paths exists and is reasoned about, but is unverified by an actual run. A regression
  in either path would currently ship undetected until a real run happens to exercise it.
- **`localProcessSandbox` provides zero isolation, by design (D7).** Phase 0 deliberately did not
  test credential scoping, concurrent-run isolation, or anything docker would provide. Every
  claim above about "the process died" or "the tree survived" was measured on a single host
  process tree with full host credentials and no sandbox boundary — none of it demonstrates
  safety against an untrusted repo or a malicious agent turn.

## References

- `docs/findings/0a-1-single-agent-step.md`, `docs/findings/0a-2-round-trip.md`,
  `docs/findings/0b-effect-boundary.md` — primary evidence log, split one document per subtask
  (index: `docs/findings/README.md`)
- `STATUS.md` — D1-D14, F1-F5, phase 0 plan and exit criterion
- `src/spike/workflow.ts`, `src/spike/lib/writeback.ts`, `src/spike/lib/tree-snapshot.ts`,
  `src/spike/lib/effect-agent-step.ts`, `src/spike/effect-boundary-experiment.ts` — code as built
- PR opened by the spike: https://github.com/FreshlyBrewedCode/factory-spike/pull/3
