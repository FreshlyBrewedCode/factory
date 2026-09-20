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
  agent: { model: "opencode-go/glm-5.3-flash" },

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
| `agent`  | Optional defaults for every agent step — mainly `model`                              |
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
