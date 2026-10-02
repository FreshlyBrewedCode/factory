# 0013. Agents over ACP — one adapter for opencode and Claude Code

## Status

Accepted, 2026-10-02. Implemented by #63–#66 (PRs #69, #71, #72, #73) and validated live in #67
(finding 14, `docs/findings/14-acp-live-leg.md`). The implementation amended §2, §3, §5 and §6.
The changes are marked inline and listed under **Amendments** at the end. Proposed the same day,
based on the spike in finding 13 (`docs/findings/13-acp-agents.md`),
which ran a two-step workflow through the real runtime on both agents. The approach comes from
the sibling project canvas, where it runs in production use (canvas findings 01, 04, 06, 12).

Supersedes ADR 0007 (per-run free port). Amends ADR 0012: §3 (workspace preparation) loses its
only job and §6 (sandbox) is overtaken. §1, §2, §4 and §5 stand. Closes #39 and #40 once
implemented.

## Context

Factory drives exactly one agent, opencode, through `@tanstack/ai-opencode`: `chat()` boots
`opencode serve` inside a `localProcessSandbox` on a free host port, and the adapter talks to it
over HTTP. ADR 0012 made the adapter a seam so a second agent would be "a normal amount of work",
but the opencode adapter has costs that a second adapter would not fix:

- **#24's permission deadlock** is patched by writing `opencode.json` into every run tree, so
  the workspace carries an agent-specific file.
- **ADR 0007's port race** is patched with a bind-then-close probe.
- **Cancel goes through a long chain**: abort → HTTP `session.abort()` → generator `finally` →
  process kill. `agent-step.ts` needs a paragraph and `abortableIterable` to get through it.
