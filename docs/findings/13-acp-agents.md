# 13 — Driving opencode and Claude Code over ACP

2026-10-02. Script: `spikes/13-acp-agents.ts`, adapter: `src/runtime/acp-adapter.ts` (spike
grade). Versions: `@agentclientprotocol/sdk` 1.7.0, `@agentclientprotocol/claude-agent-acp`
0.85.1 (Claude Code 2.1.280), opencode 1.18.31, `@tanstack/ai` 0.64.0, `@tanstack/ai-acp`
0.3.20. Raw evidence in `spikes/out/` (ignored; regenerate with the script).

## Question

Can factory replace `@tanstack/ai-opencode` with one ACP adapter — the approach the sibling
project canvas proved (canvas findings 01, 04) — and run workflows on opencode **and** Claude
Code, with the model chosen by the workflow? Before an ADR, four things had to be answered:
model selection, token usage, structured output, and headless permission and cancel.

## Setup

The adapter is canvas's `AgentManager.open()` cut down to one session per `stream()` call:
spawn the agent over stdio, `initialize`, `session/new`, set the model with
`session/set_config_option`, `session/prompt`, kill the process. ACP updates become AG-UI
chunks through `@tanstack/ai-acp`'s `translateAcpStream`. It implements the existing
`AgentAdapter` (ADR 0012), so the spike runs the **real** runtime: `startRun`,
`AgentRuntime`, `agent-step.ts`, `resolveOutput`. Nothing in `runtime/` changed.

The workflow (`acp-hello`) runs in a scratch git repo with one `math.ts`:

1. `implement`: "add `multiply(a, b)` to math.ts" (unstructured, edits a file).
2. `ctx.exec(git status --short)`.
3. `report`: "summarise the change", with `output: Struct({summary, changedFiles})`.

Bumping `@tanstack/ai` 0.54 → 0.64 (plus `ai-opencode` 0.4.15 and `ai-sandbox` 0.5.18, which
`ai-acp` requires) left typecheck clean and all 347 `bun test` green, before any adapter code.

## Results

| run | model | outcome | implement | report | structured output |
|---|---|---|---|---|---|
| opencode | `opencode/big-pickle` (its default) | completed | 13.4 s | 7.5 s | tier 1 |
| opencode | `opencode-go/glm-5.3-flash` (switched) | completed | 12.1 s | 23.0 s | tier 1 |
| Claude Code | `sonnet` (switched from `haiku`) | completed | 5.8 s | 6.3 s | tier 1 |
| Claude Code | `no-such-model` | step failed, before any prompt | — | — | — |

Every run changed only `math.ts` (`git status --short --ignored` shows ` M math.ts` and
nothing else: no `opencode.json`, no `.claude/`, no `.tanstack-projected-*`).

### 1. Model selection works, and model ids are per agent

Both agents expose the model as an ACP config option (`category: "model"`), and setting it
takes effect: the option's `currentValue` in the `set_config_option` reply is the new model,
and Claude's `usage_update._meta["_claude/model"]` reports `claude-sonnet-5-5` for a `sonnet`
step.

- **Ids are the agent's own.** Claude offers 12 (`default`, `opus`, `sonnet`, `haiku`,
  `claude-fable-5-1`, `claude-sonnet-5`, …); opencode offers 701.
- **The default comes from the host.** Claude started on `haiku` (the host's
  `~/.claude/settings.json`), opencode on `opencode/big-pickle`. So a workflow that sets no
  model runs on whatever the operator's machine says.
- **opencode's ids are not the ones factory uses.** The first run asked for
  `opencode-go/big-pickle`, the id AGENTS.md recommends, and failed: under ACP the model is
  `opencode/big-pickle`. The adapter refuses an unoffered id, so this surfaced as
  `opencode has no model "opencode-go/big-pickle" (701 offered, e.g. …)` at +1.9 s, not as
  a silent run on the default. The same check failed Claude on `no-such-model`.
- **The other options depend on the model**, as canvas found. With `big-pickle`, opencode
  offers `model` and `mode` only. After the switch to `glm-5.3-flash` it adds `effort`
  (`thought_level`, `low`). Claude adds `effort` once `sonnet` is set.

### 2. Usage: same fields, different meaning per agent

`PromptResponse.usage` (still marked UNSTABLE in the ACP spec) was present on every completed
turn from both agents. `translateAcpStream` maps it onto `RUN_FINISHED.usage`, so
`AgentStepFinished.usage` is filled with no runtime change. But the numbers mean different
things:

