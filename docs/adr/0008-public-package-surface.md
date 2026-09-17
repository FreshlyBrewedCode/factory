# 0008. The public package surface: one barrel, and `.factory/` as the project folder

## Status

Accepted, 2026-09-15. Built in the same change (the phase-5 release leg,
stacked on `feat/phase-5`). Validated by `src/index.test.ts`,
`src/init.test.ts`, and the staged-package smoke test in
`scripts/build-release.ts`.

ADR 0006 (`0006-raw-typescript-distribution.md`) decided *how* the package
ships — raw TypeScript on Bun behind a shebang-guarded launcher. This ADR
decides *what it exposes* once it gets there. The two are complementary. (That
ADR was filed as a second `0005`, colliding with `0005-poc-manual-runs.md`; it
was renumbered to `0006` in the 2026-09-17 docs cleanup.)

## Context

Phase 5 closed with a POC a person can use — but only from inside this
repository. Everything a user would write imported through relative paths into
`src/`: the sample's config did `import { defineConfig } from "../src/config"`,
its workflow did `import { defineWorkflow, Schema } from "../../src/workflow"`.
There was no answer to "I installed the package, now what do I import?", and
`src/index.ts` — the file `package.json`'s `module` field pointed at — still
exported phase 0's `slugify` smoke test and nothing else.

Three problems follow from that, and they are one problem:

1. **No declared surface.** With no `exports` map, everything under `src/` is
   reachable. A user importing `@frebreco/factory/src/server/dispatch` would
   be doing something reasonable-looking that we would then break.
2. **The tested import path was not the shipped one.** Nothing in the repo
   imported the way a user would, so the published entry point could break
   without a single test failing.
3. **No way to start.** A new project had to hand-write `factory.config.ts`
   from the sample, guessing at the `repo` block's four fields, and know that
   `factory serve --config <path>` existed.

Separately, `.factory/` was entirely gitignored — the host clone, run dumps,
workspaces, and `factory.db`. That is the right treatment for regenerable
state, but it meant the project folder every user would recognise by name held
nothing they had written.

## Decision

**One barrel, one specifier, and `.factory/` holds the project.**

### 1. `src/index.ts` is the whole public API

It re-exports the authoring surface and nothing else: `defineWorkflow`,
`defineConfig`, `Schema`, `isTerminal`, the three `DEFAULT_*` config
constants, and the types a workflow body touches (`WorkflowCtx`,
`AgentResult`, `ExecResult`, `WriteBackResult`, `RunEvent`, …).

`package.json` declares `exports: { ".": "./src/index.ts", "./package.json":
"./package.json" }`, so deep imports into `runtime/`, `server/`,
`persistence/` and `web/` are not reachable at all. Those are the daemon's
internals, reached through the bundled CLI. A workflow that needs one of them
is a signal the authoring surface is missing something — widening the barrel
is then a deliberate edit, guarded by a test that pins the exported key list.

### 2. The repo imports through the specifier it publishes

The root manifest's `name` becomes `@frebreco/factory` (it stays
`"private": true`, per ADR 0006). That makes Node/Bun self-referencing
resolution work, so `sample/`, `src/index.test.ts` and every future example
import `@frebreco/factory` — the exact string a user types — while resolving to
the working tree. The published surface cannot drift from the tested one,
because they are the same import.

`build-release.ts` mirrors the `exports` block into the generated manifest and
its smoke test now installs the staged package into a temp directory's
`node_modules`, runs `factory init` there, and imports the generated config —
so a broken `exports` map fails the build rather than the first user.

**`workflows/` no longer ships.** The repo's `implement-issue` imports
`src/lib/tree-snapshot`, an internal the barrel does not export, so shipping it
would advertise an import path users must not depend on. `factory init` gives
them a workflow instead.

### 3. `.factory/` is the project folder, holding source *and* state

```
.factory/
├── factory.config.ts     committed — D27's entry point
├── workflows/            committed
├── factory.db            gitignored
└── workspaces/           gitignored
```

`factory init` scaffolds the first two and rewrites `.gitignore` to ignore the
regenerable half by name rather than ignoring `.factory/` wholesale — including
**removing a pre-existing blanket `.factory/` line**, which would otherwise
silently swallow the config it just wrote.

Config discovery is ordered: `.factory/factory.config.ts`, then
`factory.config.ts`. The root fallback is the pre-`init` layout — phase 5's
`sample/` uses it and keeps working untouched, which also makes the sample the
fallback's regression test. `factory serve` with no `--config` now finds the
project it is standing in; finding neither path is not an error, since the
daemon still serves the UI and the phase 3 path-based API with an empty
registry.

### 4. `init` is additive and guesses from the checkout

It never overwrites without `--force`, reporting existing files as skipped, so
running it twice — or in a live project — cannot destroy a config. It reads
`origin`'s URL, the local git identity and the default branch to fill the
`repo` block in, and every guess has a visible placeholder fallback with a
banner comment in the generated file saying which is which. Outside a git repo
it degrades to placeholders rather than failing, because `init` has to work
before `git init` as well as after it.

## Consequences

- **The barrel is now a contract with a test.** `src/index.test.ts` pins the
  exported key list, so widening or narrowing the surface is a visible diff. It
  imports through the package specifier, so it doubles as the resolution test.
- **`defineConfig`'s types are the documentation.** With deep imports closed,
  the config and workflow shapes are the only thing a user sees — which raises
  the cost of the `WorkflowDefinition<any, any>` variance erasure noted in P2
  (the registry array), since that `any` is now on the public surface.
- **Two config locations exist, forever-ish.** The fallback is cheap (one
  `Bun.file().exists()`) and buys backward compatibility, but "where is my
  config" now has two answers. `findFactoryConfig` is the single place that
  knows, and its order is fixed.
- **`init` rewriting `.gitignore` is a mutation of a file the user owns.** It
  is guarded by a header-comment check so it runs once, and it only ever
  removes the one line that would break the scaffold. It is still the most
  intrusive thing any factory command does to a repository.
- **Self-referencing resolution is now load-bearing.** If a future bundler or
  toolchain in the pipeline does not support it, `sample/` and the tests break
  loudly and immediately — which is the intended failure mode, but it is a new
  dependency on a resolution feature.
- **The published package got smaller** (no `workflows/`), and the thing users
  learn from is generated rather than shipped, so the starter workflow is
  versioned with the CLI that writes it.
