---
title: Introduction
description: What factory is, and the shape of a project that uses it.
order: 1
---

Factory runs coding agents against your repository from workflows you write as plain `async`
functions: `await`, `if`, `try`/`catch`, early returns. No step graph, no DSL, no YAML. It clones a
fresh working tree per run, streams every event to a live web UI, and opens the pull request
itself when the workflow says so.

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

> Factory is early, `0.x`, and a proof of concept. It depends on `effect@4.0.0-rc.*` and
> `@tanstack/ai@0.x`, so expect breaking changes without a major version bump. It runs agents on
> your machine against your real repositories: read [Before you run it](/docs/before-you-run-it)
> before pointing it at anything you care about.

## How a project is shaped

A project owns a `.factory/` folder:

```
your-project/
└── .factory/
    ├── factory.config.ts     # repo, identity, workflow registry — committed
    └── workflows/
        └── hello.ts          # a starter workflow, yours to edit
```

`factory.config.ts` and `workflows/` are committed. Everything else factory generates at
runtime — the event database, the working trees — lives under `.factory/` too, and `init`
gitignores it.

## Three pieces, one event log

- **Workflows** — your imperative TypeScript, running against a working tree.
- **The daemon** (`factory serve`) — owns run lifecycle, concurrency, the event database, the
  scheduler, and an HTTP + SSE API.
- **The UI** — a browser client of that same API. Anything it does, a script can do too.

Every run appends to an append-only event log in SQLite as it happens, so a run that was
interrupted still has its full history, and the UI replays then tails rather than polling for
state.

## Next

- [Quick start](/docs/quick-start) — install, initialize, and run your first workflow.
- [Writing workflows](/docs/writing-workflows) — the shape of `defineWorkflow` and the `ctx` you get.
