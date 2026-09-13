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

### Still untested

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
