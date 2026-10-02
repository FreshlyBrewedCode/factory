# 14 — ACP agents, live through `factory serve` and the UI

2026-10-02, issue #67. This is the live leg of epic #62, run on the full stack (#69, #71, #72,
#73). Versions: `@agentclientprotocol/claude-agent-acp` 0.85.1 (Claude Code 2.1.286),
`@agentclientprotocol/sdk` 1.7.0, `@tanstack/ai-acp` 0.3.20, opencode 1.18.31, bun 1.4.2. Models:
Claude `haiku`, opencode `opencode/big-pickle`.

## Question

Does the ACP runtime hold up on the paths the spike and the unit tests could not reach? Those
paths are:

- a real multi-step workflow on each agent, through the daemon and the UI;
- an opencode ask outside the project;
- an agent crashing mid-turn;
- an error reported by an agent;
- cancel from the UI;
- two concurrent runs, one per agent;
- daemon shutdown with agents mid-turn.

## Setup

Everything lived in `/tmp/factory-live67/`, away from the production instance on port 3005 and
from GitHub:

- `origin.git`: a local bare origin with `HEAD → main`, seeded with a bun package
  (`src/index.ts` with `greet`, and `src/index.test.ts`).
- `project/`: a clone of it. `factory init` scaffolded `.factory/`, and its generated config
  loaded unchanged (`agent: { default: "claude", models: { claude: "sonnet", opencode:
  "opencode/big-pickle" } }`). The config was then edited:
  - `repo.slug: "local/fixture"`;
  - `agent.models.claude: "haiku"`;
  - `maxConcurrentRuns: 3`.
  
  `node_modules/@frebreco/factory` is a symlink to the worktree.
- Two workflows:
  - `implement-issue`: `e2e/implement-issue.ts` without the tree-snapshot asserts. It runs
    implement → `bun test` → fix/review → `bun test` → structured `pr-metadata` →
    `ctx.writeBack`.
  - `probe`: one `ctx.agent` step with a free prompt, then `git status`.
- `bin/gh`, a fake `gh` on the daemon's `PATH`. It prints issue #1 ("add slugify") for
  `gh issue view` and a fake URL for `gh pr create`. Write-back pushed to the local origin.
- `factory serve --port 3067 --db /tmp/factory-live67/factory.db`, started from inside a Claude
  Code session (so with `CLAUDE_*` variables set, which the adapter scrubs).
- The browser was playwright-cli (chromium) in `nix develop`. Run events were read from the test
  db. Process trees were walked from the daemon's pid (`ps --ppid`, recursively).
- `/tmp/factory-live67/diag.ts` drove `acpAdapter` directly with `onDiagnostic` for the two
  questions the event log cannot answer: whether a permission ask happened, and the agent's raw
  stop reason.

## Results

| # | scenario | result |
|---|---|---|
| 1 | `implement-issue` on Claude, started from the UI's New run dialog | **pass**: completed in 57.0 s |
| 2 | `implement-issue` on opencode (`factory start --agent opencode`), watched in the UI | **pass**: completed in 133.6 s |
| 3 | two concurrent runs, one per agent (1 and 2 overlapped by 45 s) | **pass** |
| 4 | opencode `external_directory` ask | **pass**: asked, answered `always`, file written |
| 5 | agent crashing mid-turn (`kill -9`) | **pass** for the run (the step fails with the exit code); **defect**: tool processes outlive it → #74 |
| 6 | an error from an agent | **pass**: a provider error fails the step with the agent's message; no live `RUN_ERROR` (see 6) |
| 7 | cancel from the UI, per agent | **pass**: 0 processes left |
| 8 | daemon shutdown with both agents mid-tool | **pass**: exit in 108 ms, both `RunCancelled`, 0 processes 3 s later |

### 1–3. The multi-step workflow on both agents, concurrently

