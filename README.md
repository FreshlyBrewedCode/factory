# factory

**Write agent workflows as ordinary TypeScript. Watch them run. Get pull requests.**

Factory runs coding agents against your repository from workflows you write as
plain `async` functions — `await`, `if`, `try`/`catch`, early returns. No step
graph, no DSL, no YAML. It clones a fresh working tree per run, streams every
event to a live web UI, and opens the pull request itself when the workflow
says so.

```ts
export default defineWorkflow("fix-issue", {
  input: Schema.Struct({ issueNumber: Schema.Int }),

  run: async (ctx, input) => {
    await ctx.agent("implement", `Read issue #${input.issueNumber} with gh and implement it.`);

    // A failing test is just an `if`, not a framework concept.
    const tests = await ctx.exec(["bun", "test"]);
    if (tests.exitCode !== 0) {
      await ctx.agent("fix", `bun test is failing:\n\n${tests.stdout}`);
    }

    const pr = await ctx.writeBack({
      branch: `factory/issue-${input.issueNumber}`,
      commitMessage: `Close #${input.issueNumber}`,
      prTitle: `Fix issue #${input.issueNumber}`,
      prBody: "Opened by factory.",
    });
    return { prUrl: pr.prUrl };
  },
});
```

> **Early, `0.x`, and a proof of concept.** Factory depends on
> `effect@4.0.0-rc.*` and `@tanstack/ai@0.x`, so expect breaking changes
> without a major version bump — that is what staying `0.x` is for. It runs
> agents on your machine against your real repositories; read
> [Before you run it](#before-you-run-it) before pointing it at anything you
> care about.

---

## Quick start

### 1. Install

Factory goes in your project as a dev dependency.

```sh
bun add -d @frebreco/factory
```

**Bun ≥ 1.4.1 is required** — factory ships TypeScript and runs on Bun. You
also need a coding agent, logged in on this machine (that is what does the
work): **Claude Code** (a Claude login via the `claude` CLI, or
`ANTHROPIC_API_KEY`; factory bundles the agent itself) or
[**opencode**](https://opencode.ai) (the CLI on `PATH`, with a provider logged
in). And [`gh`](https://cli.github.com), authenticated (that is what opens the
pull requests). `factory serve` names whatever is missing when it starts.

### 2. Initialise

```sh
bunx factory init
```

That writes a config and one small workflow, and adds the right lines to your
`.gitignore`:

```
your-project/
└── .factory/
    ├── factory.config.ts     ← your project's settings + workflow registry
    └── workflows/
        └── hello.ts          ← a starter workflow, yours to edit
```

`init` reads your repo's `origin` remote and git identity to fill the config
in, so there is usually nothing to edit. Open
`.factory/factory.config.ts` and check the `repo` block points at the
repository you want pull requests opened against.

### 3. Start the daemon

```sh
bunx factory serve
```

Open **http://localhost:3000**. That is the run monitor: every run, its live
transcript, and a button to start a new one.

### 4. Run something

From the UI, hit **New run**, pick `hello`, fill in the form. Or from a
terminal:

```sh
bunx factory start hello --input '{"task": "add a CONTRIBUTING.md"}' --watch
```

`--watch` streams the run's events until it finishes and exits non-zero if it
failed, so it drops straight into a script or a CI job.

The run clones a fresh working tree, hands it to the agent, runs whatever your
workflow runs, and — if the workflow calls `ctx.writeBack` — pushes a branch
and opens a PR. You can watch all of it in the browser while it happens.

---

## Writing workflows

A workflow is one file that default-exports `defineWorkflow`. It declares its
input, and its body is a plain async function.

```ts
import { defineWorkflow, Schema } from "@frebreco/factory";

