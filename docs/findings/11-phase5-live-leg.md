# 11 — Phase 5 exit: the live leg (two concurrent real runs to real PRs)

**Date:** 2026-09-15 · **Branch:** `feat/phase-5` · **Project config: `sample/`**
**Model on every agent step: `opencode-go/glm-5.3-flash`**

Phase 5's P6 exit criterion reads: *two concurrent real runs watched to real PRs, the thing
fakes cannot attest* — mirror staleness under concurrent load, N concurrent real
`localProcess` agent processes, and D32's collision path reached in reality. The 2026-09-15
session ran it: a sample project (`sample/factory.config.ts` + one minimal workflow) for the
[`factory-spike`](https://github.com/FreshlyBrewedCode/factory-spike) repo, a daemon on
`factory serve`, runs driven through `factory start --watch` (CLI) and validated in the UI by a
playwright operator, five real agent runs total — five real PRs: factory-spike
[#7](https://github.com/FreshlyBrewedCode/factory-spike/pull/7),
[#8](https://github.com/FreshlyBrewedCode/factory-spike/pull/8),
[#11](https://github.com/FreshlyBrewedCode/factory-spike/pull/11),
[#12](https://github.com/FreshlyBrewedCode/factory-spike/pull/12),
[#13](https://github.com/FreshlyBrewedCode/factory-spike/pull/13).

## The sample project (shipped, `sample/`)

`sample/factory.config.ts` — D27's entry point pointed at factory-spike
(`maxConcurrentRuns: 2`), and `sample/workflows/implement-issue.ts` — a *minimal* round trip
on the authoring surface (~60 lines): implement (agent) → `bun test` → conditional fix →
PR-metadata (structured output, D32) → `ctx.writeBack` (D9). No tree-snapshot assertions, no
tiering — the smallest honest thing that opens a PR. All agent steps run on
`opencode-go/glm-5.3-flash` via the workflow's `agent: {model: ...}` default, override-tested
per-call precedence untouched.

## What ran

| run (prefix) | issue | result |
| --- | --- | --- |
| `run-7738d452` | #1 slugify | **RunFinished in 37 s** → PR #7, branch `factory/issue-1-add-slugify-helper`, `bun test` exit 0 |
| `run-1dd587f0` | #6 kebabCase (concurrent) | **RunFailed** — `opencode serve exited before becoming ready … ServeError`, 1 s in |
| `run-b6d37a03` | #6 kebabCase (retry, solo) | RunFinished in 38 s → PR #8 |
| `run-0c852ed2` | #10 shout (concurrent) | RunFinished in 47 s → PR #11 (branch unsuffixed) |
| `run-8ba43cef` | #9 trimTo (concurrent, +1.3 s) | **RunFailed** — same ServeError, deterministic |
| `run-42f97fe4` | #10 shout (concurrent, retry+1s) | RunFinished in 49 s → **PR #12**, branch `…-42f97fe4` — **D32's collision path fired live** (the earlier kebab/shout branch names existed remotely; the runtime suffixed with the short runId, retried, and reported `usedBranch`) |
| `run-d902774c` | #9 trimTo (concurrent, retry+1s) | RunFinished in ~42 s → **PR #13**, `bun test` exit 0, implementation + tests verified at the pushed ref |

The interesting agent behaviour: the trimTo run's first edit-based test failed, the model
*reasoned about the contradiction between the issue's spec text and its own example* in a
REASONING chunk visible in the transcript, fixed to match the example, and passed. \`bun test\`
exit 0 in the pushed tree for every completed PR.

## Finding L1 — concurrent opencode boots collide on one hardcoded port (root-caused, fixed)

**Two concurrent runs are not safe against the opencode adapter as it was: the later of two
near-simultaneous boots fails deterministically**, not flakily — `run-1dd587f0` and
`run-8ba43cef` both died 1 s in while a sibling run streamed fine. Root cause: the adapter
boots `opencode serve --port=<fixed>` inside the run's sandbox, and the package's
`DEFAULT_PORT` is a constant (4096) — under `localProcessSandbox` the "sandbox" is the host
itself, so two servers race to bind one host port; the loser exits before readiness and
`waitForReady` rejects.

**Fix (D34, ADR 0007):** `src/runtime/opencode-adapter.ts` now resolves a fresh free port per
`stream()` call (ephemeral-bind probe, D7-safe). After the fix, a retried two-concurrent leg
succeeded with **zero ServeError** on both runs. The port probe is valid only while the
sandbox is the host — a published-ports docker path must revisit (comment in the file).

Notably, two concurrent `createOpencode` boots *outside* the sandbox model (the host-side SDK
path) do **not** collide — the collision is specific to the in-sandbox fixed-port boot.

## Finding L2 — `factory start --watch` died on ECONNRESET mid-run (fixed)

`run-d902774c` completed (PR #13, store + UI agree — the daemon was healthy) while the CLI's
SSE tail crashed with an unhandled `ECONNRESET` out of `watchSse`. Because every reconnect
replays the event log from seq 0, the watch now reconnects (≤ 3 attempts, 1 s apart) instead
of crashing — reprinting idempotently. Found live, fixed, exercised by nothing new beyond the
existing `cli.start.test.ts` shape (the crash needs a real stream drop).

## Finding L3 — the UI concurrency leg, observed by playwright

A second playwright pass (evidence `/tmp/opencode/ui-evidence-2/`) captured, on the fixed
daemon: both rows `Running`+`streaming` simultaneously at t0; list counters moving between
snapshots without reload; one row self-transitioning to finished at t+15 s while the other
kept streaming; two run-detail tabs live at once; final rows showing **pr #12 / pr #13** with
zero console errors. Defects (all small, queued to phase 6, none exit-blocking):

- **Raw ANSI escapes** render literally in a failed run's error text (`\x1b[91m…`) — strip at
  projection (server or SPA `lib/status.ts`).
- **Runs-list started cell glues clock and relative time** (`14:45:409m ago`, no separator).
- **`origin` renders `—`** on every detail page (field never populated for this data shape).
- A transient replay-time duration glitch (`497078h 40m ago`) was seen once in the first
  pass and could not be re-triggered; likely epoch-ms math on a `startedAt` not yet present
  during replay. Watch for it.
- An observed UI-only wrinkle: a run's `interrupted/active` API state briefly rendered as
  `status: "running"` during replay tail-up (transient, self-correcting).

## Finding L4 — model `opencode-go/glm-5.3-flash` is fast (37–49 s round trips)

Every completed run — implement + full test cycle + PR metadata + write-back — landed in
**37–49 s**. The phase 1 live run on `opencode-go/deepseek-v4.1-flash` was an order of
magnitude slower (phase 3's live dispatch run ~9 min). This changes the experience budget of
manual runs entirely: the P6 "watch it stream" criterion is watchable, not a nap.

## What fakes could not attest, now attested

- **Mirror staleness under concurrent load:** two runs allocated back-to-back from the shared
  bare mirror; both trees are independent, disjoint and intact; each pushed correctly
  (L1's fix was required, the trees themselves behaved).
- **N concurrent real agent processes:** two `localProcess` sandboxes, two in-sandbox
  `opencode serve` instances, simultaneously streaming — works after D34, dies deterministically
  before it.
- **D32's collision path in reality:** PR #12's `usedBranch` suffix — the previously
  test-only path — fired in a live run.
- **`factory start` against a real registry-driven daemon:** 201 → runId → streamed events to
  terminal exit codes (0/1) across all runs.

## Residue

- Runs started from the CLI, watched live from the browser; browser-*start* remains covered
  by the fakes leg (`e2e/new-run.e2e.ts`) per this session's remit — noted honestly, not
  silently.
- The one transient replay-time glitch (L3) has no repro; its first-pass evidence lives in
  `/tmp/opencode/ui-evidence/` only.
- A `status-field` deferral from the P6 plan (fakes leg): collision-on-issue-1-style noise
  is real — issue #1 now has three implementation PRs (#3/#4/#7); harmless for a spike repo,
  worth remembering when judging "duplicate PR" policies later.
