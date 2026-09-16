# 12. Workflow transparency — static outline extraction, spiked

2026-09-16, branch `spike/workflow-outline-static-analysis` (spike only, not merged to `main`;
the prototype ran in `/tmp/oxc-probe`, outside the repo, and is not committed here — this
document is the record). Written from a design conversation about D1's cost: workflows are
plain imperative `async (ctx) => {...}` TypeScript (ADR 0002), so the daemon and UI cannot know
what steps a workflow will run before it runs. This spike answers one question: **can a static
pass over the workflow source recover a trustworthy step outline, without changing the authoring
surface?**

## Options considered, briefly

| Option | Verdict |
| --- | --- |
| Dry-run / shadow execution | Rejected. Workflow bodies do real host-side work outside `ctx` (tree snapshots, `git show`); one dry run only ever explores one branch, chosen by faked return values; worst of all, a confident wrong prediction is worse than an honest "unknown" |
| `ctx.branch()` / control-flow-wrapping APIs | Rejected as primary. Opt-in, so coverage depends on author diligence, and it taxes the ergonomics that are the actual differentiator over sandcastle (D1) |
| Generators / a monadic router (yield instead of await) | Rejected. A generator only reveals its next `yield` after being resumed with a value — exactly as sequential as `await`, with extra syntax. This is equally true of Effect's `Effect.gen`: **it is not statically inspectable either**, for the identical reason. Effect's real structural transparency lives in combinator-built pipelines (`Effect.all`, `zip`), which is D1's DSL fork, not this. What generators *do* genuinely buy is durable execution (replay/resume-after-crash) — a real reason to consider them later, just not this one |
| A declarative combinator DSL (`seq([step(...), ...])`) | The only design with *sound* pre-run shape. Rejected because it's what D1 already rejected, and it's exactly what makes `sample/workflows/implement-issue.ts`'s `if (testResult.exitCode !== 0)` retry loop awkward to write |
| **Static AST analysis over the existing `ctx.*` call sites** | **This spike.** No authoring change. Degrades to "unknown" rather than lying |
| Declared capability budgets (`maxAgentSteps`, `allowedCommands`, enforced not predicted) | Orthogonal, not competing — covers the one thing static analysis can't be trusted for (a safety guarantee), and separately closes the phase-6-queued shell-injection hazard. Not this spike; noted as a paired ticket |

## Why static analysis is viable here, and wasn't obviously going to be

Every `ctx.agent`/`ctx.assert`/`ctx.log` call in every workflow file in this repo already carries
a **string-literal name in argument position 0**, and `ctx.exec` takes a literal (or
near-literal) `argv` array. This isn't luck: ADR 0002 §2 mandates the explicit name and
explicitly rejected auto-deriving it from assignment position. Phase 1 made this surface
statically extractable and nobody had used that yet.

## The prototype

`oxc-parser` (`0.150.0`) parses the workflow module (TypeScript, no separate strip step) into
an ESTree-shaped AST — ordinary `IfStatement`/`CallExpression`/`MemberExpression` nodes, no
bespoke API. Under Bun: synchronous, `0.25 ms` for `sample/workflows/implement-issue.ts`. No
type checker involved, which is the right boundary — the extractor doesn't need types, and
`typescript@^7`'s compiler-API surface is still moving (the raw-TS-distribution ADR already
flags this).

The extractor (~120 lines): find `export default defineWorkflow(id, { run })`, then walk `run`'s
body carrying two independent facts forward at each node — not one, see below:

- **occurrence**: `always` / `conditional` (inside `if`/`try-catch`/ternary) / `repeated`
  (inside a loop)
- **identity**: known (literal name/argv) / computed (dynamic — render as `<computed>`)

On `ctx.<method>(...)` it emits an entry carrying both. If `ctx` itself is passed into any
other function call, it emits an `unknown-region` entry and does **not** try to look inside —
that boundary is what keeps the output honest rather than silently incomplete.

