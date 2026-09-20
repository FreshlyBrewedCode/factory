---
title: Introduction
description: What factory is, and the shape of a project that uses it.
order: 1
---

factory runs coding agents against a real repository from workflows you write as plain TypeScript.
A daemon owns their lifecycle; a web UI lets you watch them.

## Install

```bash
bunx @frebreco/factory init
```

`init` scaffolds a `.factory/` folder in your project:

```
.factory/
  factory.config.ts   # repo, identity, workflow registry — committed
  workflows/          # your workflows — committed
  factory.db          # regenerable, ignored
  workspaces/         # regenerable, ignored
  runs/               # regenerable, ignored
```

## Run the daemon

```bash
bun x factory serve --port 3005
```

That gives you the HTTP + SSE API, run admission and dispatch, and the web UI on the same port.

## Next

- [Markdown kitchen sink](/docs/kitchen-sink) — every element this site styles, on one page.
