# Phase 0 findings

Evidence log for the phase-0 spike work described in `STATUS.md`. Each
section corresponds to one spike run. Findings are written for a reader who
was not there — every claim below cites the exact source file/line or the
exact NDJSON/`ps`/`git` output it's based on, not just "the docs say".

## 0a-1

Scope: one opencode agent step through `@tanstack/ai` + `localProcessSandbox`
(D7), against a real host clone of `factory-spike`, with the raw stream
dumped to NDJSON (D14). Not the full round trip (that's 0a-2).

### What was built

Three-piece seam under `src/spike/` (D13 — no `defineWorkflow`, no registry,
no Effect):

- **Workflow** (`src/spike/workflow.ts`) — `implementSlugify(ctx)`, plain
  async function over a `WorkflowContext` (`agentStep`, `exec`). Contains
  `ISSUE_1_PROMPT`.
- **Utilities** (`src/spike/lib/`) — `exec.ts` (`hostExec` via `Bun.spawn`,
  never throws on non-zero exit, sandcastle-style), `clone.ts`
  (`resetSpikeClone`: wipe + `git clone` + repo-local git identity),
  `ndjson.ts` (`createNdjsonSink`: raw `JSON.stringify` per line, no
  filtering), `agent-step.ts` (`runAgentStep`: the `chat()` +
  `withSandbox` + `opencodeText` + `localProcessSandbox` call, with
  `AbortController`-based timeout).
- **Runtime** (`src/spike/runtime.ts`) — orchestrates paths, the NDJSON
  sink, `ps` before/after snapshots, the clone reset, and prints a report.
  Entry point: `bun run src/spike/runtime.ts`.

### Packages installed

```
"@tanstack/ai": "^0.4.4"
"@tanstack/ai-opencode": "^0.4.4"
"@tanstack/ai-sandbox": "^0.4.4"
"@tanstack/ai-sandbox-local-process": "^0.4.4"
```

(exact resolved versions — see `package.json`/`bun.lock` diff in this
commit).

### Run evidence

One successful run: `runId=run-1789306198987`,
`ndjsonPath=/data/src/factory/.factory/runs/run-1789306198987/chunks.ndjson`
(44 lines/chunks), model `opencode-go/deepseek-v4.1-flash`, target
`git@github.com:FreshlyBrewedCode/factory-spike.git` issue #1
(`slugify(input: string): string`).

Result: the agent correctly implemented `slugify` in the clone's
`src/index.ts` (lowercase, trim, replace non-alphanumeric runs with a single
hyphen, strip leading/trailing hyphens) and added a matching test in
`src/index.test.ts`, without touching the existing `greet` export/test.
`bun test` inside the clone passed 2/2. `timedOut: false`.

Chunk type counts (from `AgentStepResult.chunkTypeCounts`, corroborated by
reading the raw NDJSON):

```json
{"RUN_STARTED":1,"CUSTOM:sandbox.file":3,"CUSTOM:opencode.session-id":1,
 "TEXT_MESSAGE_START":3,"TEXT_MESSAGE_CONTENT":3,"TEXT_MESSAGE_END":3,
 "TOOL_CALL_START":6,"TOOL_CALL_ARGS":6,"TOOL_CALL_END":6,"TOOL_CALL_RESULT":6,
 "REASONING_START":1,"REASONING_MESSAGE_START":1,"REASONING_MESSAGE_CONTENT":1,
 "REASONING_MESSAGE_END":1,"REASONING_END":1,"RUN_FINISHED":1}
```

### Open questions, answered with evidence

#### 1. Workspace `source` semantics: in-place or copy? Is `source` even needed?

**Answer: `{type:'local',path}` is dead code in the installed package. The
provider-level `localProcessSandbox({dir})` is what actually pins the
sandbox at a host directory, in place (no copy). `workspace.source` was set
to `{type:'none'}`.**

Evidence:

- `node_modules/@tanstack/ai-sandbox/dist/esm/bootstrap.js` — the installed
  `bootstrapWorkspace()` only has a case for `source.type === 'git'`;
  `'local'` and `'none'` both fall through as a no-op. Reading the compiled
  bootstrap confirms there is no code path that reads `source.path` at all
  today, contradicting the docs' implication that `{type:'local',path}` is
  a supported, exercised knob.
- `node_modules/@tanstack/ai-sandbox-local-process/dist/esm/provider.js`
  (`create(_input)`, lines ~38-42): when `config.dir` is set,
  `root = path.resolve(this.config.dir)`, then `fsp.mkdir(root, {recursive:
  true})` — no `fs.cp`/copy call anywhere in this path. `_input` (which is
  where a `WorkspaceSource` would arrive) is unused (`_` prefix). The only
  `fsp.cp` call in the whole file is inside `forkFactory` (for explicit
  `.fork()`), which our run never calls.
- Empirical in-place confirmation (inode/path identity, not just docs, per
  the task's explicit ask): after the run,
  `find /data/src/factory/.factory -maxdepth 1 -type d` shows exactly one
  `factory-spike` directory — no second copy anywhere under `.factory/`,
  and `find /tmp -iname '*tanstack*' -o -iname '*sandbox*'` shows no
  tanstack-sandbox temp directories were created (the provider's own
  `baseDir()` default, `os.tmpdir()/tanstack-ai-sandboxes`, was never used
  because `dir` was set). `stat -c '%i %n'` on the clone directory and on
  the edited `src/index.ts` inside it show ordinary inodes in the one real
  clone path; the agent's diff (verified via `git diff src/index.ts` in
  that same directory) is the change that landed. Since the provider code
  path taken for `create()` with `dir` set contains no copy step and only
  one instance of the tree exists on disk, the edits necessarily happened
  in place, not on a copy.
- **Conclusion for future phases**: under `localProcessSandbox`, ignore
  `workspace.source` entirely for "point at an existing host dir" — use
  `provider: localProcessSandbox({dir: hostPath})` and
  `workspace: defineWorkspace({source: {type: 'none'}, setup: []})`. This
  contradicts the sandbox docs' framing that workspace `source` is the
  primary way to get code into a sandbox; see BLOCKERS/CONTRADICTIONS.

#### 2. Which CUSTOM events actually arrive from `opencodeText`?

**Answer: exactly `sandbox.file` and `opencode.session-id`. `file.changed`
and `sandbox.file.diff`, which the sandbox docs (events.md) describe as
emitted by "the harness adapter" on every run, were never observed.**

Evidence: `AgentStepResult.customEventNames` from the run =
`["sandbox.file","opencode.session-id"]`; confirmed by grepping the raw
NDJSON for `"type":"CUSTOM"` (4 matching lines total: 3×`sandbox.file`,
1×`opencode.session-id`; 0×`file.changed`, 0×`sandbox.file.diff`).

Reading `node_modules/@tanstack/ai-opencode/src/stream/translate.ts`
confirms this isn't a fluke: the opencode adapter's translation layer only
ever constructs `CUSTOM` events named `opencode.session-id`
(`SESSION_ID_EVENT`) and `opencode.todo` (`TODO_EVENT`) itself. `todo` never
fired because the task was simple enough that opencode didn't use its
todo-list tool. `sandbox.file` is emitted by the **sandbox middleware's own
file watcher** (`middleware.ts`, `watchWorkspace`/`dispatchDefinitionHooks`
path), not by the opencode adapter — it fires because a `workspace` object
is configured at all (see finding #5 below on why one fired 3 times).
`file.changed` does not appear anywhere in the opencode adapter's own
source, so if it exists it must be a different provider's or a different
harness adapter's event name, not opencode's.

Representative raw samples (first occurrence of each distinct `type`/
`name`, truncated to 300 chars, from
`.factory/runs/run-1789306198987/chunks.ndjson`):

```
RUN_STARTED => {"type":"RUN_STARTED","runId":"opencode-1789306200701-0uoy5a","threadId":"run-1789306198987","timestamp":1789306201928,"metadata":{"tanstack":{"model":"opencode-go/deepseek-v4.1-flash"}}}
CUSTOM:sandbox.file => {"type":"CUSTOM","timestamp":1789306201405,"name":"sandbox.file","value":{"type":"create","path":"/workspace/data/src/factory/.factory/factory-spike/.tanstack-projected-1e95f9272dfe038f","timestamp":1789306201404}}
CUSTOM:opencode.session-id => {"type":"CUSTOM","timestamp":1789306201929,"name":"opencode.session-id","value":{"sessionId":"ses_f650a18c3ffe4eIFBc2kmGIFEz"},...}
TEXT_MESSAGE_START / TEXT_MESSAGE_CONTENT / TEXT_MESSAGE_END => standard AG-UI text chunks, messageId + delta/content
TOOL_CALL_START / TOOL_CALL_ARGS / TOOL_CALL_END / TOOL_CALL_RESULT => e.g. toolCallName:"read", content:"<path>.../src/index.ts</path>..."
REASONING_START / REASONING_MESSAGE_START / REASONING_MESSAGE_CONTENT / REASONING_MESSAGE_END / REASONING_END => reasoning text deltas
RUN_FINISHED => {"type":"RUN_FINISHED","runId":"opencode-1789306200701-0uoy5a","threadId":"run-1789306198987","timestamp":1789306212260,"usage":{"promptTokens":137,"completionTokens":33,"totalTokens":170,"promptTokensDetails":{"cachedTokens":12160}},...}
```

Note the `sandbox.file` sample above: its `value.path` is
`/workspace/data/src/factory/.factory/factory-spike/.tanstack-projected-...`
— this is the file watcher reporting the creation of the stray artifact
described in finding #5. Its presence in the stream is itself evidence for
finding #5, not a separate thing.

#### 3. Mechanism for structured output from a harness adapter

**Answer (mechanism only, not exercised this run — no `outputSchema` was
passed since the issue-#1 prompt needed free-form file edits, not
structured output): the opencode text adapter simulates it. It injects the
JSON Schema into the prompt, and on the final assistant message parses the
text back into JSON itself, then emits a `structured-output.complete`
CUSTOM event with the parsed value.**

Evidence: `node_modules/@tanstack/ai-opencode/src/adapters/text.ts` —
reading the full adapter shows the `outputSchema` handling is not "the
agent writes a file" nor "the caller parses the final message manually";
it's built into `chatStream()` itself via a `parseJsonFromAssistantText`
helper applied to the harness's own final text, with the result delivered
as a `structured-output.complete` CUSTOM chunk on the same stream. This
means callers (0a-2, the PR-metadata step) should read that CUSTOM event
rather than re-implementing parsing.

#### 4. Is a `SandboxPolicy` needed on `localProcess`, and does `permissionMode:'acceptEdits'` work as documented?

**Answer: no policy is consulted by the opencode adapter at all; only
`permissionMode` matters, and `'acceptEdits'` worked exactly as documented
— the agent edited files without prompting or hanging.**

Evidence:
- `node_modules/@tanstack/ai-opencode/src/process/permissions.ts` (full
  read): `resolveInteractivePermission`/`resolvePermission` branch purely
  on the adapter's own `permissionMode` config
  (`'default'|'acceptEdits'|'bypassPermissions'`). There is no import of
  `SandboxPolicyCapability`/`defineSandboxPolicy` from `@tanstack/ai-sandbox`
  anywhere in this file or elsewhere in `ai-opencode/src/`. A
  `SandboxPolicy` attached via `withSandbox` would simply never be read by
  this adapter.
- Empirically: the run used `opencodeText(options.model, {permissionMode:
  "acceptEdits"})` with no policy configured at all. The NDJSON shows all 6
  tool calls resolving to `TOOL_CALL_RESULT` with no approval-request
  event type in between, `RUN_FINISHED` was reached, and `timedOut: false`
  — i.e. nothing hung waiting for a permission prompt, and edits landed
  (confirmed via `git diff`).

#### 5. Does `localProcess` bootstrap destroy anything in the tree given `setup: []`?

**Answer: not destroy, but not a clean no-op either — merely having a
`workspace` object (even `{source:{type:'none'}, setup:[]}`) causes the
sandbox middleware to write a stray marker-file artifact into the tree, due
to a path-double-resolution bug. `bun test` still passed 2/2 (nothing
load-bearing was destroyed), but this is a real, reproducible defect worth
flagging — see BLOCKERS/CONTRADICTIONS.**

Evidence / root cause (fully traced through installed source, not
speculation):

1. `node_modules/@tanstack/ai-sandbox/src/middleware.ts` (~line 889-908):
   because a `workspace` was configured, `provideWorkspaceProjection` is
   called with `root = resolveHarnessCwd(handle, '/workspace')` and
   `markerPath = \`${root}/.tanstack-projected-${workspaceHash}\``.
2. `node_modules/@tanstack/ai-sandbox/src/harness-cwd.ts`:
   `resolveHarnessCwd` for `handle.provider === 'local-process'` returns
   `mapVirtualWorkspacePath('/workspace', handle.id)`, which for the
   default virtual root just returns `handle.id` — the **real, physical**
   clone path (`/data/src/factory/.factory/factory-spike`), by design
   ("harness-facing APIs interpret cwd literally"). So `root` and
   `markerPath` end up being real absolute host paths, not virtual
   `/workspace/...` paths.
3. `node_modules/@tanstack/ai-opencode/src/adapters/projection.ts`
   (`projectOpencodeWorkspace`): unconditionally does
   `handle.fs.exists(projection.markerPath)` /
   `handle.fs.write(projection.markerPath, '')` — these are
   **provider-facing** fs calls, which expect virtual sandbox paths.
4. `node_modules/@tanstack/ai-sandbox-local-process/dist/esm/handle.js`
   `resolve(p)`: only special-cases `p === '/workspace'` or `p.startsWith
   ('/workspace/')`. Any other absolute path (including the already-real
   `markerPath` from step 2) falls into the generic `p.startsWith('/')`
   branch, which strips just the leading `/` and joins the rest under
   `this.root` — i.e. it re-roots an already-real path under itself.
5. Net effect, reproduced exactly:
   `markerPath = "/data/src/factory/.factory/factory-spike/.tanstack-projected-1e95f9272dfe038f"`
   gets resolved again as
   `path.resolve(root, "data/src/factory/.factory/factory-spike/.tanstack-projected-1e95f9272dfe038f")`
   = `/data/src/factory/.factory/factory-spike/data/src/factory/.factory/factory-spike/.tanstack-projected-1e95f9272dfe038f`
   — confirmed byte-for-byte via `find .../factory-spike/data -type f` after
   the run, and further confirmed by the `sandbox.file` CUSTOM event's own
   `value.path` (sample above), which shows the file watcher observing the
   creation of exactly this nested path (under its own `/workspace/...`
   virtualization, which has the analogous confusion).
6. This is specific to (or at least only triggered by) `local-process` with
   `dir` pointed at a path other than the literal string `/workspace`: the
   real root and the "virtual" root are the same string space, so a
   real-path value re-enters `resolve()` as if it were virtual and
   collides with itself. A container-based provider where the physical
   root differs from the virtual `/workspace` root would not hit this,
   because `resolveHarnessCwd` would return an actually-different string.

Practical consequence for phase 1: **any** use of `defineWorkspace(...)`
under `localProcessSandbox` (even an empty one) will leave a stray
`data/<repeated-absolute-path>/.tanstack-projected-<hash>` directory in the
tree, untracked but present (`git status --porcelain` showed `?? data/`).
It did not corrupt or delete anything real (verified: `bun test` passed,
`git diff` on `src/index.ts`/`src/index.test.ts` showed only the intended
changes), but a workflow that does `git add -A` before inspecting status
would accidentally stage it. For 0a-2, either avoid `defineWorkspace(...)`
entirely when using `localProcessSandbox({dir})` pointed at a real
checkout (matching finding #1's conclusion), or `rm -rf` the
`.tanstack-projected-*` and its parent `data/` before diffing/committing.

#### 6. Process cleanup on close (F4) — does an orphan opencode process survive?

**Answer: nothing durable was left running, but a transient `<defunct>`
(zombie) process was observed once, immediately after the step, before
clearing on its own within a few seconds. This is consistent with F4's
warning that closing the stream doesn't itself kill the process — here, the
run completed normally (`RUN_FINISHED` reached) rather than being aborted,
so it's evidence about normal-completion teardown timing, not about the
abort path.**

Evidence: `ps -eo pid,ppid,cmd` immediately after the step (inside
`runtime.ts`'s `opencodeProcessSnapshot()`) showed one line:
`2647505 2647468 [.opencode-wrapp] <defunct>`. Two independent follow-up
checks (`ps aux | grep -i opencode | grep -v grep`, run seconds apart, and
again just before writing this doc) both returned **empty** — the process
had already been reaped. No orphaned, still-running opencode process was
ever found. This run never exercised the abort/timeout path (`timedOut:
false`), so F4's specific claim about *aborted* runs leaving the process
running is not yet tested empirically — only normal completion was
observed, and normal completion's teardown was clean (a momentary zombie,
then gone).

#### 7. Stream shape (for 0b's future Effect Stream wrapping)

**Answer: `chat()` returns an `AsyncIterable` of AG-UI-shaped discriminated
union chunks (`ChatStream` in `node_modules/@tanstack/ai/dist/esm/activities/chat/index.d.ts`), consumed here with a plain `for await`. Every chunk
has a `type` field; `CUSTOM` chunks additionally have `name`/`value`; text
chunks have `messageId`+`delta`/`content`; tool chunks have `toolCallId`.**
See the representative samples under finding #2 above for exact shapes of
every distinct `type` observed. This is a plain async-iterable, no special
backpressure or ack protocol observed — each chunk was `JSON.stringify`-able
with no circular refs or non-serializable values, which matters for 0b's
plan to wrap it in an Effect `Stream` (a straightforward
`Stream.fromAsyncIterable` should work with no adapter needed for
serialization, only for cancellation semantics per finding #6/D14).

### Verification run (pre-commit)

See the final report for pasted output of `bun run typecheck`, `bun run
lint`, `bun run format`, and `bun test`.
