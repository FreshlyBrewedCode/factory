# 0002. Workflow authoring surface — `defineWorkflow` and the `ctx` contract

## Status

Accepted, 2026-09-13, agreed in a design conversation immediately before phase 1
implementation. Unlike ADR 0001 (written after evidence existed), this decision is
**pre-implementation**. It is grounded in the spike's already-proven seam
(`WorkflowContext` + `fullRoundTrip`, ADR 0001 §5) rather than in speculation, but its
correctness is phase 1's exit criterion to falsify, not a fait accompli. Nothing is
persisted and no UI exists yet — if the surface is wrong, it is wrong cheaply.

## Context

Phase 1 must build `defineWorkflow`, the run context, and D3's event type, and STATUS
instructs the event type to be designed *first*. But the event type is a superset of what
workflows can emit — step boundaries, exec results, assertions, write-back, none of which
the harness emits (ADR 0001 §5) — so designing it before the emission surface settles risks
designing events for a shape that then moves. Three things forced the alignment now:

1. **Naming drift.** STATUS's phase-1 sketch said `ctx.agent()`; the spike built
   `ctx.agentStep({step, prompt, outputSchema})`. Both cannot harden.
2. **D5's registration surface** (id + input schema + function) pins what a workflow module
   *is*, but not how the daemon imports and validates one without executing it.
3. **The ownership question.** Sandcastle gives the workflow author deep configuration over
   sandbox and agent; the spike's runtime owned all of it. The agreed principle for Factory:
   **the runtime should own less, and workflows must be able to adapt to anything**.

Not re-litigated here, decided earlier: D1 (imperative async TS, no DSL), D4 (no Effect in
the authoring surface), D5, D9 (exec returns exit codes), D11 (PR metadata from an agent
step), D13 (the three-piece seam), D15/D16 (sandbox mechanism), and phase 1's standing note
to unify on Effect `Schema` for input/output schemas.

## Decision

### 1. Registration: one default export per module

```ts
// workflows/implement-issue.ts
import { defineWorkflow, Schema } from "factory"; // Schema re-exports effect/Schema

const Input = Schema.Struct({
  repoSlug: Schema.String,
  issueNumber: Schema.Number,
  branch: Schema.String,
});

const RunResult = Schema.Struct({ prUrl: Schema.String });
const PrMetadata = Schema.Struct({ title: Schema.String, body: Schema.String });

export default defineWorkflow("implement-issue", {
  input: Input,
  output: RunResult,                              // optional, typed return value
  agent: { model: "opencode-go/deepseek-v4.1-flash" }, // optional, workflow-owned defaults
  run: async (ctx, input) => { /* ... */ },
});
```

- `id` is a plain string, unique per installation; it names runs and is the daemon's
  enumeration key (D5).
- `input` is an Effect `Schema`, typed and validated by the runtime before `run` executes.
- `output` is optional. When given, the runtime validates the workflow's return value before
  recording run completion — phase 3's dispatcher reads `prUrl` reliably rather than by
  convention.
- `agent` is optional: workflow-owned defaults for every `ctx.agent` call. Precedence:
  **per-call option > workflow default > runtime fallback**. This is the Sandcastle-style
  configuration valve, placed with the workflow, not in runtime-private config.
- The `factory` package re-exports `Schema` so workflow files never import `effect`
  directly. This relocates the coupling, it does not remove it (see Consequences); it is
  accepted because the authoring surface is the one place ergonomics are the point (D1, D4).

### 2. The `ctx` contract — six members, nothing else

```ts
const implement = await ctx.agent("implement", implementPrompt(input));
const test = await ctx.exec(["bun", "test"]);

const survived = await ctx.assert("fix-step-survived", async () => {
  const afterFix = await snapshotFiles(ctx.dir, TRACKED_FILES); // plain imported utility
  const verdict = assertFixStepSurvived({ /* ... */ });
  return { pass: verdict.ok, details: verdict };
});
if (!survived.pass) throw new Error("fix step reverted the tree");

const meta = await ctx.agent("pr-metadata", prPrompt, { output: PrMetadata });

const wb = await ctx.writeBack({
  branch: input.branch,
  commitMessage: commitMsg(input),
  prTitle: meta.output.title,
  prBody: meta.output.body,
});
await ctx.log("coverage-note", { lines: 42 }); // generic escape hatch

return { prUrl: wb.prUrl };
```

