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

Bun 1.4.1 or later is required. Factory ships TypeScript and runs on Bun. You also need:

- a coding agent, logged in on this machine. That's what does the work.
  - **Claude Code**: a Claude login (sign in once with the `claude` CLI) or `ANTHROPIC_API_KEY`.
    Factory bundles the agent itself.
  - **opencode**: the [`opencode`](https://opencode.ai) CLI on `PATH`, with a provider logged in.
- [`gh`](https://cli.github.com), authenticated. That's what opens the pull requests.

`factory serve` checks the agents your config uses when it starts, and logs what's missing.

## 2. Initialize

```bash
bunx factory init
```

That writes a config and one small workflow, and adds the right lines to your `.gitignore`. `init`
reads your repo's `origin` remote and git identity to fill the config in, so there is usually
nothing to edit. Open `.factory/factory.config.ts` and check the `repo` block points at the
repository you want pull requests opened against. The `agent` block picks Claude Code on `sonnet`;
switch `default` to `"opencode"` if that's the agent you have.

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