export default defineWorkflow("my-workflow", {
  input: Schema.Struct({ topic: Schema.String }),
  output: Schema.Struct({ prUrl: Schema.NullOr(Schema.String) }),
  agent: { agent: "opencode", model: "opencode/big-pickle" },

  run: async (ctx, input) => {
    /* ... */
  },
});
```

| Field    | What it is                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| `id`     | The name you start it by — in the UI's picker and in `factory start <id>`                                  |
| `input`  | A schema. It generates the UI's form and validates `--input` **before** the run starts                     |
| `output` | Optional. What `run` resolves to, recorded in the run's history                                            |
| `agent`  | Optional defaults for every agent step: `agent` (`claude` / `opencode`) and `model`                        |
| `run`    | Your workflow: `async (ctx, input) => output`                                                              |

### The `ctx` you get

Six things, and that is the whole surface.

| Call                                              | What it does                                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ctx.agent(name, prompt, opts?)`                  | Run one agent step in the working tree. Each call is a **fresh session** with no memory of the last one                  |
| `ctx.exec(["bun", "test"])`                       | Run a command. Returns `{ exitCode, stdout, stderr }` — **never throws**, so a failure is just an `if`                   |
| `ctx.writeBack({ branch, commitMessage, … })`     | Branch, commit, push, open the PR. Real `git` and `gh`, run by factory — not something the agent is asked to do          |
| `ctx.assert(name, () => …)`                       | Record a named check in the run's history. Returns the result rather than throwing                                       |
| `ctx.log(name, data)`                             | Put anything you want into the run's timeline                                                                            |
| `ctx.dir`                                         | The working tree's path. Factory cloned it for this run; the agent is already in it                                      |

### Structured output from an agent step

Pass a schema and you get a typed value back, not a string to parse:

```ts
const meta = await ctx.agent("pr-metadata", "Summarise the change as JSON.", {
  output: Schema.Struct({ title: Schema.String, body: Schema.String }),
});

meta.output; // { title, body } | undefined
meta.finalText; // the raw text, always
```

### Choosing the agent and model

`agent` and `model` can be named on the `ctx.agent` call, the run
(`factory start --agent/--model`, a schedule's `agent`), the workflow, and the
config (`agent.default`, `agent.models`). The most specific level that names an
agent wins. The model comes from the most specific level that names one, at or
above the level that chose the agent, and otherwise from `agent.models[agent]`.
A model never carries across to another agent. Ids are the agent's own (`haiku`,
`sonnet`, `opus`; `opencode/big-pickle`), passed verbatim. Factory always sends
one, and a step with no model, or with one the agent doesn't offer, fails
before the prompt is sent.

### Registering it

A workflow exists because it is imported into your config. There is no
directory scan and no magic — the array *is* the registry.

```ts
import hello from "./workflows/hello";
import fixIssue from "./workflows/fix-issue";

export default defineConfig({
  workflows: [hello, fixIssue],
  /* ... */
});
```

---

## Configuration

`.factory/factory.config.ts` is your project's entry point.

```ts
import { defineConfig } from "@frebreco/factory";
import hello from "./workflows/hello";

export default defineConfig({
  repo: {
    sshUrl: "git@github.com:acme/widgets.git",
    slug: "acme/widgets",
    baseBranch: "main",
    identity: { name: "Factory", email: "factory@acme.example" },
  },
  workflows: [hello],
  agent: {
    default: "claude",
    models: { claude: "sonnet", opencode: "opencode/big-pickle" },
  },
  maxConcurrentRuns: 2,
  retainedWorkspaces: 10,
});
```

| Key                  | Default              | What it does                                                                        |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| `repo`               | —                    | The repository runs clone from, and where write-back opens PRs                       |
| `workflows`          | —                    | The registry. Imported = available                                                   |
| `agent.default`      | `"opencode"`         | The agent a step runs on unless something more specific names one                     |
| `agent.models`       | `{}`                 | Each agent's model unless something more specific names one. No built-in model       |
| `agent.hostSettings` | `"ignore"` per agent | `"include"` lets runs see your own `~/.claude` / `~/.config/opencode` settings        |
| `maxConcurrentRuns`  | `3`                  | Runs allowed in flight at once. Over the limit is **refused, not queued**            |
| `retainedWorkspaces` | `10`                 | Finished working trees kept for inspection, oldest evicted first. Must be ≥ the limit |
| `workspaceRoot`      | `.factory/workspaces`| Where per-run working trees live                                                      |

Everything factory generates at runtime — the event database, the working
trees — lives under `.factory/` and is gitignored by `init`. Your config and
your workflows are not: commit those.

---

## The CLI