| | Claude / haiku | opencode / big-pickle |
|---|---|---|
| `implement` | 26.1 s, 171 chunks, 24.5k/200k ctx, $0.059 | 28.9 s, 180 chunks, 9.7k/200k ctx, $0 |
| `bun test` | exit 0 | exit 0 |
| `fix` (review) | 22.6 s, 23.5k ctx, $0.027 | 95.3 s, 1494 chunks, 20.1k ctx, $0 |
| `bun test` | exit 0 | exit 0 |
| `pr-metadata` | 7.9 s, structured on tier 1 | 9.1 s, structured on tier 1 |
| write-back | `factory/issue-1-add-slugify` pushed | the same branch name collided and was retried as `…-2900c9b0` (D32) |
| run | completed, 57.0 s, run cost **$0.104** in the UI | completed, 133.6 s |

The Claude run started at 20:44:36 and the opencode run at 20:44:48. They overlapped until
20:45:33 in separate trees under `.factory/workspaces/`. The fake `gh` logged three
`issue view` calls and one `pr create` per run. Once both runs had finished, no
`claude-agent-acp`, `claude` or `opencode acp` process was left.

In the UI, run detail showed each step row as `171 chunks · 24.5k/200k ctx · $0.059`. The step
inspector showed `agent claude`, `model haiku`, `context 24.5k / 200k · 12%` and the four token
counts. While a Claude step ran, its row read `…/1m ctx` (#72's mid-turn window).

### 4. opencode asks outside the project

The `probe` prompt asked opencode to create `/tmp/factory-live67/outside/ext-opencode.txt` with
its write tool and read it back. Through the daemon, the step completed in 5.9 s, the file held
`factory-ext-ok`, and the run's tree stayed clean (`git status` empty). The same prompt through
`diag.ts` shows the ask:

```
+6595ms {"kind":"permission","title":"/tmp/factory-live67/outside",
         "options":[{"optionId":"once","kind":"allow_once"},{"optionId":"always","kind":"allow_always"},
                    {"optionId":"reject","kind":"reject_once"}],"chosen":"always"}
+22550ms {"kind":"done","stopReason":"end_turn",…}
```

#24's deadlock does not recur. The callback answers the ask, and no file is written into the
tree.

### 5. An agent crashing mid-turn

The `probe` asked the agent to run `python3 -c "import time; time.sleep(120)"`. Claude Code
refuses a long `sleep`, which is why the command uses python. Mid-tool, the agent process was
`kill -9`ed:

| killed | step result | processes after |
|---|---|---|
| Claude's `claude-agent-acp` | failed at 32.0 s: `claude exited (code 137); stderr:` + the last 12 stderr lines; `RunFailed` | `claude`, its `zsh` and `python3` reparented to init and alive until the `sleep` ended, about 90 s later |
| Claude's `claude` binary (`SIGTERM`) | failed at 17.8 s: `Internal error: The Claude Agent process exited unexpectedly. Please start a new session.` | none |
| `opencode acp` | failed at 6.1 s: `opencode exited (code 137)` | `python3` reparented to init |

The exit race in the adapter works: the step fails promptly, with the exit code and stderr. The
adapter kills only the agent's own pid, though, and that pid is already dead. Process groups
explain the leftovers:

- `claude` shares the daemon's group, and its shell runs in its own session;
- opencode's tool has its own group (`pgid == pid`).

So nothing reaches the orphans. A `SIGTERM` to `claude` does clean up its shell, which is why
the second row leaves nothing. Filed as **#74**, with the options.

### 6. An error from an agent

`translateAcpStream` emits `RUN_ERROR` only for `stopReason: "refusal"`
(`@tanstack/ai-acp/dist/esm/stream/translate.js`). Other agent errors come back as a JSON-RPC
error on `session/prompt`, which the adapter turns into a failed step. Attempts:

- **Refusal:** Anthropic's refusal test string as the prompt, on `haiku` and on `sonnet`. Both
  ended `end_turn`; sonnet answered "I don't see a task in your message". The string did not
  trigger a refusal through Claude Code. No other benign way to make Claude refuse was found. The
  path stays covered by the adapter's unit test (fake agent with `stopReason: "refusal"` →
  `RUN_ERROR` chunk + `runError` signal).
