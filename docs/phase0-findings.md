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

## 0a-2

Scope: the full eight-step round trip from STATUS.md's "Phase 0 → 0a" plan —
clone, implement, `bun test`, fix (fresh session, same sandbox), `bun test`
again, PR metadata via structured output, deterministic write-back, opening
a real PR. Two runs happened during this work; only the second is the one
whose PR was kept (see "Which PR" below), but both exercised the same code
path and agree with each other everywhere they overlap.

### Correction made before re-running: the step-4 assertion was too weak

The version of `fullRoundTrip` inherited from the interrupted prior session
took **both** of its tree snapshots before `ctx.agentStep({ step: 'fix' })`
ever ran (`snapshotAfterImplement` right after implement, `snapshotBeforeFix`
immediately before the fix call). Comparing those two only proves the tree
survives a host-side `bun test` — it says nothing about whether the fix
step's own sandbox setup/re-bootstrap (the thing STATUS.md's step 4 is
actually about: "does `localProcess` re-bootstrap destroy anything between
steps") destroys anything, because that re-bootstrap hadn't happened yet at
either snapshot.

Fixed in `src/spike/lib/tree-snapshot.ts` by splitting this into two,
separately named and separately reported assertions:

- `assertHostSideStability` (weak) — unchanged in spirit, kept and
  explicitly labelled as spanning only the host-side `bun test` exec, not
  the sandbox boundary.
- `assertFixStepSurvived` (strong) — compares the post-implement snapshot
  against a snapshot taken **after the fix step completes**, so the
  comparison spans the fix step's own `chat()`/`withSandbox` call. It also
  takes a third snapshot, `seedFileSnapshot` (`git show origin/main:<path>`,
  no working-tree access), so "the file reverted to the pre-implement seed"
  (the actual failure mode of interest — bootstrap wiping/reverting work) is
  a distinct, detectable outcome from "the agent legitimately edited the
  file during the fix step". Per tracked path it classifies the outcome as
  one of `unchanged` / `edited` / `reverted-to-seed` / `vanished` /
  `truncated`, and independently checks that markers left by the implement
  step (`"function slugify"`, `"function greet"` in `src/index.ts`;
  `"slugify"`, `"greet"` in `src/index.test.ts` — taken from the actual 0a-1
  PR diff, not guessed) are still textually present, so an `edited` outcome
  that happened to remove the implement step's work would still fail the
  assertion rather than passing just because it wasn't a literal revert.
  `src/spike/workflow.ts` was restructured so the post-fix snapshot is taken
  immediately after `await ctx.agentStep({ step: 'fix', ... })` returns,
  before `bun test` runs again.

Also added: `runtime.ts` now writes
`.factory/runs/<runId>/summary.json` (machine-readable: timings, both
assertions' full reports, chunk-type counts, structured output, write-back
result, `ps` snapshots) and `.factory/runs/<runId>/stdout.log` (every line
the runtime printed, mirrored to a file as it's produced, not just
buffered in a terminal). The interrupted prior session's run
(`run-1789307176648`) has neither, which is exactly the gap this closes —
its stdout no longer exists anywhere.

### Run evidence

Two full round trips ran under the corrected assertion code:

1. `run-1789307176648` — completed before this task started (per the
   orchestrator's brief), before `summary.json`/`stdout.log` existed, so it
   has only its `chunks.ndjson` (102 chunks). Opened PR #2.
2. `run-1789308170212` — the re-run done for this task, with the
   strengthened assertion and the summary/log files. 135 chunks. Opened
   PR #3. **This is the run kept; #2 was closed as superseded** (see "Which
   PR" below).

Both used `opencode-go/deepseek-v4.1-flash`, target
`FreshlyBrewedCode/factory-spike` issue #1, and both ended green: `bun test`
2/2 after implement, 2/2 after fix, a real PR opened. Resolved package
versions (`node_modules/*/package.json`, matching `package.json` — no
dependency changes were needed for 0a-2): `@tanstack/ai@0.54.0`,
`@tanstack/ai-opencode@0.4.5`, `@tanstack/ai-sandbox@0.5.7`,
`@tanstack/ai-sandbox-local-process@0.2.5`.

### The strengthened step-4 result — verbatim, and which boundary it spans

From `run-1789308170212`'s `summary.json` (`fixStepSurvivalAssertion.report`,
identical text also printed live to `stdout.log` and the terminal):

```
FIX-STEP SURVIVAL (strong, spans the fix step's own sandbox re-bootstrap: post-implement snapshot vs. post-fix snapshot): PASS — step 2's contribution survived the fresh-session/sandbox-reuse boundary, no file reverted to the origin/main seed, no tracked file vanished or was truncated.
  src/index.ts: outcome=unchanged ok=true — byte-identical to the post-implement snapshot (350 bytes) — fix step made no edits to this file | markers present=["function slugify","function greet"] missing=[]
  src/index.test.ts: outcome=unchanged ok=true — byte-identical to the post-implement snapshot (309 bytes) — fix step made no edits to this file | markers present=["slugify","greet"] missing=[]
```

**This spans the fix step's own sandbox setup/re-bootstrap** — the
post-implement snapshot was taken before the fix step ran, the post-fix
snapshot after it completed. This is STATUS.md's step 4, actually tested.
For comparison, the weak assertion that the interrupted session had
originally shipped (both snapshots pre-date the fix step's sandbox
entirely) also passed, but proves much less:

