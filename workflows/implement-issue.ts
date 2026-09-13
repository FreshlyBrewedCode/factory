/**
 * The full round trip (ADR 0001 §5, D13): implement, test, fix (with the
 * step-4 tree-survival assertion), test again, PR metadata via structured
 * output, deterministic write-back (D9). Clone/reset is the runtime's job
 * (D8), not this workflow's — `ctx.dir` arrives already checked out.
 *
 * Lifted from `src/spike/workflow.ts`'s `fullRoundTrip` onto the hardened
 * `defineWorkflow`/`ctx` surface (ADR 0002). Two things moved along the way:
 *
 * - Tier-1/tier-2 structured-output extraction (the old `resolvePrMetadata`)
 *   is now the runtime's job (`ctx.agent`'s `output` option, ADR 0002 §3) —
 *   this file keeps only the tier-3 domain fallback, which is workflow code
 *   by design.
 * - The two tree-survival checks are recorded through `ctx.assert` instead
 *   of being plain return fields, so they show up as `AssertionRecorded`
 *   events (D3) rather than only being visible if a caller inspects the
 *   return value.
 */

import {
  assertFixStepSurvived,
  assertHostSideStability,
  seedFileSnapshot,
  snapshotFiles,
} from "../src/lib/tree-snapshot";
import { defineWorkflow, Schema, type AgentResult } from "../src/workflow";

const ISSUE_1_PROMPT = `You are working in a git checkout of a small bun/TypeScript package.

Implement GitHub issue #1: add a \`slugify(input: string): string\` export from src/index.ts, alongside the existing \`greet\` export. It should lowercase the input, trim it, replace runs of non-alphanumeric characters with a single hyphen, and strip leading/trailing hyphens (e.g. "Hello, World!" -> "hello-world").

Add a passing test for it in src/index.test.ts, in the same style as the existing test for \`greet\`. Do not remove or break the existing \`greet\` export or its test.

When you are done, stop — do not run git commands, do not commit, do not open a PR.`;

const FIX_REPAIR_PROMPT_PREFIX = `You are working in the same git checkout as before, in a fresh session with no memory of the prior conversation. \`bun test\` is failing. Look at the current state of src/index.ts and src/index.test.ts, diagnose the failure from the output below, and fix it. Do not remove or break the existing \`greet\` export or its test.

Do not run git commands, do not commit, do not open a PR.`;

const FIX_REVIEW_PROMPT = `You are working in the same git checkout as before, in a fresh session with no memory of the prior conversation. \`bun test\` is currently passing for the \`slugify\` implementation in src/index.ts and its test in src/index.test.ts. Review both for correctness and edge cases (empty string, already-slug input, unicode, repeated separators, leading/trailing punctuation). If you find a real bug, fix it and keep tests passing. If everything already looks correct, make no changes and say so.

Do not run git commands, do not commit, do not open a PR.`;

const PR_METADATA_PROMPT = `You are working in the same git checkout as before, in a fresh session. Read src/index.ts and src/index.test.ts to see the \`slugify\` implementation and its tests that close GitHub issue #1 ("Add a slugify(input: string): string export, with tests").

Do not modify any files. Respond only with the requested JSON object: a concise, accurate PR title and a short PR body (a couple of sentences plus a bullet list of what changed) describing this change.`;

const PrMetadataOutput = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
});

const TRACKED_FILES = ["src/index.ts", "src/index.test.ts"] as const;

/**
 * Substrings that must still be present in each tracked file after the fix
 * step for "step 2's contribution survived" to be considered true, above and
 * beyond "the file wasn't literally reverted to the seed". Chosen from the
 * actual 0a-1/0a-2 implement-step output, not guessed.
 */
const REQUIRED_MARKERS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "src/index.ts": ["function slugify", "function greet"],
  "src/index.test.ts": ["slugify", "greet"],
};

export type PrMetadataMechanism = "extracted" | "hardcoded-fallback";

function resolvePrMetadata(
  step: AgentResult<{ title: string; body: string }>,
  issueNumber: number,
): { readonly title: string; readonly body: string; readonly mechanism: PrMetadataMechanism } {
  if (step.output !== undefined) {
    return { title: step.output.title, body: step.output.body, mechanism: "extracted" };
  }
  return {
    title: `Add slugify(input: string): string (closes #${issueNumber})`,
    body: "Automated PR from the factory implement-issue workflow. Structured-output extraction failed for this run; see the run's event log for the raw agent transcript.",
    mechanism: "hardcoded-fallback",
  };
}

