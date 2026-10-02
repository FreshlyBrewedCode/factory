---
title: Writing workflows
description: The shape of defineWorkflow and the ctx you get inside run.
order: 3
---

A workflow is one file that default-exports `defineWorkflow`. It declares its input, and its body
is a plain async function.

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

| Field    | What it is                                                                          |
| -------- | ------------------------------------------------------------------------------------ |
| `id`     | The name you start it by — in the UI's picker and in `factory start <id>`            |
| `input`  | A schema. It generates the UI's form and validates `--input` before the run starts   |
| `output` | Optional. What `run` resolves to, recorded in the run's history                      |
| `agent`  | Optional defaults for every agent step: `agent` and `model`                          |
| `run`    | Your workflow: `async (ctx, input) => output`                                        |

## The `ctx` you get

Six things, and that's the whole surface.

| Call                                          | What it does                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ctx.agent(name, prompt, opts?)`               | Runs one agent step in the working tree. Each call is a fresh session with no memory of the last one. |
| `ctx.exec(["bun", "test"])`                    | Runs a command. Returns `{ exitCode, stdout, stderr }`. It never throws, so a failure is just an `if`. |
| `ctx.writeBack({ branch, commitMessage, … })`  | Branches, commits, pushes, and opens the PR. Real `git` and `gh`, run by factory, not the agent.       |
| `ctx.assert(name, () => …)`                    | Records a named check in the run's history. Returns the result rather than throwing.                  |
| `ctx.log(name, data)`                          | Puts anything you want into the run's timeline.                                                       |
| `ctx.dir`                                      | The working tree's path. Factory cloned it for this run; the agent is already in it.                  |

## Structured output from an agent step

Pass a schema and you get a typed value back, not a string to parse:

```ts
const meta = await ctx.agent("pr-metadata", "Summarise the change as JSON.", {
  output: Schema.Struct({ title: Schema.String, body: Schema.String }),
});

meta.output; // { title, body } | undefined
meta.finalText; // the raw text, always
```

## Choosing the agent and model

A step runs on one of two coding agents, `claude` (Claude Code) or `opencode`, on a model that
agent offers. You can name either at four levels, from most to least specific:

1. the call: `ctx.agent("review", prompt, { agent: "claude", model: "opus" })`;
2. the run: `factory start --agent/--model`, `agent` in `POST /api/runs`, or a schedule's `agent`;
3. the workflow: `defineWorkflow`'s `agent` field;
4. the config: `agent.default` and `agent.models` (see [Configuration](/docs/configuration)).

The agent comes from the most specific level that names one. The model comes from the most specific
level that names one, but only among the level that chose the agent and the levels above it in
that list. If none of them names a model, the agent's entry in `agent.models` applies. So a
model never carries over to a different agent. A workflow pinned to
`{ agent: "claude", model: "sonnet" }` that calls `ctx.agent(name, prompt, { agent: "opencode" })`
runs that step on opencode's configured model, not on `sonnet`.

Model ids belong to the agent and are passed through verbatim: `sonnet`, `haiku`, `opus` or a full
`claude-…` id for Claude, and `provider/model` for opencode (`opencode/big-pickle`). Factory always
sends a model and keeps no default of its own. A step fails before the agent starts if no level
names a model. It also fails before the prompt is sent if the agent doesn't offer the model, and
the error lists some of the ids the agent does offer.

Every permission the agent asks for is granted, including access to files outside the working
tree. A run never waits on a question nobody is there to answer.

## Registering it

A workflow exists because it's imported into your config. There's no directory scan and no magic:
the array is the registry.

```ts
import hello from "./workflows/hello";
import fixIssue from "./workflows/fix-issue";

export default defineConfig({
  workflows: [hello, fixIssue],
  /* ... */
});
```

## Next

- [Configuration](/docs/configuration) — the rest of `factory.config.ts`.
- [Schedules](/docs/schedules) — dispatch a workflow automatically, on a cron.