- **`ctx.dir`** — the prepared working tree. The runtime clones; the workflow never does
  (D8; the spike's step-1-by-runtime split, held across 0a-1/0a-2/0b). Tree-snapshot and
  other mechanical helpers stay plain imported utilities taking `ctx.dir` as an argument —
  D13's middle piece, unchanged.
- **`ctx.agent(name, prompt, opts?)`** — the mandatory explicit step name as first argument
  generalizes 0a-2's `{step, chunk}` NDJSON envelope and keys D3's step-boundary events;
  auto-deriving names from assignment position would be fragile. `opts` is an open bag —
  `{ model?, permissionMode?, output?, ... }` — resolved by the precedence rule above.
  `output` takes an Effect Schema, converted to JSON Schema only at the adapter boundary.
  The return is the **full granular result** (chunks seen, session id, final text, typed
  `output` when requested), not a distilled type: the spike's tier-2 manual re-parse needs
  the final text, and hiding it costs flexibility for zero savings. The runtime owns the
  generic extraction (tier 1: the `structured-output.complete` event; tier 2: manual JSON
  re-parse of the final text, both proven at runtime per ADR 0001 §1); **tier-3 domain
  fallbacks stay workflow code** — the spike's hardcoded PR text is domain knowledge, not
  runtime knowledge.
- **`ctx.exec(argv)`** — unchanged from the spike: returns `ExecResult`, never throws (D9).
  Failure policy is ordinary `if`/`throw` in the workflow.
- **`ctx.assert(name, callback)`** — a convenience wrapper over `ctx.log`, nothing more.
  The check itself is a workflow-provided callback returning
  `boolean | { pass: boolean; details?: unknown }`; `ctx.assert` awaits it, records a
  *typed* assertion event (`{ name, pass, details }`), and returns the same record. It does
  **not throw** — control flow stays in the workflow (imperative is the point; compare D9).
  The UI can render pass/fail off the standardized shape; the runtime never learns what a
  "check" is.
- **`ctx.log(name, data)`** — the generic escape hatch: a workflow-defined record with an
  open slot in D3's event type. This slot must exist *before* phase 2 persists events;
  adding it later is a schema migration over stored data.
- **`ctx.writeBack({...})`** — stays on `ctx` for the POC, and is the acknowledged border
  case against the ownership principle. It earns its place by exactly two things: the
  stray-artifact hard-fail (`cleanStrayArtifacts`, a real library bug — ADR 0001 §1) and
  PR-URL event emission. **Demotion trigger: the first second workflow that shows what is
  actually shared** — at that point it becomes a workflow-imported utility and `ctx`
  shrinks to five members.

### 3. Failure and return

The workflow fails by throwing. The runtime catches, records a run-failure event, and marks
the run failed (D12's long-lived-process scope makes this the whole recovery story). The
return value must be serializable JSON; when `output` is given, it is validated before run
completion is recorded.

### 4. Ownership rule

**The runtime owns the tree, the log, and cancellation. The workflow owns everything else.**

For the POC, sandbox/workspace *configuration* stays runtime-owned — under `localProcess`
the sandbox literally is the runtime's clone (D8, D15), so there is nothing for the workflow
to configure yet. When a non-local provider arrives (docker trigger, STATUS Deferred), that
surface grows as per-workflow sandbox config in `defineWorkflow`, never as runtime-private
state.

## Consequences

**Benefits.** D3's event type now has a settled emission surface to be a superset *of*:
step boundaries (mandatory names), exec results, standardized assertions, open `log`
records, write-back + PR URL, typed run results. The spike harvest becomes a near-mechanical
lift — `fullRoundTrip` maps one-to-one onto the new surface, with `RoundTripOptions`
becoming the typed input. The daemon's enumeration problem is solved by one validated
default export (D5). Phase 3's dispatcher gets a typed result. New adapter capabilities
require no Factory release, because per-call options pass through.

**Costs and risks, stated plainly:**

- **Pre-implementation decision.** This ADR precedes its own falsification. Phase 1's exit
  criterion (real workflow end-to-end under opencode *and* green under the corpus-replay
  adapter in `bun test`) converts it from design to evidence. Until then it is a hypothesis
  with good grounding.
- **`ctx.assert` does not throw**, but the name suggests otherwise to most readers. The
  mitigations are its doc comment ("records, returns, does not throw; throw yourself if you
  mean it") and this ADR.
- **The assert/log distinction is convention, not type-system-enforced.** A workflow that
  logs assertion-shaped records gets opaque UI notes, not pass/fail rendering. Harmless,
  but worth knowing.
- **Write-back on `ctx` is an accepted border case with a stated demotion trigger**, not a
  pattern to extend. "Runtime owns less" wins over "write-back is special" the moment a
  second workflow gives a reason.
- **The `Schema` re-export relocates the Effect coupling, it does not remove it.** Workflow
  files do not import `effect`, but they use its vocabulary (`Schema.Struct`,
  `Schema.String`). An Effect major bump still breaks every workflow file; only the import
  lines are protected.
- **Open options bags trade exhaustive typing for extensibility.** `ctx.agent`'s `opts`
  accepts adapter options Factory does not enumerate, so typos are not statically rejected.
  Cheap now; worth revisiting when the adapter surface stabilizes.

## References

- ADR 0001 §5 (what phase 1 inherits and must not rediscover), §1 (the write-back mechanism
  this surface wraps)
- `STATUS.md` — D1, D4, D5, D9, D11, D13, D15; phase 1 notes (Effect Schema unification,
  corpus-replay adapter, event-type-first)
- `src/spike/workflow.ts` (`WorkflowContext`, `fullRoundTrip`, `resolvePrMetadata`) — the
  shape this decision is a lift of
