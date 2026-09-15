# 0005. Phase 5's usable POC — D27 (`factory.config.ts` as the entry point), D28 (per-run working trees), D29 (one admission function), D30–D31 (workflow registry & the start API), D32 (agent-supplied write-back metadata), D33 (the start form)

## Status

Proposed, 2026-09-15. Pre-implementation, the same posture ADR 0002 took: every decision here is
falsifiable by phase 5's own exit criterion, and nothing below has run yet. Supersedes nothing;
widens D5 (workflow registration), D11 (agent-supplied PR metadata) and D24 (the WIP limit), and
fires the "concurrency isolation" deferral that STATUS.md had parked on phase 5 with a trigger.

## Context

Phase 4 put the SPA on screen against real data. What it does not do is let anyone *start*
anything: `POST /api/runs` demands `workflowPath` and `dir` as filesystem strings
(`src/server/http.ts:141`), which a browser cannot supply, and D5's registration surface was
never built. The only way to start a run today is `factory run` on the CLI or the dispatcher
picking up a GitHub Project item unattended.

The goal this ADR serves is deliberately narrower than phase 4's original plan: a POC that is
*useful*, meaning a person can open the UI, start a run against a chosen workflow, watch it
stream, and cancel it — and can do the same from a script. Automatic dispatch is explicitly out
of scope for the UI; it keeps working from `--dispatch-*` flags, so nothing built in phase 3 is
discarded or paused.

One requirement arrived with the scope and changed the shape of the phase: **more than one run
at a time is required, not deferred.** STATUS.md had parked concurrency isolation on "phase 5, or
whenever D24's WIP limit of 1 is lifted", anticipating N sandboxes with one worktree each. Tracing
it showed that anticipation was pessimistic — see D28.

Not re-litigated here: D3/D20 (the event type), D7 (`localProcessSandbox`; concurrency here is
several local processes, not a move to docker), D10 (one `threadId` per run ⇒ one sandbox — this
is what makes D28 cheap), D12 (crash recovery deprioritized), D22 (plain `Bun.serve`), D26 (SSE
per run, polling for the list).

## Decision

### D27 — `factory.config.ts` is the project's entry point, and workflows are registered in it

A TypeScript config module, imported by `factory serve`, carrying the run environment and the
workflow list:

```ts
export default defineConfig({
  repo: { sshUrl, identity: { name, email }, baseBranch, slug },
  workflows: [implementIssue],
  workspaceRoot: ".factory/workspaces",
  maxConcurrentRuns: 3,
});
```

Two things fall out of this that were previously awkward.

**D5's hardest constraint disappears.** D5 says workflow modules export "`id` + input schema +
the function — a registration surface, not a step graph", with the stated reason that "the daemon
must enumerate and validate workflows without executing arbitrary files." That constraint only
existed because the daemon was going to *scan a directory*. Importing a config module is the
operator's own explicit act, so there is nothing to defend against: the config imports workflow
definitions from their own files and lists them, and the registry is that array. Workflow modules
keep the `defineWorkflow` shape they already have; what changes is who enumerates them.

**The run environment stops being per-request.** `repoSlug` and `baseBranch` are properties of the
deployment, not of a task — the runtime already owns the tree (D8), so it already knows both.
They move out of workflow input and out of the `ctx.writeBack` call signature (D32).

Flags were the alternative, following `--dispatch-*`'s precedent. Rejected: repo, identity,
workspace root, workflow list and concurrency limit is too much surface for flags, and the
workflow list is not expressible as one at all.

**Single project per daemon**, per the POC's scope. Multi-repo is a real future phase; the config
shape should not actively prevent it (a singular `repo` key can become plural), but nothing in
phase 5 pays for it.

### D28 — One working tree per run, cloned from a local mirror cache

Each run gets `<workspaceRoot>/<runId>/`. Workspaces are retained after a run terminates —
the last N, evicted oldest-first — because the moment a tree is worth inspecting is exactly the
moment a run failed.

**Why this is the whole of concurrency.** Tracing what a second concurrent run would actually
collide with found one thing, not the several the deferral anticipated:

| Resource | Already per-run? | Where |
| --- | --- | --- |
| Sandbox / agent session | yes | `startRun` passes `threadId: options.runId` (`run.ts:159`), and D10 makes that one sandbox per run |
| Exec working directory | yes | `hostExec(argv, { cwd: options.dir })` (`run.ts:119`) |
| Run registry | yes | `active` is a `Map<string, RunHandle>` (`runs.ts:16`) |
| SSE fan-out | yes | `publish`/`subscribe` keyed by `runId` |
| sqlite | yes | WAL, one connection, synchronous appends serialized by the event loop (`store.ts:25`) |
| **Working directory** | **no** | `resetClone` wipes and re-clones a single `dir` (`clone.ts:27`) |

So the isolation work is a directory allocation, not N sandboxes with one worktree each. The
Deferred entry's framing was written before D10's per-`threadId` sandbox was validated, and is
superseded by this.

**Mirror cache, not a fresh network clone per run.** One bare mirror per repo, refreshed before
use, with each run's tree cloned locally from it. With several concurrent runs and a manual start
button, the latency of repeated full clones of the same repo is paid on every click and is the
first thing that would make the POC feel bad. The cost is one more piece of state that can go
stale; refreshing the mirror on each allocation bounds that.

### D29 — One `maxConcurrentRuns`, enforced by a single admission function; 409 over the limit

Today there is no limit as such. `daemon.ts:94` injects `hasActiveRun: () => activeRunIds().length > 0`
— a *boolean* — which `dispatch.ts:117` consumes as D24's "WIP limit of 1", and **`POST /api/runs`
checks nothing at all.** A manual start has always bypassed the dispatcher's limit; nothing
noticed because manual starts were CLI-only and rare.