const Input = Schema.Struct({
  issueNumber: Schema.Int,
  branch: Schema.String,
  repoSlug: Schema.String,
  baseBranch: Schema.String,
});

const Output = Schema.Struct({
  testAfterImplementExitCode: Schema.Int,
  testAfterFixExitCode: Schema.Int,
  hostSideStabilityIntact: Schema.Boolean,
  fixStepSurvivalIntact: Schema.Boolean,
  prMetadataMechanism: Schema.Literals(["extracted", "hardcoded-fallback"]),
  prUrl: Schema.NullOr(Schema.String),
});

export default defineWorkflow("implement-issue", {
  input: Input,
  output: Output,
  run: async (ctx, input) => {
    // Step 2: implement.
    await ctx.agent("implement", ISSUE_1_PROMPT);

    // Snapshot immediately after the implement step, before anything else touches the tree.
    const snapshotAfterImplement = await snapshotFiles(ctx.dir, TRACKED_FILES);

    // Seed baseline for the strong assertion below: content at origin/main,
    // read via `git show` without touching the working tree. Lets us tell
    // "reverted to seed" apart from "agent edited".
    const seedSnapshot = await seedFileSnapshot(ctx.dir, TRACKED_FILES, "origin/main");

    // Step 3: verify.
    const testAfterImplement = await ctx.exec(["bun", "test"]);

    // Weak, host-side-only check: re-read the same files right before the fix
    // step's fresh session starts. Spans only the host-side `bun test` exec
    // above, NOT the fix step's own sandbox re-bootstrap.
    const snapshotBeforeFix = await snapshotFiles(ctx.dir, TRACKED_FILES);
    const hostSideStability = await ctx.assert("host-side-stability", () => {
      const result = assertHostSideStability(snapshotAfterImplement, snapshotBeforeFix);
      return { pass: result.intact, details: { report: result.report } };
    });

    // Step 4: fix (or review/harden if tests already pass — still exercises
    // the sandbox-reuse question genuinely).
    const fixPrompt =
      testAfterImplement.exitCode === 0
        ? FIX_REVIEW_PROMPT
        : `${FIX_REPAIR_PROMPT_PREFIX}\n\nSTDOUT:\n${testAfterImplement.stdout}\n\nSTDERR:\n${testAfterImplement.stderr}`;
    await ctx.agent("fix", fixPrompt);

    // Strong assertion: snapshot right after the fix step *completes*,
    // compared against the post-implement snapshot — spans the fix step's
    // own sandbox setup/re-bootstrap.
    const snapshotAfterFix = await snapshotFiles(ctx.dir, TRACKED_FILES);
    const fixStepSurvival = await ctx.assert("fix-step-survival", () => {
      const result = assertFixStepSurvived({
        before: snapshotAfterImplement,
        after: snapshotAfterFix,
        seed: seedSnapshot,
        requiredMarkers: REQUIRED_MARKERS,
      });
      return { pass: result.intact, details: { report: result.report, files: result.files } };
    });

    // Step 5: verify again.
    const testAfterFix = await ctx.exec(["bun", "test"]);

    // Step 6: PR metadata via structured output (D11).
    const prMetadataStep = await ctx.agent<{ title: string; body: string }>(
      "pr-metadata",
      PR_METADATA_PROMPT,
      { output: PrMetadataOutput },
    );
    const prMetadata = resolvePrMetadata(prMetadataStep, input.issueNumber);

    // Step 7: deterministic write-back (D9) — host git + gh, not an agent instruction.
    const commitMessage = `Implement slugify per issue #${input.issueNumber}\n\nCloses #${input.issueNumber}.\n\nAutomated by the factory implement-issue workflow.`;
    const writeBackResult = await ctx.writeBack({
      branch: input.branch,
      baseBranch: input.baseBranch,
      repoSlug: input.repoSlug,
      commitMessage,
      prTitle: prMetadata.title,
      prBody: prMetadata.body,
    });

    return {
      testAfterImplementExitCode: testAfterImplement.exitCode,
      testAfterFixExitCode: testAfterFix.exitCode,
      hostSideStabilityIntact: hostSideStability.pass,
      fixStepSurvivalIntact: fixStepSurvival.pass,
      prMetadataMechanism: prMetadata.mechanism,
      prUrl: writeBackResult.prUrl,
    };
  },
});
