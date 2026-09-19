---
name: ui-edit-mode
description: Run a live UI-feedback loop against the prod backend — start the Vite dev server with Agentation enabled, delegate each piece of feedback to a subagent, and land the result as its own conventional commit. Use when the user wants to enter "UI edit mode", iterate on the web UI against real data, or hands you an Agentation "Page Feedback" report to implement.
---

A live feedback loop for `src/web`: run it against the real backend, collect click-to-annotate
feedback, farm the fixes out, ship each one as its own commit. Assumes `agentation` and `vite` are
already installed and `vite.config.ts` already proxies `/api/*` to the prod backend and gates
Agentation behind `FACTORY_AGENTATION` — this skill is the loop on top of that setup, not the setup
itself.

## 1. Start the dev server

Check for an already-running instance first (`ps aux | grep vite`, or just try the port) — a stray
duplicate from an earlier session confuses which URL is live.

```
FACTORY_AGENTATION=1 bun x vite
```

Start it through the harness's own background-task mechanism (`run_in_background: true` on the Bash
tool, or the Task equivalent) — a process backgrounded by hand (`&` / `nohup` / `disown`) gets reaped
the moment the tool call that launched it returns.

Vite prints the URLs it's listening on, including the Tailscale one if `tailscale0` is up
(`tailscale status --self` / `hostname` if you need the MagicDNS name directly — don't hardcode a
name from a past session, it's specific to whichever tailnet the current machine is on). Share that
URL with the user and point them at the page to annotate. `preview_open`/`preview_navigate` also
work if you're driving the browser yourself.

## 2. Investigate before delegating

The user comes back with a "Page Feedback" report: one or more numbered items, each with a
`Location`/`React` breadcrumb and a feedback sentence. Read the actual component each breadcrumb
points at before writing anything — the breadcrumb's classes are often shared across many elements
(Tailwind utilities, not unique locators), so cross-check it against the "React" component chain and
the file's real structure to find the exact element. Never hand a subagent a paraphrase of the
feedback sentence; hand it the file path, the line numbers, the current code, and what the code
should do instead.

## 3. Group by file, then delegate

Group feedback items that touch the same file into one subagent — parallel subagents editing the
same file clobber each other's diffs. Items in disjoint files become separate subagents running in
parallel. Each prompt is self-contained: the files/lines it owns, the current code, the acceptance
criteria per item it covers, and an instruction to run `bun run check` before reporting back and to
leave any `data-testid` used by `e2e/*.e2e.ts` alone.

## 4. Verify, then commit — one commit per feedback item

Trust but verify: check the actual diff, don't just take the subagent's summary. For a UI claim,
verify it in the browser (`preview_snapshot` for what rendered, `preview_evaluate` for a measurable
claim like scroll position) rather than reasoning about it from the diff alone — a change can
typecheck, pass `bun run check`, and still not do the thing the feedback asked for.

Invoking this skill is the user's standing consent to commit each landed item; don't pause to ask
per commit. Each feedback item lands as its own conventional-commit, describing that one change. When
a subagent implemented several items together in one pass because they shared a file, split its
working tree with `git add -p` and commit hunk-by-hunk instead of one commit for the whole diff — one
feedback item, one commit, even when several were built in the same pass.
