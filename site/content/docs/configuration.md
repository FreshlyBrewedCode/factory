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
  agent: {
    default: "claude",
    models: { claude: "sonnet", opencode: "opencode/big-pickle" },
  },
  maxConcurrentRuns: 2,
  retainedWorkspaces: 10,
});
```

| Key                   | Default                | What it does                                                                       |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `repo`                | —                        | The repository runs clone from, and where write-back opens PRs.                      |
| `workflows`           | —                        | The registry. Imported means available.                                              |
| `agent.default`       | `"opencode"`             | The agent a step runs on when nothing more specific names one: `"claude"` or `"opencode"`. |
| `agent.models`        | `{}`                     | Each agent's model when nothing more specific names one. There is no built-in model.  |
| `agent.hostSettings`  | `"ignore"` per agent     | Whether runs see your own agent settings. See below.                                 |
| `maxConcurrentRuns`   | `3`                      | Runs allowed in flight at once. Over the limit is refused, not queued.               |
| `retainedWorkspaces`  | `10`                     | Finished working trees kept for inspection, oldest evicted first. Must be at least the limit. |
| `workspaceRoot`       | `.factory/workspaces`    | Where per-run working trees live.                                                    |

`factory init` writes `default: "claude"` and a model for both agents. A run's steps need a model
from some level ([Choosing the agent and model](/docs/writing-workflows#choosing-the-agent-and-model)):
with no `agent.models` entry, every step has to name one.

## Agents and your machine's settings

A run uses the project's agent configuration: the repository's `CLAUDE.md`, `AGENTS.md`,
`.claude/` and `opencode.json`. By default it ignores yours, so a run behaves the same whichever
machine it runs on:

- **Claude** loads project and local settings only. Your `~/.claude` skills, plugins and
  `CLAUDE.md` stay out.
- **opencode** gets an empty config and home directory of its own. Your `~/.config/opencode`
  plugins and providers, and the skills under `~/.claude` and `~/.agents`, stay out. The agent's
  shell commands still see your real config directory, so `gh` and `git` keep working.

Logins are not settings: Claude's login and opencode's provider auth stay available either way.
To give runs your own skills, plugins or providers, opt in per agent:

```ts
agent: { hostSettings: { claude: "include", opencode: "ignore" } }
```

Everything factory generates at runtime — the event database, the working trees — lives under
`.factory/` and is gitignored by `init`. Your config and your workflows are not: commit those.

## Next

- [Schedules](/docs/schedules) — add automatic dispatch to this config.
- [CLI reference](/docs/cli) — every command factory ships.