```sh
factory init [--dir <path>] [--force]     # scaffold .factory/ (never overwrites without --force)
factory serve [--port <n>] [--db <path>]  # the daemon: HTTP API, SSE, and the web UI
factory start <workflowId> --input <json> [--watch] [--url <base-url>]
              [--agent claude|opencode] [--model <id>]
factory runs                              # every run this project has recorded
factory log <runId>                       # replay one run's full history
```

`serve` finds `.factory/factory.config.ts` on its own; pass `--config <path>`
to point somewhere else. `start` talks to a running daemon over HTTP — set
`--url` or `FACTORY_URL` if it is not on `http://localhost:3000`.

`factory start --watch` exits **0** when the run completes, **1** when it
fails, and **130** when it is cancelled.

There is also `factory run <workflow.ts> --input <json> --dir <path>`, which
runs a single workflow file directly with no daemon and no UI — useful when
you are iterating on a prompt.

---

## Schedules — automatic dispatch without daemon code

Beyond starting runs by hand, you make the daemon dispatch automatically by
listing **schedules** in your config. A schedule is a workflow, its input, a
cron expression, and an explicit timezone — the daemon validates all of it at
load and fires the workflow on the cron:

```ts
import { defineSchedule } from "@frebreco/factory";

export default defineConfig({
  // ...
  workflows: [readySweep, implementIssue],
  schedules: [
    defineSchedule(readySweep, {
      id: "ready-sweep",
      input: { owner: "<login>", projectNumber: 4 },
      cron: "0 * * * * *", // every minute (6 fields — seconds first)
      timezone: "UTC",
    }),
  ],
});
```

Passing the workflow object itself rather than an id string means the
schedule's `input` is type-checked against the workflow's input schema at
definition site — the same inference `ctx.dispatch` gets at the call site. A
plain object literal (`{ id, workflow: "ready-sweep", ... }`) is still
accepted; its `input` is validated at config load instead of at compile time.

The pattern for "watch a project board and run issues" is a scheduled
**wrapper workflow**: `ready-sweep` runs on a scratch workspace (no clone),
queries the GitHub Project over the GraphQL API, applies your blocker rules —
all of that is ordinary workflow code, project policy you own — and calls
`ctx.dispatch(implementIssue, { issueNumber }, { dedupeKey: "issue:<n>" })`
for each eligible item. Each child is a first-class run with its own
transcript; the dedupe key means a second sweep tick cannot double-dispatch an
in-flight item — it collides and fails visibly instead of quietly dropping.

Missed cron windows are skipped, not replayed, after a daemon restart, and an
overlap `"skip"` schedule does not stack runs. Without schedules, the daemon
simply serves the API and the UI — nothing runs unless you ask for it.

---

## Before you run it

Factory is a proof of concept, and it is honest about what it is not:

- **There is no sandbox isolation.** Agents run as your user, on your machine,
  with your `gh`, Claude and opencode credentials, in a clone of your
  repository, and every permission they ask for is granted. Point it at
  repositories and issues you trust.
- **Workflow inputs reach the agent's prompt.** Anyone who can reach the daemon
  can start a run, so do not expose the port beyond your machine, and never
  interpolate an input straight into `ctx.exec`.
- **It needs your machine's logins.** There is no credential injection yet:
  `gh` and the agents you use must be authenticated on the host.

---

## How it fits together

Three pieces, one shared event log:

- **Workflows** — your imperative TypeScript, running against a working tree.
- **The daemon** (`factory serve`) — owns run lifecycle, concurrency, the event
  database, the scheduler, and an HTTP + SSE API.
- **The UI** — a browser client of that same API. Anything it does, a script can
  do too.

Every run appends to an append-only event log in SQLite as it happens, so a run
that was interrupted still has its full history, and the UI replays then tails
rather than polling for state.

---

## Developing factory itself

```sh
nix develop        # pins Bun and Playwright's browser libraries
bun install
bun run check      # format + lint + typecheck + test
bun run build      # stage the publishable package under dist/npm/factory
```

`sample/` is a complete example project pointed at a real repository. Design
decisions, the ADRs behind them, and the phase-by-phase record live in
[`docs/`](docs/), with [`STATUS.md`](STATUS.md) as the entry point.

## License

MIT — see [`LICENSE`](LICENSE).
