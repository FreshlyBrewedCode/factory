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

const implementPrompt = (
  issueNumber: number,
) => `You are working in a git checkout of a small bun/TypeScript package.

Implement GitHub issue #${issueNumber} in this repository. First read the issue itself: run \`gh issue view ${issueNumber}\` to fetch its title and body, then implement exactly what it asks for.

When the implementation is in place, add or update tests in the existing test file, in the same style as the tests already there, so that \`bun test\` passes for the new behaviour. Do not remove or break unrelated existing exports or their tests.

When you are done, stop — do not run git commands, do not commit, do not open a PR.`;

const fixRepairPromptPrefix = (
  issueNumber: number,
) => `You are working in the same git checkout as before, in a fresh session with no memory of the prior conversation. \`bun test\` is failing while implementing GitHub issue #${issueNumber}. Look at the current state of the tree, diagnose the failure from the output below, and fix it. Do not remove or break unrelated existing exports or their tests.

Do not run git commands, do not commit, do not open a PR.`;

const fixReviewPrompt = (
  issueNumber: number,
) => `You are working in the same git checkout as before, in a fresh session with no memory of the prior conversation. \`bun test\` is currently passing for the implementation of GitHub issue #${issueNumber}. Review the implementation and its tests for correctness and edge cases. If you find a real bug, fix it and keep tests passing. If everything already looks correct, make no changes and say so.

Do not run git commands, do not commit, do not open a PR.`;

const prMetadataPrompt = (
  issueNumber: number,
) => `You are working in the same git checkout as before, in a fresh session. Read GitHub issue #${issueNumber} via \`gh issue view ${issueNumber}\` and the working tree changes to see what was implemented to close it.

Do not modify any files and do not run mutating git commands. Respond only with the requested JSON object: the git branch name this change should live on (lowercase words joined by hyphens, prefixed with factory/issue-${issueNumber}-), a concise, accurate PR title, and a short PR body (a couple of sentences plus a bullet list of what changed).`;

const PrMetadataOutput = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  branch: Schema.optional(Schema.String),
});

export interface PrMetadata {
  readonly title: string;
  readonly body: string;
  /**
   * D32: the branch hint is agent-supplied and genuinely optional — the
   * recorded structured-output schema keeps it optional, and extraction
   * failure (or an old corpus that predates the field) is handled by
   * `resolvePrMetadata`'s domain fallback. Not typed required, because the
   * runtime's `??` fallback is the honest contract, not an implementation
   * detail.
   */
  readonly branch?: string;
}

/**
 * The tier-3 domain fallback (extraction failure) remains the only place this
 * workflow hardcodes anything task-specific: the branch hint and the PR copy
 * below are for the case where the agent step failed to produce structured
 * output. On the happy path the agent supplies branch/title/body itself, so
 * this workflow stays generic across issues — REQUIRED_MARKERS (and any other
 * slugify-specific assertion) has no place here.
 */
export type PrMetadataMechanism = "extracted" | "hardcoded-fallback";

const TRACKED_FILES = ["src/index.ts", "src/index.test.ts"] as const;

function resolvePrMetadata(
  step: AgentResult<PrMetadata>,
  issueNumber: number,
): { readonly title: string; readonly body: string; readonly branch: string } & {
  readonly mechanism: PrMetadataMechanism;
} {
  if (step.output !== undefined) {
    return {
      title: step.output.title,
      body: step.output.body,
      branch: step.output.branch ?? `factory/issue-${issueNumber}`,
      mechanism: "extracted",
    };
  }
  return {
    title: `Add slugify(input: string): string (closes #${issueNumber})`,
    body: "Automated PR from the factory implement-issue workflow. Structured-output extraction failed for this run; see the run's event log for the raw agent transcript.",
    branch: `factory/issue-${issueNumber}`,
    mechanism: "hardcoded-fallback",
  };
}

const Input = Schema.Struct({
  issueNumber: Schema.Int,
});

const Output = Schema.Struct({
  testAfterImplementExitCode: Schema.Int,
  testAfterFixExitCode: Schema.Int,
  hostSideStabilityIntact: Schema.Boolean,
  fixStepSurvivalIntact: Schema.Boolean,
  prMetadataMechanism: Schema.Literals(["extracted", "hardcoded-fallback"]),
  prUrl: Schema.NullOr(Schema.String),
  prBranch: Schema.String,
});

export default defineWorkflow("implement-issue", {
  input: Input,
  output: Output,
  run: async (ctx, input) => {
    // Step 2: implement.
    await ctx.agent("implement", implementPrompt(input.issueNumber));

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
        ? fixReviewPrompt(input.issueNumber)
        : `${fixRepairPromptPrefix(input.issueNumber)}\n\nSTDOUT:\n${testAfterImplement.stdout}\n\nSTDERR:\n${testAfterImplement.stderr}`;
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
        requiredMarkers: {},
      });
      return { pass: result.intact, details: { report: result.report, files: result.files } };
    });

    // Step 5: verify again.
    const testAfterFix = await ctx.exec(["bun", "test"]);

    // Step 6: PR metadata via structured output (D32: branch included).
    const prMetadataStep = await ctx.agent<PrMetadata>(
      "pr-metadata",
      prMetadataPrompt(input.issueNumber),
      {
        output: PrMetadataOutput,
      },
    );
    const prMetadata = resolvePrMetadata(prMetadataStep, input.issueNumber);

    // Step 7: deterministic write-back (D9) — host git + gh, not an agent instruction.
    // repoSlug/baseBranch come from the run environment (config), not the workflow (D27/D32);
    // a push or `gh pr create` collision gets runId-suffixed and retried once by the runtime.
    const commitMessage = `Implement issue #${input.issueNumber}

Closes #${input.issueNumber}.

Automated by the factory implement-issue workflow.`;
    const writeBackResult = await ctx.writeBack({
      branch: prMetadata.branch,
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
      prBranch: writeBackResult.branch,
    };
  },
});