D24's boolean is replaced by one number in the config and one admission function on the start
path, shared by the HTTP API and the dispatcher. Over the limit, `POST /api/runs` returns 409;
the dispatcher skips the pass as it does today.

**Queued runs are deferred, and the seam is built for them.** A queued state is wanted — it is
what makes scheduling ahead possible — but it is bigger than admission control: it needs a
`RunQueued` event (touching ADR 0003's event type), queued runs that survive restart, a stable
order, and cancellation before a run has started. That is a second scheduler beside the
dispatcher. Deciding it before the POC is in anyone's hands is deciding it blind. Admission is
therefore a single explicit function rather than an inline check, so introducing a queue later is
one implementation swap and not a redesign.

### D30 — `GET /api/workflows`, from the config's array

Returns each workflow's `id` and its input schema converted to JSON Schema — the same conversion
already performed at `ctx.agent`'s `outputSchema` boundary, reused rather than reinvented. No
filesystem scan, no validation-without-execution machinery (D27).

### D31 — `POST /api/runs {workflowId, input}`; `factory start` is an HTTP client

The server supplies `dir`, clone and identity from config; the caller supplies only what is
genuinely task-specific. Input is decoded through the workflow's own Effect `Schema` — 400 on a
decode failure, 409 over the concurrency limit (D29).

`factory start <workflowId> --input <json>` posts to a running daemon and prints the `runId`, with
an optional `--watch` that tails SSE. It is a thin HTTP client, **not** a second in-process runner:
`factory run` executes in-process and opens its own sqlite connection, so a daemon would not see
that run in its in-memory registry (`runs.ts`) and neither cancellation nor the D29 limit would
apply to it.

`factory run` is nonetheless **retained** as the no-daemon path — it is the fastest way to execute
a workflow file directly, and phase 1's and phase 2's tests drive it. The path-based `POST /api/runs`
body is retained internally for the dispatcher, which supplies real filesystem paths legitimately.

### D32 — Write-back metadata is agent-supplied, branch included; the runtime resolves collisions

D11 established that PR title and body come from an ordinary agent step returning structured
output, so that Factory stays out of the business of knowing what a PR should say. The same
argument applies to the branch name, and stopping at title/body was arbitrary.

Today `branch`, `repoSlug` and `baseBranch` are all *workflow input fields*
(`workflows/implement-issue.ts:82`), passed straight through to `ctx.writeBack` (line 161). That
is wrong in two different ways at once: two of them are deployment config (D27), and the third is
a per-task decision that a workflow should not have to hardcode. Hardcoding it is what forces a
workflow-per-task, which defeats the point of the authoring surface.

So `branch` joins the PR-metadata step's structured output, and the `ctx.writeBack` signature
shrinks:

```ts
const { prUrl, branch } = await ctx.writeBack({
  branch: prMetadata.branch,   // agent-supplied hint
  commitMessage,
  prTitle: prMetadata.title,
  prBody: prMetadata.body,
});
```

The existing tier-3 domain fallback (`resolvePrMetadata`) already covers extraction failure, so a
hardcoded branch name remains the safety net rather than the norm.

**Collision handling is reactive, not preemptive.** `writeBack` pushes the name it was given; if
the push is rejected because the branch already exists remotely — or `gh pr create` fails because
a PR already exists for it — the runtime suffixes with a short `runId`, re-branches, and retries
once. It returns the branch it actually used.

Always-suffixing was the first proposal and is wrong: agent-generated branch names differ per task,
so collisions are the rare case, and unconditionally appending a hex fragment would uglify every
name to solve a problem that usually is not there. Pre-*checking* is wrong for a different reason:
two concurrent runs both ask "does `feat/x` exist?", both see no, and both push. The check races;
the push does not. `writeBack` already inspects exit codes (`writeback.ts:135`), so reacting to
the rejection is the contained change.

### D33 — The start form is single-depth, with a raw-JSON escape hatch

Generated from the workflow's input schema: `string`, `number` and `boolean` fields, one level
deep. Anything it cannot render falls back to a raw JSON textarea validated server-side by the
same decode as D31.

D27 and D32 together are what make this sufficient rather than a compromise: `implement-issue`'s
input goes from four fields — three of which are environment config retyped on every start — to
`{ issueNumber }`.

## Consequences

**`implement-issue` stops being about slugify.** Its input shrinks to an issue number, its
write-back metadata comes from the agent, and its repo comes from config. That makes it the first
workflow that is genuinely reusable across tasks, which is the POC's actual value and also the
thing that will falsify D32 fastest if it is wrong.

**ADR 0002's six-member `ctx` survives.** Adding `runId` to `ctx` was the obvious way to let a
workflow disambiguate its own branch names; D32 removes the need, so the seventh member is not
added. `ctx.writeBack`'s signature does shrink, which touches ADR 0002's stated border case but
does not resolve it — the demotion trigger is still "the first second workflow."

**D24's per-issue backoff is unaffected** but its WIP limit of 1 is not the system's limit any
more. The dispatcher still dispatches one item per reconcile pass; what changes is that the
ceiling it checks against is shared with manual starts and configurable.

**Phase 4's ADR moves to 0006.** Phase 4's plan earmarked 0005 for the transcript verdict and the
dispatch API shape; the dispatch API is now out of scope and this ADR took the number first.

**Still unknown after this phase, by construction:** whether the mirror cache's staleness handling
is right under real concurrent load, whether N concurrent `localProcess` agent sessions contend
for anything on the host (D7 bought zero isolation, and nothing has ever run two at once), and
whether reactive collision handling is reached often enough to be exercised at all.
