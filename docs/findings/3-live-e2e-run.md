# Finding 3 — phase 1's live end-to-end run

**Date:** 2026-09-14
**Run:** `run-1789368882906`, via `bun run src/cli.ts run workflows/implement-issue.ts`
**Result:** [factory-spike#4](https://github.com/FreshlyBrewedCode/factory-spike/pull/4), OPEN

## What ran

The production `defineWorkflow`/`startRun` path (`workflows/implement-issue.ts`), against real
opencode (`opencode-go/deepseek-v4.1-flash`), a fresh clone of
`FreshlyBrewedCode/factory-spike`, and real `git`/`gh` write-back. Not a re-run of the phase 0
spike script — this is the first live exercise of the phase 1 runtime itself: `ctx.agent`,
`ctx.exec`, `ctx.assert`, `ctx.writeBack`, `RunEvent` emission, all through `startRun`/`src/cli.ts`.

Three agent steps, same shape as the phase 0 spike (D10: one `threadId`
(`run-1789368884743`), three distinct `sessionId`s — `ses_f614d9d25ffeF7mz4U0I77ImYO`,
`ses_f614d75daffeq0w4P8agJYQILo`, `ses_f614d0c14ffeXHSh8pvrPXYCR4`):

1. **implement** — added `slugify(input: string): string` per issue #1.
2. **fix** — asked to review for correctness and edge cases; found and fixed a real bug (below).
3. **pr-metadata** — structured output (`outputSchema`), tier 1 extraction
   (`structured-output.complete`), used verbatim for the PR title/body.

`testAfterImplementExitCode: 0`, `testAfterFixExitCode: 0`, `hostSideStabilityIntact: true`,
`fixStepSurvivalIntact: true`, `prMetadataMechanism: "extracted"`.

## The bug the fix step found

The first implementation matched non-ASCII letters as separators:
`slugify("Héllo")` → `"h-llo"`, `slugify("übung")` → `"bung"` — accented characters were dropped
entirely rather than transliterated, because `[^a-z0-9]+` treats anything outside ASCII as a
separator.

The fix step, given a fresh session with no memory of the implement step's reasoning and asked to
review for "empty string, already-slug input, unicode, repeated separators, leading/trailing
punctuation," found this unprompted and fixed it:

```ts
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
```

`NFKD` normalization splits each accented character into a base letter plus a combining mark
(`é` → `e` + `´`); stripping the combining-mark Unicode range before the existing ASCII-only
collapse turns `café` → `cafe` and `Héllo Wörld` → `hello-world` instead of dropping the letter.
It also added five new test cases (empty/whitespace, already-slug, unicode, repeated separators,
leading/trailing punctuation) — going from 1 test to 7, all passing.

This is exactly the round trip D9/D11 are betting on: a **deterministic** write-back step
(git/gh, no agent judgement) downstream of an **agentic** review step whose value is
finding real bugs a human reviewer would also flag, then correctly attributing the fix's
diff to a `git add`/`commit` that write-back controls precisely.

## Relation to the phase-1 exit criterion

STATUS.md's phase 1 exit criterion has two legs:

1. ✅ **This run** — real implement → test → review workflow, end-to-end against opencode.
2. ✅ `workflows/implement-issue.test.ts` — the same `implement-issue.ts` workflow, run through
   the same `startRun`, replayed against the recorded round-trip corpus
   (`test/corpus/run-1789308170212.ndjson`) instead of live opencode, green in `bun test`.

Both are now satisfied — see STATUS.md's phase 1 section for the exit-criterion writeup.