| | opencode | Claude Code |
|---|---|---|
| `PromptResponse.usage` covers | the **last** assistant message (`input 139 + cached 13871 ≈ usage_update.used 14010`) | the **whole turn**, summed (`cachedRead 36386` over a ~18k context = two model calls) |
| `cachedWriteTokens` | absent | present (18499); factory's schema drops it |
| `usage_update.used / size` | context in use / window (14010 / 200000) | same (18551 / 1000000) |
| `usage_update.cost` | `0 USD` (free model) | per-session USD (`0.085`, `0.045`) |

opencode under ACP keeps the semantics `AgentStepFinished.usage` already documents (last
message only). Claude reports more: the turn's true spend. A single field now means two
things depending on the agent. `usage_update` brings two things factory does not have yet:
the context in use, measured rather than derived (`agentStepContextTokens`), and a real cost
figure for Claude.

### 3. Structured output: prompt injection is enough for both agents

The adapter appends `appendOutputSchemaInstruction` (from `@tanstack/ai/adapter-internals`,
the same text `acpCompatible` uses) and parses the last assistant message with
`parseJsonFromAssistantText`. It emits a `structured-output.complete` CUSTOM chunk and a
`structuredOutput` signal. All three `report` steps answered with bare JSON that decoded
against the Effect Schema on tier 1. The runtime's tier-2 fallback was never needed. This is
a small sample: three structured steps, all with an easy schema.

### 4. Headless permission: answered by the client, nothing written

- **Claude Code asked once per run**, for `Edit math.ts`, offering `allow-once`
  (`allow_once`), `allow-with-updates` (`allow_always`) and `reject`. The adapter picked
  `allow_always`, and the edit landed.
- **"Allow always" did not touch the workspace.** No `.claude/settings.local.json` was
  written; the tree stayed clean.
- **opencode asked nothing.** Its default policy asks only outside the project, which no step
  needed.

So #24's policy ("never ask, allow") moves into the `requestPermission` callback, where it
applies to every agent. `opencode.json` and `prepareWorkspace`'s only job go away. One
untested case: an opencode ask for a path outside the project (`external_directory`) should
now be answered by the callback, where it used to deadlock. The spike never triggered one.

### 5. Cancel is immediate and leaves no process behind

`cancel` mode starts a long task, cancels after 20 s, and walks the agent's process tree
(`pgrep -P`) beforehand:

| | time to `RunCancelled` | `settled` | agent `stopReason` | processes alive 3 s later |
|---|---|---|---|---|
| opencode | 2 ms | 70 ms | `cancelled` | 0 of 1 |
| Claude Code | 3 ms | 13 ms | `cancelled` | 0 of 2 (`claude-agent-acp` and its `claude` child) |

The adapter sends ACP `session/cancel` on abort and kills the child after a 2 s grace (and in
`finally`). Both agents settled the turn as `cancelled` first. This replaces the
abort → HTTP `session.abort()` → generator `finally` chain described in `agent-step.ts`'s
module comment. `AGENT_TEARDOWN_GRACE_MS` (1 s) was not reached.

### 6. Startup cost per step

| | spawn → `initialize` | → `session/new` | → model set |
|---|---|---|---|
| opencode | 1.2–1.5 s | 1.7–1.9 s | +6–13 ms |
| Claude Code | 0.14 s | 0.8 s | +0.7 s |

About 2 s per step on opencode and 1.5 s on Claude, small next to the 6–23 s steps measured
here. ADR 0007's free-port probe and the `opencode serve` readiness wait are gone.

### 7. Chunks: same AG-UI types, coarser tool names

Both agents produced only AG-UI types the SPA already folds (`RUN_*`, `TEXT_MESSAGE_*`,
`TOOL_CALL_*`, `CUSTOM`). The SPA has no tool-name special-casing (no match for `toolName`,
`bash` or `execute` in `src/web`). Two differences from the opencode corpus:

- **Tool names are ACP tool kinds**: `read`, `edit`, `execute` for both agents, where opencode
  used its own names (`read`, `bash`, …). The descriptive title (`Edit math.ts`) does not
  reach `TOOL_CALL_START`.
- **CUSTOM names change**: `acp.session-id` replaces `opencode.session-id`, and the
  `sandbox.file` chunks are gone, so their back-dated timestamps (finding 1) go with them.
  Factory itself no longer matches either name (ADR 0012 §2), but the replay corpus holds the
  old ones.

**Not checked:** how these transcripts look in the browser.

## What this does not settle

- **Usage semantics.** Should `AgentStepFinished.usage` stay "last message", or become "turn
  total" (which opencode cannot give over ACP)? Should `cachedWriteTokens`, context and cost
  get fields? This is a schema decision for the ADR.
