---
title: CLI reference
description: Every command factory ships.
order: 6
---

```bash
factory init [--dir <path>] [--force]     # scaffold .factory/ (never overwrites without --force)
factory serve [--port <n>] [--db <path>]  # the daemon: HTTP API, SSE, and the web UI
factory start <workflowId> --input <json> [--watch] [--url <base-url>]
factory runs                              # every run this project has recorded
factory log <runId>                       # replay one run's full history
```

`serve` finds `.factory/factory.config.ts` on its own; pass `--config <path>` to point somewhere
else. `start` talks to a running daemon over HTTP: set `--url` or `FACTORY_URL` if it's not on
`http://localhost:3000`.

`factory start --watch` exits `0` when the run completes, `1` when it fails, and `130` when it's
cancelled.

There's also `factory run <workflow.ts> --input <json> --dir <path>`, which runs a single workflow
file directly with no daemon and no UI. Useful when you're iterating on a prompt.

## Next

- [Before you run it](/docs/before-you-run-it) — what to know before pointing this at a real repository.