```
HOST-SIDE STABILITY (weak, pre-fix-step only, does NOT span the sandbox re-bootstrap): PASS — tracked files byte-identical across the host-side bun test exec.
  src/index.ts: intact (350 bytes, byte-identical)
  src/index.test.ts: intact (309 bytes, byte-identical)
```

**Verdict: `localProcess`'s per-step re-bootstrap, with `lifecycle: {reuse:
'thread', destroyOnComplete: false}` and `workspace: {source: {type:
'none'}, setup: []}`, did not destroy or revert any tracked file across the
fix step's own sandbox boundary.** In this run the fix step made zero edits
(outcome `unchanged` for both files — the model reviewed the implementation,
found it correct, and said so; see the Fresh-session evidence section for
why this is itself informative). The assertion machinery is built to also
correctly report `edited` (legitimate change) vs `reverted-to-seed`
(bootstrap wiped the tree) as distinct outcomes; **only `unchanged` was
observed in the runs actually done — the `edited` and `reverted-to-seed`
paths exist in the code but were not exercised**, because the fix step
never needed to change anything (see "Untested" below).

### Structured output verdict: tier 1 confirmed at runtime (upgrade from 0a-1)

0a-1 could only confirm the `outputSchema` → `structured-output.complete`
mechanism by reading `@tanstack/ai-opencode`'s source — no run in 0a-1
passed `outputSchema` at all. 0a-2's pr-metadata step does, every time, and
it worked exactly as the source predicted, on both runs. From
`run-1789308170212`'s `summary.json`:

```json
"customEventNames": ["opencode.session-id","structured-output.start","structured-output.complete"],
"structuredOutput": {
  "title": "Add slugify(input: string): string with tests",
  "body": "Closes #1. Adds a `slugify` export that lowercases input, trims it, replaces runs of non-alphanumeric characters with a single hyphen, and strips leading/trailing hyphens.\n\n- Export `slugify(input: string): string` from `src/index.ts`\n- Add a test importing `slugify` and asserting \"Hello, World!\" becomes \"hello-world\"."
}
```

The PR actually opened (`https://github.com/FreshlyBrewedCode/factory-spike/pull/3`)
has exactly this title and body — `resolvePrMetadata` in `workflow.ts`
reported `mechanism: "structured-output-event"` (tier 1), never falling
back to tier 2 (manual JSON parse of `finalAssistantText`) or tier 3
(hardcoded). Same result on `run-1789307176648`. **Tier 1 is confirmed
working at runtime, not just from source — this is what 0a-1 left open.**

### Full distinct `chunk.type` / `chunk.name` inventory, by step (`run-1789308170212`)

From the raw NDJSON (`.factory/runs/run-1789308170212/chunks.ndjson`,
grouped by `(step, type, name)`):

| step | type | name | count |
|---|---|---|---|
| implement | RUN_STARTED | | 1 |
| implement | CUSTOM | sandbox.file | 3 |
| implement | CUSTOM | opencode.session-id | 1 |
| implement | TEXT_MESSAGE_START/CONTENT/END | | 3 each |
| implement | TOOL_CALL_START/ARGS/END/RESULT | | 6 each |
| implement | RUN_FINISHED | | 1 |
| fix | RUN_STARTED | | 1 |
| fix | CUSTOM | opencode.session-id | 1 |
| fix | TEXT_MESSAGE_START/CONTENT/END | | 4 each |
| fix | REASONING_START/MESSAGE_START/MESSAGE_CONTENT/MESSAGE_END/END | | 4 each |
| fix | TOOL_CALL_START/ARGS/END/RESULT | | 7 each |
| fix | RUN_FINISHED | | 1 |
| pr-metadata | RUN_STARTED | | 1 |
| pr-metadata | CUSTOM | opencode.session-id | 1 |
| pr-metadata | CUSTOM | structured-output.start | 1 |
| pr-metadata | CUSTOM | structured-output.complete | 1 |
| pr-metadata | TEXT_MESSAGE_START/CONTENT/END | | 2 each |
| pr-metadata | REASONING_START/MESSAGE_START/MESSAGE_CONTENT/MESSAGE_END/END | | 2 each |
| pr-metadata | TOOL_CALL_START/ARGS/END/RESULT | | 3 each |
| pr-metadata | RUN_FINISHED | | 1 |

Union of distinct `type`/`name` pairs across all three steps and both 0a-2
runs: `RUN_STARTED`, `RUN_FINISHED`, `TEXT_MESSAGE_START`,
`TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`, `REASONING_START`,
`REASONING_MESSAGE_START`, `REASONING_MESSAGE_CONTENT`,
`REASONING_MESSAGE_END`, `REASONING_END`, `TOOL_CALL_START`,
`TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT`,
`CUSTOM:sandbox.file`, `CUSTOM:opencode.session-id`,
`CUSTOM:structured-output.start`, `CUSTOM:structured-output.complete`. No
`RUN_ERROR` in either run. Still never observed anywhere in 0a-1 or 0a-2:
`CUSTOM:file.changed`, `CUSTOM:sandbox.file.diff`, `CUSTOM:opencode.todo` —
consistent with 0a-1's finding #2 (the opencode adapter's translate layer
simply never constructs those event names; `todo` needs a task complex
enough to trigger opencode's todo tool, which none of these prompts were).

