factory

- factory runs coding agents against a real repository from workflows you write as plain
  TypeScript, with a daemon that owns their lifecycle and a web UI to watch them. Published as
  `@frebreco/factory` The authoring model is borrowed from mattpocock/sandcastle
- three columns
  1. **workflows** — plain `async (ctx, input) => {...}` TypeScript over a run context
     (`ctx.agent`/`exec`/`writeBack`/`assert`/`log`/`output`). No step graph, no DSL (ADR 0002)
  2. **server/cli** — `factory serve`: HTTP + SSE API, run admission and lifecycle, sqlite persistence,
     automatic dispatch
  3. **web UI** — a React SPA for monitoring, observability, and manual dispatching 
  
- one typed, append-only run-event log is the spine all three columns share (ADR 0003); raw agent
  chunks ride inside it opaquely
- a project owns a `.factory/` folder (ADR 0008): `factory.config.ts` (repo, identity, workflow
  registry, `maxConcurrentRuns`, workspace root) and `workflows/` are committed; `factory.db`,
  `workspaces/` and `runs/` are regenerable and ignored. `factory init` scaffolds it

- stack
  - bun (runtime, test runner, and bundler — `Bun.serve` for HTTP/SSE, the fullstack bundler for
    the SPA), `bun:sqlite` for persistence
  - Effect v4 (`4.0.0-rc.*`) for the run lifecycle and scheduling; Effect Schema is the schema
    language throughout — workflow inputs, agent structured output, config. 
  - `@tanstack/ai` with `-opencode` and `-sandbox-local-process` for the agent runtime. 
  - React 19 SPA: tanstack router and query, tailwind v4, shadcn primitives 
  - oxfmt, oxlint (type-aware, with the `@effect/tsgo` and react rules)
  - playwright for the browser legs

- working in this repo
  - `bun run check` is the gate: format:check + lint + typecheck + `bun test`. `bun run test:e2e`
    runs playwright
  - run playwright/browser automation through the Nix dev shell (`nix develop`), which pins bun and
    puts playwright's browser libs on `LD_LIBRARY_PATH` — see the playwright-cli skill
  - `bun run format` is deliberately scoped to explicit paths: a bare `oxfmt .` reformats Markdown
  - conventional commits; CI lints PR titles and semantic-release publishes from `main`
  - we build in iterations: (spike ->) prototype → validate → harden. The stack still applies while
    prototyping, unless there is a good reason it should not

- tracking and documentation
  - **issue tracker: GitHub issues**: 
    - use `gh` to interact with issues
    - use the `issue-tracker` skill for further info 
  - `docs/adr/NNNN-<slug>.md` — the durable record (Status / Context / Decision / Consequences).
  - `docs/findings/` — evidence from spikes and experiments 
  - `docs/design/design.md` — rough design guideline, no full design system, copied verbatim from a sibling project  

- host environment
  - a prod instance of factory may be running on this machine (`bun src/cli serve --port 3005`,
    log at `/tmp/factory-serve.log`)
  - we use factory to build factory
  - when doing real agent tests via opencode the preferred model is `opencode-go/big-pickle`
