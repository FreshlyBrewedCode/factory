---
title: Schedules
description: Automatic dispatch, without daemon code.
order: 5
---

Beyond starting runs by hand, you make the daemon dispatch automatically by listing schedules in
your config. A schedule is a workflow, its input, a cron expression, and an explicit timezone. The
daemon validates all of it at load and fires the workflow on the cron:

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

Passing the workflow object itself, rather than an id string, means the schedule's `input` is
type-checked against the workflow's input schema at the definition site, the same inference
`ctx.dispatch` gets at the call site. A plain object literal (`{ id, workflow: "ready-sweep", ... }`)
is still accepted; its `input` is validated at config load instead of at compile time.

## The sweep pattern

The pattern for "watch a project board and run issues" is a scheduled wrapper workflow:
`ready-sweep` runs on a scratch workspace with no clone, queries the GitHub Project over the
GraphQL API, applies your blocker rules (all of that is ordinary workflow code, project policy you
own), and calls `ctx.dispatch(implementIssue, { issueNumber }, { dedupeKey: "issue:<n>" })` for
each eligible item. Each child is a first-class run with its own transcript. The dedupe key means a
second sweep tick can't double-dispatch an in-flight item: it collides and fails visibly instead of
quietly dropping it.

Missed cron windows are skipped, not replayed, after a daemon restart, and an overlap `"skip"`
schedule doesn't stack runs. Without schedules, the daemon simply serves the API and the UI:
nothing runs unless you ask for it.

## Next

- [CLI reference](/docs/cli) — start, watch, and inspect runs from a terminal.