```ts
// the shape an entry takes; this is the part worth keeping precise
interface Entry {
  kind: "agent" | "exec" | "assert" | "log" | "writeBack" | "unknown-region";
  label: string;             // literal name, or "<computed>" / "<computed argv>"
  occurrence: "always" | "conditional" | "repeated";
  identity: "known" | "computed";
  line: number;
  note?: string;             // present when identity is "computed" or kind is "unknown-region"
}
```

(The spike's first cut collapsed `occurrence`/`identity` onto one `certainty` rank. Running it
against a loop with a dynamic step name inside showed the bug: it rendered as flatly "unknown"
and lost the fact that it repeats. Two independent fields is the corrected shape, recorded here
so the real implementation starts from it rather than rediscovering it.)

## Results against every real workflow in the repo

```
workflows/implement-issue.ts     — 8 steps, all "always", exact
sample/workflows/implement-issue — 6 steps; the fix + retest pair correctly marked conditional
test/fixtures/live-workflow.ts   — 4 steps, exact
test/fixtures/slow-workflow.ts   — 3 steps, exact
test/fixtures/tree-workflow.ts   — 3 steps; 2 `exec` calls flagged computed (`sh -c <computed>`)
```

Every real workflow the repo has extracts completely and correctly, including the one genuine
conditional branch (`sample/workflows/implement-issue.ts`'s fix-and-retest).

## Degradation against an adversarial workflow

A workflow written to defeat the extractor (dynamic step names, a `for` loop over user input, a
`try/catch`, a helper function that takes `ctx` as a parameter, a step name chosen by
`Math.random()`):

```
    agent          plan                              always   known
  * agent          <computed>                        repeated computed  — name not a literal
  * exec           bun test <computed>                repeated computed  — name not a literal
    exec           bun run lint                       always   known
  ? agent          lint-fix                           conditional known
  ~ unknown-region reviewPass(…)                       —       —         — ctx escapes into a helper
  ~ agent          <computed>                          —       computed  — name not a literal
  ? writeBack      write-back (branch/commit/PR)       conditional known
```

Nothing is fabricated and nothing silently vanishes. This is the property that matters more than
raw accuracy: a pessimistic-but-honest outline stays usable; a confident wrong one doesn't.

## The one wiring gap, and its fix

D27 made the config's workflow array the registry itself — no filesystem scan — so the daemon
holds workflow **objects**, not paths. Static analysis needs a source file. Tested: capturing
`new Error().stack` inside `defineWorkflow` and parsing the caller frame recovers the defining
module's real, resolvable path under Bun. So `defineWorkflow` can stamp a `sourcePath` at
definition time with no config change and no scan, preserving D27. Caveats before relying on it
in the real implementation: verify it survives the bundled/published path (`build-release.ts`),
and stack-frame parsing is engine-dependent — an explicit optional `sourcePath` override on
`defineWorkflow`'s config is the cheap escape hatch if it doesn't hold everywhere.

## An unplanned finding: this is also the phase-6 shell-injection detector

STATUS already queues, for phase 6, the hazard that workflow inputs are remote-facing since D31
— a workflow that interpolates an input value into `sh -c`/`ctx.exec` accepts arbitrary shell
from anyone who can `POST /api/runs`. `test/fixtures/tree-workflow.ts` above surfaces exactly
that shape as `exec sh -c <computed>` for free, with the same extractor, no extra mechanism. A
UI badge on `identity: computed` + `kind: exec` entries is the detector, not a separate feature.

## Recommendation

Land the static extractor (`src/outline.ts`, pure function, pinned tests against the fixtures
above) paired with:

- a **historical** view over the existing event log (already stores every step boundary of every
  run, D3/ADR 0003) — observed step sequences, frequencies, per-step median duration, which
  covers everything static analysis structurally cannot (loop trip counts, which branch actually
  gets taken) and requires no new persistence;
- **not** dry-run/shadow execution, generators, or a DSL rewrite — argued above;
- capability budgets (`maxAgentSteps`, `allowedCommands`, enforced not predicted) as a separate,
  narrower ticket for the one property that needs to be *sound* rather than *approximate*.

Ticket breakdown tracked in the epic this finding is linked from.