- **Provider error:** opencode on `opencode-go/muse-spark-1.3-contributor`, a model this
  workspace may not use. Through the daemon, the step failed after 71.6 s (opencode retries
  upstream) with `Internal error: Upstream request failed: This Go model trains on request data.
  Allow paid endpoints that train on request data in your workspace's Privacy settings to use
  it.`, and the run failed with the same message. The step recorded `context: {used: 0, size:
  1048576}`.
- **Gated Claude models:** `claude-fable-5-1` and `claude-opus-4-6` both answered normally, so no
  entitlement error was available to provoke.
- **Unknown model:** fails before the prompt, as recorded in #69 and #71. Not repeated here.

An agent-side error therefore reaches the operator as a failed step carrying the agent's own
message. Two cosmetic points: the transcript has no closing `RUN_ERROR` chunk for it, and the
recorded `error` string has an Effect stack trace appended after the message.

### 7. Cancel from the UI

| | started | cancelled at | step | processes 3 s later |
|---|---|---|---|---|
| Claude | New run dialog, `probe` with the python sleep | 40.4 s | `cancelled`, `RunCancelled` | 0 of 4 (`claude-agent-acp`, `claude`, `zsh`, `python3`) |
| opencode | `POST /api/runs` with `agent: {agent: "opencode"}` | 6.9 s | `cancelled`, `RunCancelled` | 0 of 2 (`opencode acp`, `python3`) |

The button needs two clicks: **cancel**, then **confirm cancel** within 4 s. Driven by separate
playwright-cli calls, the window lapsed twice before both clicks went in one `run-code`. This is
a tooling note, not a defect. The cancelled Claude step recorded `context.size: 1000000`, the
mid-turn figure (see ADR 0013's amendments to §5), and no cost.

### 8. Daemon shutdown with agents mid-turn

Two `probe` runs, Claude and opencode, were both inside the python sleep. The process tree before
shutdown:

```
claude-agent-acp → claude → zsh → python3
opencode acp → python3
```

`kill -TERM <daemon>`. The daemon exited **108 ms** later. Both runs recorded `AgentStepFinished
{outcome: "cancelled"}` and `RunCancelled` at +7.0 s. At the daemon's exit, only `claude` was
still alive, reparented to init. 3 s later none of the six processes were.

The suspected defect from #73 (the daemon gives up after the 1 s teardown wait while the
adapter's kill timer is 2 s) did not show. Both agents settle `session/cancel` in milliseconds,
and `claude` exits on its own once its stdin closes. It would matter only for an agent that
ignores both. It is recorded in #74, whose fix (kill the agent's process group on exit) would
cover it.

## Other observations

- **Claude Code sources the operator's shell.** Every shell command Claude runs is
  `zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-<id>.sh … && <command>`. Claude Code
  writes the snapshot once per session from the operator's login shell, into
  `$CLAUDE_CONFIG_DIR/shell-snapshots/`, and removes it when the session ends (the runs'
  snapshot files were gone afterwards). The snapshot holds shell
  functions, aliases and options. `settingSources` doesn't cover it: it is host state of the same
  kind as `PATH`. Accepted and recorded in ADR 0013 (§3 residue).
- **The New run dialog cannot choose an agent or model.** Its raw-JSON mode edits only the
  workflow input. So every opencode run here was started with the CLI or `curl` (the config
  default is `claude`). Filed as **#75**.
- **Workspaces clone at the origin's `HEAD`, not `repo.baseBranch`.** This is #72's note,
  confirmed in `allocateWorkspace` (`git clone <mirror> <dir>`, no `--branch`). It is pre-existing
  and not ACP-specific. Filed as **#76**.
- **Every page load logged a `TypeError`** (`reading 'FACTORY_AGENTATION'`), because
  `factory serve`'s bundle has no `import.meta.env`. Fixed on this layer (`?.`).

## Issues filed

- #74 (bug, parent #62): a `SIGKILL`ed agent leaves its in-flight tool processes running.
- #75 (task, parent #62): choose agent and model in the New run dialog.
- #76 (bug, no parent: pre-existing): clone the run's tree at `repo.baseBranch`.

Conclusions → [`adr/0013-agents-over-acp.md`](../adr/0013-agents-over-acp.md) (accepted, with
amendments).