`CUSTOM:sandbox.file` appeared **only during `implement`, in both 0a-2
runs, exactly 3 times each** (same count as 0a-1's single-step run) — never
during `fix` or `pr-metadata`. See "Sandbox reuse" below for what this
does and does not prove.

### Timings

`run-1789308170212` (`summary.json.timings`, all `Date.now()`-based, so
subject to this environment's clock, not wall-clock-calibrated against
anything external):

| stage | duration |
|---|---|
| clone reset (wipe + `git clone`) | 1,621 ms |
| implement step | 10,499 ms (39 chunks) |
| fix step | 27,123 ms (63 chunks) |
| pr-metadata step | 7,828 ms (33 chunks) |
| `fullRoundTrip` total (steps 2-7, includes both `bun test` runs + write-back) | 49,337 ms |
| **whole runtime process, clone reset through `summary.json` written** | **~50,985 ms** (computed from `runId` timestamp to `summary.json` mtime) |

The fix step is the longest despite making zero file edits — its transcript
shows two `read` tool calls up front (re-reading both tracked files from
scratch) plus several `bash` tool calls exploring edge cases and
`reasoningTokens: 927` (per `RUN_FINISHED.usage`), i.e. it spent its time
verifying correctness rather than editing, consistent with the
`FIX_REVIEW_PROMPT` path being the one exercised (see "Untested" below).

The gap between `implement`'s `RUN_FINISHED` chunk timestamp and `fix`'s
`RUN_STARTED` chunk timestamp was ~1.37s (`183704 - 182338`ms) — this
window contains the host-side `bun test`, both tree snapshots, the
assertion computation, and the fix step's `chat()`/`withSandbox.setup`
call. That ~1.37s is far shorter than the 1,621ms the initial `git clone`
took, which is at least consistent with the fix step's sandbox setup doing
much less work than a fresh clone would (e.g. no re-provisioning of a new
directory) — see the caveat in "Sandbox reuse" about why this is
suggestive, not conclusive.

### Sandbox reuse across steps — what the evidence does and does not show

**Directly observed:** `CUSTOM:sandbox.file` (the sandbox middleware's
workspace-projection file-watcher event, per 0a-1 finding #2) fired exactly
3 times, only during `implement`, in every run so far (0a-1's single step,
and both 0a-2 full three-step runs). It never fired again during `fix` or
`pr-metadata` in the same thread.

**What this is consistent with:** `lifecycle: { reuse: 'thread',
destroyOnComplete: false }` plus an identical sandbox definition
(`id: "factory-spike"`, same `localProcessSandbox({ dir })`, same
`defineWorkspace({ source: { type: 'none' }, setup: [] })`) and the same
`threadId` (the run's `runId`) on every `runAgentStep` call — per F2, this
is exactly the precondition for "same `sandboxInstanceKey` ⇒ same sandbox"
by the framework's own documented contract. The fast (~1.37s) gap between
steps and the absence of any repeated bootstrap-marker creation both point
the same direction: the sandbox is not being torn down and fully
re-provisioned between steps.

**Why this is not conclusive proof of handle-level reuse, stated
honestly:** per 0a-1 finding #5, the workspace-projection marker file
(`.tanstack-projected-<hash>`) that triggers the `sandbox.file` event is
written to a **real path on the host clone** and only after checking
`handle.fs.exists(projection.markerPath)`. Once that marker file exists on
disk (which it does, nested under the stray `data/...` path, from the
moment `implement` finishes, until write-back's `cleanStrayArtifacts`
deletes it), a **brand-new** sandbox handle pointed at the same directory
would *also* see the marker already present and skip recreating it — the
check is disk-state-based, not sandbox-instance-identity-based. So
"`sandbox.file` fires once" is equally consistent with true object-level
reuse and with "a fresh handle each time, whose bootstrap is idempotent
against the already-marked directory". Nothing in the observable chunk
stream carries a sandbox/handle identity value (checked: `RUN_STARTED` /
`RUN_FINISHED` metadata only carries `{ model, finishReason }`, no sandbox
id), and F1 (no host-exec API into the sandbox) means Factory cannot ask
the sandbox what it is. **Conclusion: sandbox reuse across steps is
consistent with all available evidence and guaranteed by the framework's
documented contract (F2), but is not independently, empirically provable
with the instrumentation this spike has. This is a real gap, not
speculation dressed as one — worth a dedicated probe in phase 1 (e.g. a
`setup` script that writes a random nonce file at bootstrap time; if the
nonce is byte-identical across all three steps, that would be genuine,
disk-state-independent evidence of instance reuse; if it differs, the
sandbox was recreated).**

### Fresh session, no transcript history (D10) — behavioural evidence, not just distinct IDs

Distinct `opencode.session-id` values per step were confirmed again (this
run: `ses_f64ec04a...` implement, `ses_f64ebdb7...` fix, `ses_f64eb71a...`
pr-metadata — all distinct, as in 0a-1). Beyond IDs, direct behavioural
evidence that no memory carried over:

- **Every step's first "assistant"-labelled `TEXT_MESSAGE`, in both 0a-2
  runs and in the original 0a-1 run, is a byte-for-byte echo of that step's
  own prompt text, not a summary or reference to it.** E.g. the fix step's
  first `TEXT_MESSAGE_START`/`_CONTENT`/`_END` triplet (`messageId
  prt_09b142630001S1tx6ep4E7BMG6`, `role: "assistant"` per the `START`
  chunk) carries exactly `FIX_REVIEW_PROMPT`'s text, verbatim, as its
  `delta`. This means the transcript opencode received/echoed for that
  step's session contains *only that step's own prompt* — no trace of the
  implement step's prompt or response is present anywhere in the fix
  step's chunk stream. This is new to 0a-2 (0a-1's `finalAssistantText` bug
  meant nobody had looked at message content before). **This is worth
  flagging for phase 1: every step's message-count/content bookkeeping
  needs to account for one "assistant"-role message per step actually
  being the harness's own prompt echo, not a real model turn** — a naive
  consumer counting `TEXT_MESSAGE_*` chunks to infer "how many things did
  the model say" will overcount by exactly one per step.
- **The fix step re-read both tracked files from scratch** (`TOOL_CALL_START`
  with `toolCallName: "read"` fired twice at the very start of the fix
  step, before anything else) rather than acting as if it already knew
  their contents — consistent with a genuinely blank context, not merely a
  new ID pointing at retained state.
- **The fix step's own final answer is a from-scratch re-derivation**, not
  a reference to prior work: `finalAssistantText` is "No changes needed.
  `src/index.ts:7` is correct for its contract. Verified against every
  listed case: [table of edge cases]" — it re-verified the five specific
  edge cases the `FIX_REVIEW_PROMPT` asked about, rather than saying
  anything like "as I implemented earlier" or "unchanged from before".
- **The pr-metadata step likewise re-read the files** (`"Read
  src/index.ts and src/index.test.ts..."` is literally the instruction in
  `PR_METADATA_PROMPT`, and its `TOOL_CALL_START` entries show it doing so)
  rather than assuming it already knew the diff from a prior turn.

**Verdict: D10 holds up under behavioural scrutiny, not just ID
distinctness.**

### Orphaned processes (F4)

`opencodeProcessSnapshot()` (via `ps -eo pid,ppid,cmd`, filtered for
`/opencode/i`) was empty at all three points sampled inside
`run-1789308170212`: before any agent step, after all three agent steps,
and after the full write-back. Independently, `ps aux | grep -i opencode`
run by the orchestrator after the whole task, and again by this session,
found **nothing** — no `bun run src/spike/runtime.ts` process and no
`opencode` process of any kind survives the run. This is a cleaner result
than 0a-1 (which caught one transient `<defunct>` zombie in its
after-step snapshot, gone by the next check) — here, none of the sampled
points caught even a transient zombie, though the sampling points don't
cover the moments *during* a step, only between/after them, so this run
says nothing new about the abort/cancel path (still 0b's job per F4/D-open
questions) — every step in both 0a-2 runs reached `RUN_FINISHED`
normally, `timedOut: false` throughout.

### `finalAssistantText`: delta accumulation, confirmed correct against the NDJSON

0a-1's bug (reading a nonexistent `content` field instead of `delta` on
`TEXT_MESSAGE_CONTENT`, always yielding `""`) is fixed in
`src/spike/lib/agent-step.ts` by buffering `delta` between
`TEXT_MESSAGE_START` and `TEXT_MESSAGE_END` per message, keeping only the
**last completed** message's buffer. Checked directly against the raw
NDJSON for `run-1789308170212`:

- Every `TEXT_MESSAGE_CONTENT` chunk in both runs carries the text on
  `delta` (confirmed: `grep`/`json.loads` over every line found `content`
  absent and `delta` present on every occurrence) — the fix was necessary
  and sufficient for this corpus.
- Every message in this corpus was carried in exactly **one**
  `TEXT_MESSAGE_CONTENT` chunk (`Counter` over `(step, messageId)` pairs =
  1 for all 9 messages across the 3 steps) — i.e. this corpus never
  actually exercises multi-chunk delta concatenation for a single message.
  The buffering logic (`currentMessageBuffer = (currentMessageBuffer ??
  "") + delta`) is written to handle that case correctly, but it remains
  **unverified against a real multi-chunk message** — only inspected by
  reading the code, the same caveat 0a-1 had for structured output before
  0a-2 exercised it.
- The "keep only the last completed message" logic is confirmed correct
  end-to-end for the case that matters most: the pr-metadata step's
  `finalAssistantText` is exactly the same JSON text that
  `structured-output.complete`'s `raw` field carries (both equal the
  literal `{"title":"Add slugify...","body":"Closes #1. ..."}` string), and
  that message is the step's **second** (last) `TEXT_MESSAGE`, not its
  first (which, per the section above, is the prompt echo). Had "last
  completed" been implemented as "first" or "accumulate across messages",
  `finalAssistantText` would have been either the prompt text or a
  concatenation of prompt + JSON, and the tier-2 manual-JSON-parse fallback
  in `resolvePrMetadata` would have failed to parse it — it didn't need to
  fire (tier 1 fired both times), but this cross-check confirms the tier-2
  fallback path is wired correctly, not just untested.

