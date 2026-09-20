---
title: Quick start
description: Install factory, scaffold a project, and run your first workflow.
order: 2
---

## 1. Install

Factory goes in your project as a dev dependency.

```bash
bun add -d @frebreco/factory
```

Bun 1.4.1 or later is required. Factory ships TypeScript and runs on Bun. You also need the
[`opencode`](https://opencode.ai) CLI, logged in (that's the agent doing the work), and
[`gh`](https://cli.github.com), authenticated (that's what opens the pull requests).

## 2. Initialize

```bash
bunx factory init
```

That writes a config and one small workflow, and adds the right lines to your `.gitignore`. `init`
reads your repo's `origin` remote and git identity to fill the config in, so there is usually
nothing to edit. Open `.factory/factory.config.ts` and check the `repo` block points at the
repository you want pull requests opened against.

## 3. Start the daemon

```bash
bunx factory serve
```

Open `http://localhost:3000`. That's the run monitor: every run, its live transcript, and a
button to start a new one.

## 4. Run something

From the UI, hit **New run**, pick `hello`, and fill in the form. Or from a terminal:

```bash
bunx factory start hello --input '{"task": "add a CONTRIBUTING.md"}' --watch
```

`--watch` streams the run's events until it finishes and exits non-zero if it failed, so it drops
straight into a script or a CI job.

The run clones a fresh working tree, hands it to the agent, runs whatever your workflow runs, and
pushes a branch and opens a PR if the workflow calls `ctx.writeBack`. You can watch all of it in
the browser while it happens.

## Next

- [Writing workflows](/docs/writing-workflows) — the shape of `defineWorkflow` and the `ctx` you get.
- [Configuration](/docs/configuration) — every key in `factory.config.ts`.
