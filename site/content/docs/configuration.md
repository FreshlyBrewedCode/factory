---
title: Configuration
description: Every key in factory.config.ts.
order: 4
---

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
  maxConcurrentRuns: 2,
  retainedWorkspaces: 10,
});
```

| Key                   | Default                | What it does                                                                       |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `repo`                | —                        | The repository runs clone from, and where write-back opens PRs.                      |
| `workflows`           | —                        | The registry. Imported means available.                                              |
| `maxConcurrentRuns`   | `3`                      | Runs allowed in flight at once. Over the limit is refused, not queued.               |
| `retainedWorkspaces`  | `10`                     | Finished working trees kept for inspection, oldest evicted first. Must be at least the limit. |
| `workspaceRoot`       | `.factory/workspaces`    | Where per-run working trees live.                                                    |

Everything factory generates at runtime — the event database, the working trees — lives under
`.factory/` and is gitignored by `init`. Your config and your workflows are not: commit those.

## Next

- [Schedules](/docs/schedules) — add automatic dispatch to this config.
- [CLI reference](/docs/cli) — every command factory ships.