- **Host configuration leaking into runs.** Claude loaded the host's settings (default model
  `haiku`). Whether runs should use `settingSources: ["project"]` (via
  `_meta.claudeCode.options`) was not tried.
- **Permission `mode`.** `permissionMode` (#39) maps to the `mode` option (Claude `default /
  acceptEdits / plan / auto / bypassPermissions`, opencode `build / plan`). The spike left it
  at the default and relied on the callback, so `bypassPermissions` was not run.
- **Session resume** (`session/load`) was not exercised; every step is a fresh session.
- **Long or messy runs.** All steps were small. Tier-2 output, `RUN_ERROR` from an agent, and
  an agent crashing mid-turn (the `exited` race is wired but was not triggered) are untested.

## Addendum: switching off the host's settings (probe, same day)

`session/new` only, with no prompt, comparing the config options each agent reports.

| | setting | starting model | models offered |
|---|---|---|---|
| Claude Code | default (`settingSources: user, project, local`) | `haiku` | 12 |
| Claude Code | `_meta.claudeCode.options.settingSources: ["project", "local"]` | `haiku` | 12 |
| Claude Code | `settingSources: []` | `haiku` | 12 |
| opencode | default | `opencode/big-pickle` | 715 (providers `opencode-go`, `opencode`, `omniroute`) |
| opencode | `XDG_CONFIG_HOME` → empty dir | `opencode/big-pickle` | 39 (`opencode-go`, `opencode`) |

- **Claude's starting model ignores `settingSources`.** claude-agent-acp builds its own
  `SettingsManager` (`dist/acp-agent.js`, `new SettingsManager(params.cwd, …)`) and takes the
  user's `model`, `permissions.defaultMode` and `availableModels` from it, whatever the SDK is
  told. `settingSources` still reaches the SDK (the adapter spreads the client's options over its
  own `["user", "project", "local"]`); its effect on skills and `CLAUDE.md` needs a prompt to
  observe and was not checked. Practical consequence: the only reliable way off the host's model
  is to always set one.
- **opencode's global config is `~/.config/opencode/opencode.jsonc`.** Hiding it removes its
  plugins and the custom `omniroute` provider. The auth-based providers stay, because their
  credentials live in the data dir, not the config dir. `XDG_CONFIG_HOME` is a blunt way to hide
  it: every tool the agent runs inherits the variable (gh keeps its auth in `~/.config/gh`).
- **The parent's environment leaks into the agent.** When run from inside a Claude Code session,
  the agent inherits `CLAUDECODE=1`, `CLAUDE_EFFORT`, `CLAUDE_CODE_SUBAGENT_MODEL`,
  `CLAUDE_CODE_SESSION_ID`, …

Conclusions → [`adr/0013-agents-over-acp.md`](../adr/0013-agents-over-acp.md).

## Addendum 2: host settings, verified with a prompt (#63, same day)

The production adapter (`src/runtime/acp-adapter.ts`, definitions in `acp-agents.ts`) run
through `bun spikes/13-acp-agents.ts isolation <agent> <model> [ignore|include]`. The scratch
repo carries **project** settings: `CLAUDE.md` and `AGENTS.md` with a codeword each, and a skill
in `.claude/skills` and one in `.agents/skills`. One structured step asks the agent which skills
it has and which codewords its instructions hold, then runs `echo $XDG_CONFIG_HOME`,
`gh auth status`, `git config --global --list --show-origin` and `env` through its own shell.
The host has 36 entries in `~/.claude/skills` (49 `SKILL.md` files below them) plus the
`anthropic-skills` plugin, 34 in `~/.agents/skills`, `gh-stack` in `~/.config/opencode/skills`,
and no `~/.claude/CLAUDE.md`. For
the user-level `CLAUDE.md`, Claude ran with `CLAUDE_CONFIG_DIR` pointing at a copy of `~/.claude`
made of symlinks plus a `CLAUDE.md` holding a codeword, so the real `~/.claude` stayed untouched.

### Claude Code: `settingSources: ["project", "local"]` keeps skills and `CLAUDE.md` out

| `hostSettings` | skills listed | host skills among them | user `CLAUDE.md` codeword | project `CLAUDE.md` codeword | project skill |
|---|---|---|---|---|---|
| `include` (SDK default `user, project, local`) | 47 | 21 user + 13 `anthropic-skills:*` | seen | seen | seen |
| `ignore` (`project, local`) | 14 | none | **not seen** | seen | seen |

The other 13 are Claude Code's bundled skills (`simplify`, `loop`, `claude-api`, …). The open
question of the first addendum is settled: `settingSources` keeps the user's skills, plugins and
`CLAUDE.md` out of a run. The residue stays as described there: claude-agent-acp still reads the
user's `model`, `permissions.defaultMode` and `availableModels` itself. Factory always sends a
model and answers every ask, so only an `availableModels` allowlist could still narrow a run.

### opencode: `OPENCODE_CONFIG_DIR` does not hide anything

opencode 1.18.31 (read from the bundled source, then measured) builds its config directories as
`[$XDG_CONFIG_HOME/opencode, project .opencode dirs, ~/.opencode, $OPENCODE_CONFIG_DIR]` and loads
the global config file from the first unconditionally. `OPENCODE_CONFIG_DIR` **adds** a
directory: with it set to an empty dir, `session/new` still offered 715 models including the
host's `omniroute` provider. `XDG_CONFIG_HOME` is read once, at start, into opencode's paths. The
bash tool spawns with `{...process.env, ...shell.env hook output}`. That makes the mechanism:

- `XDG_CONFIG_HOME` → an empty factory-owned dir hides `~/.config/opencode`;
- a factory plugin (`src/runtime/acp-opencode-plugin.ts`, loaded by file URL through
  `OPENCODE_CONFIG_CONTENT`) uses opencode's `shell.env` hook to hand the host's
  `XDG_CONFIG_HOME` (or `~/.config`) back to every shell command, so `gh` and git keep their
  config.

That still left a second leak. opencode also reads **home-level** files of its own accord:
`~/.claude/skills`, `~/.agents/skills`, `~/.claude/CLAUDE.md` and `~/.opencode`. They hang off
its notion of home, which `OPENCODE_TEST_HOME` overrides. The variable changes neither `HOME`
nor the data dir, so provider logins are kept.

| opencode env | skills listed | host skills | project skills | models offered | shell `XDG_CONFIG_HOME` | `gh auth status` | git global config |
|---|---|---|---|---|---|---|---|
| `include` (host's own) | 51 | 48 | both | 715 | unset | logged in | read |
| `XDG_CONFIG_HOME` + plugin | 51 | 48 | both | 39 | `/home/karl/.config` | logged in | read |
| … + `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` | 36 | 34 (`~/.agents`) | `.agents` only | 39 | `/home/karl/.config` | logged in | read |
| … + `OPENCODE_TEST_HOME` → empty dir (**shipped**) | 3 | none | both | 39 | `/home/karl/.config` | logged in | read |

The 3 skills are opencode's built-in `customize-opencode` and the two project skills. In every
variant opencode took the project's `AGENTS.md` codeword; it reads `CLAUDE.md` only when there is
no `AGENTS.md`. The 39 models are the auth-based `opencode` and `opencode-go` providers. Hiding the
host's skill listing shrank opencode's prompt: the `implement` step's cached input went from
~13.9k to ~7.7k tokens.

- `OPENCODE_DISABLE_CLAUDE_CODE` / `_SKILLS` / `_PROMPT` are not an alternative. They also drop the
  project's `.claude/skills` and `CLAUDE.md`, and leave `~/.agents/skills` in.
- `OPENCODE_TEST_HOME` is undocumented, a test hook by its name. If opencode drops it, the host's
  skills reappear in runs; nothing breaks. Other effects, read from the source: `~/` in a
  project's opencode config (permission patterns, `skills.paths`, `instructions`, MCP paths)
  resolves against the empty dir; the TUI's path display is not used under ACP.

### Environment scrub

The adapter's agent environment drops `CLAUDECODE` and every `CLAUDE_*` variable except
`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK` and
`CLAUDE_CODE_USE_VERTEX` (where the credentials are, or which provider pays). Run from this Claude
Code session: 12 `CLAUDE*` variables in the parent, none passed on. With the parent's
`CLAUDE_EFFORT`, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_SUBAGENT_MODEL` set to a sentinel, the
sentinel appeared 0 times in either agent's shell. Claude's shell still shows `CLAUDECODE`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_EFFORT`, … — those belong to the agent's own Claude Code
session. opencode's shell shows none.

### Availability

`checkAgents(["claude", "opencode"])` reports `opencode` missing from PATH (`Bun.which`) and
Claude not logged in. The second comes from the bundled CLI's `auth status --json`
(`bun …/claude-agent-acp/dist/index.js --cli auth status --json`, ~0.25 s): logged out means no
claude.ai login, no API key source and the first-party backend. On this host both pass. With
`HOME` pointed at an empty dir and opencode off PATH, both are reported.