- **The model is a provider-qualified constant** (`DEFAULT_MODEL`) with no config level (#40).
- **`permissionMode` is read by nobody** (#39).

The Agent Client Protocol (ACP) is the open, stdio JSON-RPC protocol coding agents speak to
editors. opencode speaks it natively (`opencode acp`). Claude Code speaks it through Anthropic's
`@agentclientprotocol/claude-agent-acp`. canvas drives both through one generic client.
Finding 13 showed that the same client, behind factory's existing `AgentAdapter` interface:

- runs both agents end to end;
- selects the model per step;
- gets structured output on the first parse;
- answers permission asks without writing a file;
- cancels in 2–3 ms with no process left behind.

The finding also surfaced three things this ADR has to decide:

- **Model ids belong to the agent.** opencode's big-pickle is `opencode/big-pickle`; Claude's
  are `sonnet`, `opus`, `claude-sonnet-5`, …
- **An agent left on its own default runs on the host's configuration.** Claude started on the
  `haiku` from `~/.claude/settings.json`.
- **Usage means different things per agent.** opencode reports the last message, Claude the
  whole turn. Both report context in use, and Claude reports cost.

## Decision

### 1. One ACP adapter replaces the opencode adapter

`runtime/acp-adapter.ts` speaks ACP with `@agentclientprotocol/sdk` directly, as canvas's
`agents.ts` does. It does **not** use `chat()` with `@tanstack/ai-acp`'s `acpCompatible`: that
adapter discards `session/new`'s config options and cannot call `session/set_config_option`,
which is the only way to choose a model in either agent (canvas finding 04). Updates become
AG-UI chunks through `@tanstack/ai-acp`'s `translateAcpStream`, so ADR 0003 §2 and ADR 0012 §1
hold unchanged: chunks stay opaque AG-UI, and the SPA keeps folding them with `StreamProcessor`.

The adapter is generic. An agent is a **definition**, and every agent-specific detail lives in
it:

- the launch command;
- the environment;
- the `_meta` sent with `session/new`;
- how host settings are excluded (§3).

Factory ships two definitions, `claude` and `opencode`. A third ACP agent is a third definition.
`@tanstack/ai-opencode`, `@tanstack/ai-sandbox` and `-local-process` are removed, together with
the opencode adapter. The opencode adapter is not kept as an alternative: one implementation,
per ADR 0012 §6's own rule.

### 2. Agent and model are separate fields, and factory always sends the model

The authoring surface gains `agent` next to `model`, at every level of the existing precedence
chain:

```ts
ctx.agent("implement", prompt, { agent: "claude", model: "sonnet" });   // call
defineWorkflow("x", { agent: { agent: "opencode", model: "opencode/big-pickle" }, … });
defineSchedule({ …, agent: { agent: "claude" } });                       // schedule
defineConfig({ agent: { default: "claude", models: { claude: "sonnet", opencode: "opencode/big-pickle" } } });
```

**Resolution:**

- **Agent:** the most specific level that names one, else `config.agent.default`.
- **Model:** the most specific level that names one, counting only the level that chose the
  agent and the levels more specific than it. If none of those names a model, it is
  `config.agent.models[agent]`.

In short, a model never carries across a change of agent. A workflow pinned to `sonnet` and
called once with `{ agent: "opencode" }` runs on opencode's configured default model, not on an
invalid `sonnet`.

**Factory always sends a model.** It never leaves a session on the agent's own default, because
that default comes from the host's settings (finding 13 §1). For the same reason it is not
enough to switch the host's settings off (§3): claude-agent-acp reads the user's model setting
regardless. `DEFAULT_MODEL` is deleted. `factory init` writes `agent.default` and
`agent.models`. An unresolvable model fails the step at its start, before `AgentStepStarted` and
before any agent process (amended: not the run at start, see Amendments).

**A model the agent does not offer fails the step before the prompt is sent.** The error names
the agent and lists some of the models it does offer (finding 13 §1). Model ids are passed
verbatim; factory keeps no catalogue of them.

`AgentStepStarted` records `agent` beside `model`. The field is optional: logs written before
this change have no `agent`.

### 3. Runs ignore the host's agent settings by default

A run reads the **project's** agent configuration and not the operator's: the repository's
`CLAUDE.md` / `AGENTS.md`, `.claude/settings.json` and `opencode.json` apply, while `~/.claude`
and `~/.config/opencode` do not. A run should not depend on whose machine it runs on.

Credentials are not settings: the host's Claude login and opencode's provider auth stay
available.

This is configurable per agent in `factory.config.ts`:

```ts
agent: { hostSettings: { claude: "ignore" | "include", opencode: "ignore" | "include" } }
```

`"ignore"` is the default. `"include"` is the opt-in for an operator who wants their own skills,
plugins or providers in runs. The settings themselves stay in the agents' own files; factory
does not copy them into its config.

**Per agent:**

- **Claude:** `_meta.claudeCode.options.settingSources: ["project", "local"]` (the default is
  `["user", "project", "local"]`). Known residue: claude-agent-acp's own settings reader still
  applies the user's `model`, `permissions.defaultMode` and `availableModels` (finding 13
  addendum). §2 overrides the model and §4 answers every ask. Only an `availableModels`
  allowlist can still narrow what a run may pick, and §2's error message makes that visible.
- **opencode:** the global config directory must be hidden from the opencode process.
  `XDG_CONFIG_HOME` pointed at an empty directory works: the global plugins and the custom
  `omniroute` provider disappear, while the auth-based `opencode` and `opencode-go` providers
  remain. But the variable is inherited by every tool the agent runs, which would hide
  `~/.config/gh` (gh's auth) and git's XDG config too. The implementation ticket chose the
  mechanism (amended, see Amendments): `XDG_CONFIG_HOME` and `OPENCODE_TEST_HOME` point at empty,
  factory-owned directories, and a factory plugin hands the host's `XDG_CONFIG_HOME` back to
  every shell command.
- **Both:** the agent's environment is scrubbed of the parent's `CLAUDE_*` / `CLAUDECODE`
  variables, except the credential ones (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`). A daemon started from inside a Claude Code session otherwise passes its
  effort, subagent model and session ids down to the agents it runs.

### 4. Headless permission is the client's answer

The adapter answers every ACP `session/request_permission` with an allow option, preferring
`allow_always` over `allow_once`. This is #24's policy ("a run never waits on a question nobody
can answer") moved from a file opencode reads into a callback that covers every agent. The
following go away:

- `lib/sandbox-config.ts` (`writeHeadlessPermissions`);
- the `opencode.json` write;
- the `.git/info/exclude` entry;
- `AgentAdapter.prepareWorkspace` and `StartRunOptions.prepareWorkspace`.

Finding 13 confirmed that Claude's "allow always" leaves the tree untouched.

`permissionMode` (#39) is **removed** from `AgentCallOptions`. The ACP `mode` options differ per
agent (Claude: `default / acceptEdits / plan / auto / bypassPermissions`; opencode:
`build / plan`), and with every ask answered the remaining difference is behavioural, such as a
read-only plan mode. When a workflow needs that, it can arrive as an explicit `mode` passthrough
validated like the model. It is not added now.

### 5. Context and cost get their own fields

`AgentStepFinished` gains two optional fields, filled from ACP `usage_update` (the last one of the
step):

- `context: { used, size }` — the context in use and the window size, as the agent measured them;
- `cost: { amount, currency }` — what the agent says the step cost: the latest cost any
  `usage_update` of the step carried (amended, see Amendments).

opencode reports `cost` as `0 USD` for a free model; it is recorded as reported.

`usage` stays the four token components from `PromptResponse.usage`. Its meaning is now "as the
agent reports it": the last message on opencode, the whole turn on Claude. The step's `agent`
(§2) says which, and its doc comment says so. Nothing should bill off `usage`; `cost` exists for
that. `agentStepContextTokens` gives way to `context.used` where present, and stays as the
fallback for logs written before this change.

`usage_update` is not an AG-UI event, so the adapter forwards it as a `CUSTOM` chunk (`acp.usage`)
carrying a new signal, `usage`, with `context` and `cost`. This is the ADR 0012 §2 rule working
as intended: the union grows because factory now has fields for these. The chunk also lets the
SPA show context filling up live.

### 6. One process per step, over stdio

Each `ctx.agent` call spawns the agent with `cwd` set to the run's tree and holds one session for
one prompt. The process ends with the step.

- **Startup:** about 1.5–2 s per step (finding 13 §6), accepted.
- **No session pool:** canvas keeps sessions open because people return to them; a step never
  does.
- **Cancel:** sends ACP `session/cancel`, then kills the process after a 2 s grace and in
  `finally`. Both agents settle the turn as `cancelled` in milliseconds. Finding 14 confirms
  this from the UI and on daemon shutdown. An agent killed from outside (`SIGKILL`) fails the
  step with its exit code, but its in-flight tool processes keep running (#74).
- **Port race:** gone (ADR 0007), since stdio needs no port.
- **Sandbox:** the agent runs on the host in the tree, exactly as under `localProcessSandbox`.
  A future container sandbox wraps the command (`docker exec -i …`), which stdio makes simpler
  than published ports.

### 7. Structured output stays prompt-injected

The adapter appends `appendOutputSchemaInstruction` and parses the last assistant message, then
emits the `structuredOutput` signal. The runtime's tier-2 re-parse (ADR 0002 §3) is unchanged.
An MCP `submit_output` tool would give schema-validated output from both agents (canvas finding
06 shows the per-session MCP server). It is deferred until tier 1 is seen failing in practice.

## Consequences

- **Workflows can use Claude Code.** Choosing the agent is a field, and a project can set its
  defaults in config. That was the point of the change.
- **The replay corpus must be re-recorded.** The `test/corpus` traces are `@tanstack/ai-opencode`
  chunks (`opencode.session-id`, `sandbox.file`, opencode tool names), and the replay adapter
  reads them with `extractOpencodeSignal`. New corpora come from the ACP adapter for both agents.
  Old run logs stay readable, because chunks are opaque.
- **Transcripts show coarser tool names**: ACP tool kinds (`read`, `edit`, `execute`) instead of
  opencode's own. The tool's title (`Edit math.ts`) is in the ACP update but does not reach
  `TOOL_CALL_START`. The adapter forwards it in an `acp.tool-call` chunk (see Amendments).
- **`agent-step.ts` gets simpler.** The abort-chain commentary went. `abortableIterable` and
  the 1 s `AGENT_TEARDOWN_GRACE_MS` stay (#66). A generator's `return()` queues behind a pending
  `next()`, which is generic to any adapter that waits on its agent.
- **New dependencies:** `@agentclientprotocol/sdk`, `@agentclientprotocol/claude-agent-acp`
  (bundles the Claude Agent SDK) and `@tanstack/ai-acp`. `@tanstack/ai` moves to 0.64.
  `@tanstack/ai-sandbox` stays, because `@tanstack/ai-acp` imports it at runtime.
- **Claude runs need a Claude login (or API key) on the daemon's host**, and opencode runs need
  `opencode` on `PATH`. The daemon checks the configured agents at start and names what is
  missing, rather than failing the first step.
- **AGENTS.md's model advice changes**: the preferred test model is `opencode/big-pickle`.
- **Untested until the implementation**, now settled:
  - an opencode ask outside the project (`external_directory`) is answered by the callback
    (`allow_always`), and the step completes (finding 14);
  - an agent crashing mid-turn fails the step with its exit code and stderr tail (finding 14).
    Its tool processes outlive it (#74);
  - an error from an agent: ACP agents report provider errors as a JSON-RPC error on
    `session/prompt`, not as a stop reason. The step fails with the agent's message.
    `translateAcpStream` emits `RUN_ERROR` only for `stopReason: "refusal"`, which no live
    attempt provoked; the adapter's unit test covers it (finding 14);
  - Claude's `settingSources` keeps the user's skills, plugins and `CLAUDE.md` out (finding 13,
    addendum 2).

## Amendments

What the implementation (#63–#66) and the live leg (#67) changed or settled. The decisions above
are edited only to point here.

- **§2: the model is always set, even when it already looks current.** With host settings
  ignored, claude-agent-acp reports the user's `model` setting (`haiku` on the spike's host) as
  the session's current model. The Agent SDK actually runs its own default, a 1M-context model.
  An adapter that skipped `set_config_option` on a match ran `haiku` steps on that default
  (0.080 USD for 330 output tokens, and the model said it was Opus). The adapter now always
  sends the model (#69, `61856f2`). Finding 13 §1's reading of Claude's `currentValue` is
  corrected there.
- **§2: an unresolvable model fails the step, not the run.** A per-call option can still supply
  the model, so the run can't know at `RunStarted`. The failure comes before `AgentStepStarted`
  and before any process is spawned. The error names the levels that could supply a model. There
  is no built-in fallback for config-less paths (#40's acceptance asked for one): factory keeps no
  model of its own. Without a config, the agent is the built-in `DEFAULT_AGENT` (`"opencode"`)
  and every step must name its model.
- **§2: the run level.** `factory start --agent/--model` and `POST /api/runs`'s
  `agent: { agent?, model? }` are the run level, beside a schedule's `agent`. This repository's
  own config defaults to `opencode`, so its runs stay on a free model. `factory init` writes
  `claude`.
- **§3: the opencode mechanism.** `OPENCODE_CONFIG_DIR` only adds a directory, so it hides
  nothing. Three things together keep opencode off the host's settings:
  - `XDG_CONFIG_HOME` points at an empty factory directory. This hides `~/.config/opencode`.
  - A factory plugin (`acp-opencode-plugin.ts`, loaded through `OPENCODE_CONFIG_CONTENT`) uses
    opencode's `shell.env` hook to restore the host's `XDG_CONFIG_HOME` for every shell command,
    so `gh` and `git` keep their config.
  - `OPENCODE_TEST_HOME` points at an empty directory. This hides opencode's home-level reads:
    `~/.claude/skills`, `~/.agents/skills`, `~/.claude/CLAUDE.md` and `~/.opencode`.

  `OPENCODE_TEST_HOME` is undocumented, a test hook by its name. If opencode drops it, the host's
  skills come back into runs and nothing breaks. The host's `OPENCODE_CONFIG*` variables are
  dropped. Evidence: finding 13, addendum 2.
- **§3: residue that `settingSources` does not cover.** Claude Code snapshots the operator's
  login shell into `$CLAUDE_CONFIG_DIR/shell-snapshots/` once per session, and sources the
  snapshot before every shell command (`zsh -c source …/snapshot-zsh-*.sh …`). The snapshot holds
  shell functions, aliases and options. The agent's shell therefore carries the operator's shell
  setup, much as it carries their `PATH`. This is accepted. Hiding it would mean replacing
  `CLAUDE_CONFIG_DIR`, which is where the login lives (finding 14).
- **§4.** `prepareWorkspace` and `writeHeadlessPermissions` are gone (#66), as decided. Write-back's
  stray-artifact cleanup (D16: `.tanstack-projected-*` and a top-level `data/`) went with them.
  It deleted real changes under `data/`, and nothing writes those artifacts any more.
  `WriteBackFinished.cleanedArtifacts` is optional.
- **§5: cost is "latest reported".** Claude sends cost only on a turn's final `usage_update`. The
  figure is cumulative per session, and a step is one session, so an update without a cost
  keeps the earlier figure. A Claude step cancelled mid-turn usually records no cost. Claude's
  mid-turn updates report a 1M window for `haiku`, and only the final one reports 200k. So a
  step cancelled mid-turn records the 1M figure (finding 14). Factory records what the agent
  says.
- **§5 / Consequences: tool titles.** `translateAcpStream` keeps only a tool call's first title,
  which on Claude is generic (`Edit`, `Terminal`). The adapter follows each titled
  `tool_call` / `tool_call_update` with a `CUSTOM` `acp.tool-call` chunk
  (`{ toolCallId, title, input? }`, no signal). The SPA labels transcript tool calls with it (#72).
- **§6: ACP needs an absolute `cwd`.** The default workspace root (`.factory/workspaces`) is
  relative, so the adapter resolves it (#69, `7f9e998`).
- **§6: process cleanup.** Cancel, daemon shutdown and a `SIGTERM`ed `claude` binary leave no
  process behind (finding 14). An agent `SIGKILL`ed from outside leaves its in-flight tool
  processes running, because the adapter kills only the agent's own pid (#74). The daemon's 1 s
  teardown wait is shorter than the adapter's 2 s kill timer. That matters only for an agent that
  ignores `session/cancel` and stdin's close, and none did live.
- **Replay corpus.** Re-recorded through the ACP adapter for both agents
  (`scripts/record-corpus.ts`). The line format grows to `{step, chunk, signal?}`, so replay
  knows no agent's event names (#66).