### Which PR was kept

`run-1789307176648` (pre-existing at task start) opened PR #2. The re-run
for this task, `run-1789308170212`, opened PR #3
(https://github.com/FreshlyBrewedCode/factory-spike/pull/3) — same
issue, same two files (`src/index.ts`, `src/index.test.ts`), verified via
`gh pr diff 3` to contain nothing else (no stray `data/` or
`.tanstack-projected-*` artifact — `writeBack.cleanedArtifacts: ["data/"]`
shows the 0a-1-finding-#5 artifact was reproduced yet again on this
package version, and removed before staging, same as every prior run).
PR #3 was kept (it ran under the strengthened assertion); PR #2 was closed
with a comment noting it was a superseded spike run, and its remote branch
(`factory/issue-1-run-1789307176648`) no longer exists on the remote.
Exactly one PR (#3) is open on `factory-spike` as of this writing.

### Still untested (0a-2)

- **The `FIX_REPAIR_PROMPT_PREFIX` path.** Both 0a-2 runs had
  `testAfterImplement.exitCode === 0`, so `fullRoundTrip` always took the
  `FIX_REVIEW_PROMPT` branch. The actual "tests failed, fix them" prompt
  path, and — more importantly — the `reverted-to-seed` / `edited` /
  `vanished` / `truncated` outcomes in `assertFixStepSurvived` other than
  `unchanged`, have never fired against a real run. The classification
  logic is exercised by inspection only for those branches.
- **True sandbox-instance-level reuse**, independent of the marker-file's
  disk-state idempotency — see "Sandbox reuse" above for the proposed
  nonce-file probe.
- **Multi-chunk `delta` concatenation** for a single `TEXT_MESSAGE` — never
  observed in either run's corpus so far.
- **The abort/cancel path and true orphan-process behaviour under abort**
  (F4's specific claim). Still 0b's job; every step in every run so far
  reached `RUN_FINISHED` normally.
- **Concurrent runs sharing one `sandboxInstanceKey`** — F2 already flags
  this as undefined behaviour; 0a-2 only ever ran one thread at a time.

### Verification run (pre-commit)

See the final report for pasted output of `bun run typecheck`, `bun run
lint`, `bun run format`, and `bun test`.

## 0b

Scope: the Effect v4 ↔ TanStack AI boundary. Does fiber interruption
actually kill the opencode process, and what does it take to make that
happen? Not the full round trip, not the server/dispatch layer (D4) — one
agent step, wrapped as an Effect `Stream`, interrupted mid-flight, with `ps`
evidence before/after (the task's explicit instruction: "trust `ps`, not the
types").

### What was built

Two new files under `src/spike/`, alongside (not replacing) the plain-async
0a code, per D13's seam — this is runtime/lib-layer code, not something a
workflow author would write:

- **`src/spike/lib/effect-agent-step.ts`** — `agentStepEffect(options)`: the
  same `chat()` + `withSandbox(localProcessSandbox)` + `opencodeText` +
  `AbortController` plumbing as `lib/agent-step.ts`, but returns
  `{ effect: Effect.Effect<EffectAgentStepResult, AgentStepChunkError>,
  abortController }` instead of a `Promise`. The chunk stream is
  `Stream.fromAsyncIterable(iterable, onError)`, bookkeeping (chunk counts,
  custom-event names, `finalAssistantText`, structured output, `runError`)
  is done via `Stream.mapEffect`, and the whole thing is drained with
  `Stream.runDrain`. Every chunk is still appended to the NDJSON sink first,
  unconditionally (D14).
- **`src/spike/effect-boundary-experiment.ts`** — the harness. For each of 4
  runs (2× `interruptBehavior: "abort"`, 2× `"none"`): reset the clone,
  start the effect via `Effect.runFork`, wait for `onChunk` to report at
  least 3 chunks (not just fiber start), grace-wait 1.5s, snapshot `ps`,
  call `Effect.runPromise(Fiber.interrupt(fiber))` and time it, snapshot
  `ps` again immediately, then poll `ps` every 1s for up to 30s watching for
  the pre-interrupt PIDs to vanish, then inspect the fiber's raw `Exit` via
  `Effect.runPromise(Fiber.await(fiber))`, then `git status --porcelain` the
  clone. Entry point: `bun run src/spike/effect-boundary-experiment.ts`.
  The driving prompt asks the agent to run a 200-second bash `for`/`sleep`
  loop via its own bash tool, so there's a wide, deterministic window to
  interrupt into mid-tool-call, well before natural completion.

### The interruption-to-abort wiring (the part phase 1 inherits)

```ts
// src/spike/lib/effect-agent-step.ts (abridged to the load-bearing part)
const rawStream = Stream.fromAsyncIterable(
  iterable, // chat()'s returned AsyncIterable<unknown>
  (cause) => new AgentStepChunkError({ cause }),
);

const processed = Stream.mapEffect(rawStream, (chunk) =>
  Effect.promise(async () => {
    /* bookkeeping + NDJSON append, mirrors lib/agent-step.ts */
  }),
);

const drain = Stream.runDrain(processed);

const guarded =
  options.interruptBehavior === "abort"
    ? Effect.onInterrupt(drain, () =>
        Effect.sync(() => {
          options.onInterruptFinalizer?.();
          abortController.abort();
        }),
      )
    : drain;
```

`Effect.onInterrupt(effect, finalizer)` is the correct primitive: per its own
doc comment in `node_modules/effect/dist/Effect.d.ts` ("Runs the specified
finalizer effect if this effect is interrupted"), the finalizer fires only
on interruption, not on every exit. Two alternatives were checked and
rejected: `Effect.ensuring`/`Stream.ensuring` fire on **every** exit
(success, failure, *and* interrupt — doc comment confirms this, so it can't
isolate "was this actually cancelled"), and there is no `Stream.onInterrupt`
or `Stream.acquireRelease` in this v4 RC (`Stream.d.ts` has neither — only
`Stream.ensuring`, `Stream.unwrap`, `Stream.scoped`). The finalizer is
attached to the **effect returned by `Stream.runDrain`**, not to the
`Stream` value itself — Effect's stream combinators don't expose an
interrupt-specific hook, so the wiring has to happen one level up, at the
point where the stream becomes a run-able `Effect`.

### Effect v4 API notes for phase 1

- `Stream.fromAsyncIterable(iterable, onError)` exists as documented, but
  it is not a bare wrapper — read `Channel.fromAsyncIterable` in
  `node_modules/effect/dist/Channel.js` (~line 1422): it registers its own
  scope finalizer that calls the source iterator's `.return()` on early
  scope closure (e.g. fiber interruption), **independent of anything this
  file adds**. `chat()`'s returned `AsyncIterable` is an async generator
  (`node_modules/@tanstack/ai-opencode/src/adapters/text.ts`'s `async
  *chatStream`), so `.return()` on it injects a return completion at its
  current `yield` point and runs the generator's own `finally` block. This
  is a real, load-bearing behavior of `Stream.fromAsyncIterable` that isn't
  obvious from the public docs, and it turned out to matter — see A3 below.
- No `Stream.onInterrupt`, no `Stream.acquireRelease` in this RC. Confirmed
  by reading `Stream.d.ts` in full, not just grepping for the expected name.
- `Fiber.interrupt(fiber): Effect<void>` — per its doc comment, "the
  returned Effect completes only after the interrupted fiber has completed"
  (including running its finalizers). This does **not** mean the real-world
  side effect the finalizer triggered (here, the opencode process exiting)
  has also completed by the time the promise resolves — see A6.
- `Fiber.await` is exported under that name but implemented internally as
  `await_` (`Fiber.d.ts` line ~174, aliased `await_ as await` at the bottom
  of the file) — a naive `grep "declare const await:"` misses it.
- `Data.TaggedError` exists and works as expected, but the current-generation
  guidance (surfaced by `oxlint`'s `effecttsgo(prefer-schema-over-json)`-
  adjacent rules and the v4 docs) points at `Schema.TaggedError<T>()(tag,
  fields)` instead; used that here (`AgentStepChunkError`) with
  `Schema.Defect()` for the wrapped `cause: unknown` field — both exist and
  are exported from the top-level `effect` package (`index.d.ts` confirms
  `Schema`, `Data`, `Effect`, `Stream`, `Fiber`, `Exit`, `Cause` are all
  re-exported as namespaces).
- `oxlint`'s `effecttsgo` rule set flags essentially every plain
  `async function`, `Date.now()`, `setTimeout`, `console.log`, and
  `node:fs`/`node:path` import in both new files as "consider the Effect
  API instead" — all warnings, zero errors, same as every other file in
  `src/spike/`. This spike/harness code intentionally stays host-side plain
  async (matching D13's "workflow/runtime stays plain async, Effect owns
  the actual runtime layer once it exists" framing) — the warnings are
  expected noise, not something this task fixed.

### Run evidence

One full harness run completed cleanly end-to-end:
`harnessRunId=harness-1789309619614`,
`.factory/runs/harness-1789309619614/{stdout.log,results.json}`, model
`opencode-go/deepseek-v4.1-flash`, target clone
`.factory/factory-spike` (reset fresh before each of the 4 experiments). A
first attempt (`harness-1789309541316`) was killed mid-run by an
unrelated environment interruption after 2 of 4 experiments (no
`results.json` was written for it) — its partial log is consistent with the
successful run below wherever they overlap (same `finalizerRan=true`,
`abortController.aborted=true`, same defunct→gone pattern) but is not cited
as primary evidence; only the completed run is.

### A1 — does the finalizer actually run?

**Yes, every time `interruptBehavior: "abort"` was configured (2/2 runs);
never when it wasn't (0/2 runs, as designed — the control condition
registers no interrupt-specific finalizer at all).** Proof is a boolean
flip inside the finalizer closure itself (`onInterruptFinalizer`), not
inference from `ps`:

```
abort#1: finalizerRan=true  abortController.aborted=true
abort#2: finalizerRan=true  abortController.aborted=true
control#3: finalizerRan=false  abortController.aborted=false
control#4: finalizerRan=false  abortController.aborted=false
```

(from `.factory/runs/harness-1789309619614/results.json`, fields
`finalizerRan`/`abortControllerAbortedAfterInterrupt`).

### A2 — is the opencode process actually gone after interruption?

**Yes, in all 4 runs.** Verbatim `ps -eo pid,ppid,cmd` evidence (filtered
for `/opencode/i`, excluding `grep`, exactly as `runtime.ts`'s
`opencodeProcessSnapshot()` does) for the two `abort` runs:

```
[exp:abort#1] ps BEFORE interrupt (chunks=5, pids=["7528"]):
   7528    7490 opencode serve --hostname=0.0.0.0 --port=4096
[exp:abort#1] Fiber.interrupt awaited in 1490ms. finalizerRan=true abortController.aborted=true
[exp:abort#1] ps IMMEDIATELY AFTER awaited interrupt (pids=["7528"]):
   7528    7490 [.opencode-wrapp] <defunct>
[exp:abort#1] settle poll @2508ms: pidsRemaining=[]

[exp:abort#2] ps BEFORE interrupt (chunks=5, pids=["7627"]):
   7627    7490 opencode serve --hostname=0.0.0.0 --port=4096
[exp:abort#2] Fiber.interrupt awaited in 903ms. finalizerRan=true abortController.aborted=true
[exp:abort#2] ps IMMEDIATELY AFTER awaited interrupt (pids=["7627"]):
   7627    7490 [.opencode-wrapp] <defunct>
[exp:abort#2] settle poll @1924ms: pidsRemaining=[]
```

PID 7528/7627 (the `opencode serve` process, parented directly by the
harness's own `bun run` process, PID 7490 — no intermediate shell) is
present and running immediately before interrupt, is a `<defunct>` zombie
immediately after `Fiber.interrupt`'s promise resolves, and is **fully gone**
(not even a zombie entry) by the first settle poll ~1-1.6s later. No
`forceKilledPids` were needed in either run (`results.json`:
`"forceKilledPids": []`). The `<defunct>`→gone transition happening on its
own (no explicit `wait()`/reap call anywhere in this codebase) means Bun's
own child-process management reaps it, not this harness.

### A3 — control experiment (interrupt without wiring `abort()`)

**Surprising result: the process died anyway, on a timeline indistinguishable
from the `abort`-wired runs. F4's prediction ("closing the IO stream does
not terminate the agent process") did NOT hold for this specific pathway.**
This is the single most important finding of 0b — flagged in
BLOCKERS/CONTRADICTIONS below, not buried here.

```
[exp:control#3] ps BEFORE interrupt (chunks=5, pids=["7716"]):
   7716    7490 opencode serve --hostname=0.0.0.0 --port=4096
[exp:control#3] Fiber.interrupt awaited in 1774ms. finalizerRan=false abortController.aborted=false
[exp:control#3] ps IMMEDIATELY AFTER awaited interrupt (pids=["7716"]):
   7716    7490 [.opencode-wrapp] <defunct>
[exp:control#3] settle poll @2790ms: pidsRemaining=[]

[exp:control#4] ps BEFORE interrupt (chunks=5, pids=["7859"]):
   7859    7490 opencode serve --hostname=0.0.0.0 --port=4096
[exp:control#4] Fiber.interrupt awaited in 1725ms. finalizerRan=false abortController.aborted=false
[exp:control#4] ps IMMEDIATELY AFTER awaited interrupt (pids=["7859"]):
   7859    7490 [.opencode-wrapp] <defunct>
[exp:control#4] settle poll @2741ms: pidsRemaining=[]
```

`finalizerRan=false` and `abortControllerAbortedAfterInterrupt=false`
confirm no explicit `abort()` was ever dispatched in these two runs — this
module registered no interrupt-specific finalizer at all for
`interruptBehavior: "none"`. Yet the process reached the identical
`<defunct>`→gone end state, on a comparable timeline (settle at 2790ms/
2741ms vs. 2508ms/1924ms for the abort-wired runs — well within the same
order of magnitude, not "eventually, much later").

**Reconciling this with F4 and the Effect v4 API note above**: F4 was
established in 0a using a plain `for await` loop that, on early exit
(`break`/`return`/exception), does **not** reliably call `.return()` on the
underlying async iterator — that's an ordinary JS gotcha with manual
`for await`, and 0a never exercised abandoning the loop early at all (every
0a run reached `RUN_FINISHED` normally). `Stream.fromAsyncIterable`,
however, is not a plain `for await` — per the Channel.js finding above, it
**always** registers a scope finalizer that calls `.return()` on the
iterator when its scope closes, and fiber interruption closes that scope.
So `Fiber.interrupt` alone, with **zero** explicit wiring from this file,
still reaches `chat()`'s async generator's `.return()`, which reaches the
generator's own `try/finally` (`server.dispose()` → `proc.kill()`, per
`adapters/text.ts`), which kills the process — the same destination F4 said
only explicit `abort()` could reach, just via a different route this file
didn't build. **This is a refinement of F4 scoped to "consumption via
`Stream.fromAsyncIterable`", not a wholesale contradiction of F4's original
claim about the raw `for await` case** (which was never re-tested here and
is still presumed true).

**Caveat, stated plainly**: this experiment's agent was always caught
mid-way through a long bash-tool-call, i.e. the generator was very likely
suspended at a clean internal `await`/`yield` point (waiting on the next
item from its internal event queue) when `.return()` landed. Whether
`.return()` alone is equally effective if the generator is suspended
somewhere `.return()` can't cleanly unstick — e.g. mid-way through an
in-flight `fetch()` with no cancellation wiring of its own — was **not**
tested. The explicit `abort()` wiring may still be the only reliable path
in that case; A3 only shows it isn't *always* necessary, not that it's
never necessary. Given this uncertainty, phase 1 should **keep** the
explicit `Effect.onInterrupt` → `abort()` wiring (it is strictly redundant
here, never harmful, and cheap) rather than relying on
`Stream.fromAsyncIterable`'s implicit `.return()` alone.

### A4 — fiber exit shape

**Clean `Interrupt`, in all 4 runs — never a defect, never a hang.** Every
run's `Effect.runPromise(Fiber.await(fiber))` (called after the process was
confirmed settled) returned `Exit.isFailure(exit) &&
Exit.hasInterrupts(exit) === true`, with `Cause.pretty(exit.cause)`:

```
InterruptError: All fibers interrupted without error {
  [cause]: InterruptCause: The fiber was interrupted by:
      at fiber (#2)
}
```

(fiber numbers #2/#5/#8/#11 differ per run — each experiment forks a fresh
fiber tree). This directly answers "does the `for await` loop throw,
surfacing as an Effect defect?" — **no**: `Channel.fromAsyncIterable`'s
`Effect.tryPromise({ try: () => iter.next(), catch: onError })` wraps the
iterator's `.next()`, but interruption itself is delivered as a genuine
Effect interrupt signal (via the scope closing, per the Channel.js finding
above), not as a thrown JS exception racing the `.next()` call. No run in
this session produced a `Die`/defect exit or an unresolved `Fiber.await`
call.

### A5 — sandbox/tree state after interrupt

**No corruption or half-written files beyond the pre-existing, already
root-caused `data/…/.tanstack-projected-<hash>` stray artifact from 0a-1
finding #5 — same bug, not something interruption newly caused.** Every
run's `git status --porcelain` after interrupt showed exactly `?? data/`
(from `results.json`, field `gitStatusAfter`, identical across all 4 runs).
Inspecting the actual clone directory after the harness finished:

```
$ find .factory/factory-spike/data -type f
.factory/factory-spike/data/src/factory/.factory/factory-spike/.tanstack-projected-1e95f9272dfe038f
```

— byte-for-byte the same nested-path shape 0a-1 finding #5 root-caused
(the `handle.js` `resolve()` double-resolution bug), reproduced here again
because `defineWorkspace(...)` was configured the same way. No tracked file
(`src/`, `package.json`, etc.) was touched, truncated, or reverted in any
of the 4 runs; no partial/half-written non-artifact files were found.
**Interruption specifically does not appear to leave anything worse behind
than a normal completed run already does** — the known artifact bug is
orthogonal to cancellation.

### A6 — timing: interrupt call to process actually gone

**Not synchronous, and the awaited `Fiber.interrupt` promise resolving is
not sufficient on its own to conclude the process is gone — it only
guarantees the *finalizer effect* (including the `abort()` call, when
wired) has run to completion.** Concretely, from `results.json`:

| run | `interruptAwaitedMs` (time for `Effect.runPromise(Fiber.interrupt(fiber))` to resolve) | state at that moment | `disappearedAtMsSinceInterruptStart` (first settle poll with 0 remaining PIDs) |
|---|---|---|---|
| abort#1 | 1490ms | `<defunct>` (zombie, not yet reaped) | 2508ms |
| abort#2 | 903ms | `<defunct>` | 1924ms |
| control#3 | 1774ms | `<defunct>` | 2790ms |
| control#4 | 1725ms | `<defunct>` | 2741ms |

In every run, the process had already **exited** (visible as `<defunct>`)
by the moment `Fiber.interrupt`'s promise resolved — but it takes roughly
another ~0.2-1s (bounded above by the 1000ms settle-poll granularity used
here, so the true gap could be smaller) after that for the zombie entry to
be reaped and disappear from `ps` entirely. So: **`Fiber.interrupt`'s await
is a reliable signal that the kill was *initiated* and the underlying
process has *exited* (already `<defunct>` by the time it resolves), but a
caller that needs "confirmed fully gone from the process table" (e.g.
before reusing a port or directory) should poll briefly afterward rather
than trusting the awaited promise alone.** The `interruptAwaitedMs` values
themselves (903-1774ms) also show interruption is not instantaneous even at
the Effect level — cooperative interruption + the generator's own
`finally`-block teardown (`session.abort()`'s best-effort HTTP call,
`server.dispose()`) takes on the order of one second, consistent across
both `abort` and `control` conditions.

### Still untested (0b)

- **Whether the explicit `abort()` wiring is ever load-bearing** — A3 shows
  it wasn't necessary in this exact scenario (generator suspended at a
  clean internal yield point mid-tool-call), but a generator stuck inside
  something `.return()` can't cleanly interrupt (e.g. an in-flight HTTP
  call with no cancellation token of its own) was never constructed. The
  wiring is kept for phase 1 regardless, as cheap insurance.
- **Interruption very early**, before the chunk-flow threshold (i.e.
  interrupting before the opencode server process has even fully started)
  — every run here waited for ≥3 chunks plus a 1.5s grace period first.
- **Interruption of a step that has already reached `RUN_FINISHED`** (i.e.
  racing interrupt against natural completion) — not attempted; every
  interrupt in this session landed while the agent was still mid-tool-call.
- **Concurrent/overlapping fibers on the same or different sandboxes being
  interrupted independently** — every run here was strictly sequential
  (one experiment fully settles, including its own clone reset, before the
  next starts).
- **The exact sub-second gap** between the underlying OS process actually
  exiting and `Fiber.interrupt`'s promise resolving, and between exit and
  zombie-reap — only bounded (≤1490-1774ms for the former, ≤~1s for the
  latter, per the 1000ms settle-poll granularity used here), not measured
  precisely; a tighter poll interval or an OS-level exit-event hook would
  narrow this for phase 1 if it matters there.
- One harness run (`harness-1789309541316`) was killed mid-execution by an
  unrelated environment interruption after producing 2 of 4 experiments'
  worth of (consistent, corroborating, but not separately relied-upon)
  evidence — its `stdout.log` survives at
  `.factory/runs/harness-1789309541316/stdout.log` for reference but no
  `results.json` was written for it.

### Verification run (pre-commit)

See the final report for pasted output of `bun run typecheck`, `bun run
lint`, `bun run format`, and `bun test`.
