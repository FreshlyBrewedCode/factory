/**
 * The workflow script — the imperative, author-facing piece (D13). Plain
 * `async` control flow over a `ctx` handle, no framework surface: this is
 * the shape phase 1's `defineWorkflow` will eventually wrap, but nothing
 * here depends on that happening.
 *
 * 0a-2 scope: the full eight-step round trip from STATUS.md's "Phase 0 → 0a"
 * plan — clone (done by the runtime before this function is called),
 * implement, test, fix (with the step-4 tree-survival assertion), test
 * again, PR metadata via structured output, and deterministic write-back
 * (D9). Every mechanical detail (git plumbing, snapshot diffing) lives in
 * `lib/`; this file stays the sequence a workflow author would write.
 */

import type { AgentStepResult } from "./lib/agent-step";
import type { ExecResult } from "./lib/exec";
import {
  assertFixStepSurvived,
  assertHostSideStability,
  seedFileSnapshot,
  snapshotFiles,
  type FixStepSurvivalAssertion,
  type HostSideStabilityAssertion,
} from "./lib/tree-snapshot";
import { writeBack, type WriteBackResult } from "./lib/writeback";

export const ISSUE_1_PROMPT = `You are working in a git checkout of a small bun/TypeScript package.

Implement GitHub issue #1: add a \`slugify(input: string): string\` export from src/index.ts, alongside the existing \`greet\` export. It should lowercase the input, trim it, replace runs of non-alphanumeric characters with a single hyphen, and strip leading/trailing hyphens (e.g. "Hello, World!" -> "hello-world").

Add a passing test for it in src/index.test.ts, in the same style as the existing test for \`greet\`. Do not remove or break the existing \`greet\` export or its test.

When you are done, stop — do not run git commands, do not commit, do not open a PR.`;

const FIX_REPAIR_PROMPT_PREFIX = `You are working in the same git checkout as before, in a fresh session with no memory of the prior conversation. \`bun test\` is failing. Look at the current state of src/index.ts and src/index.test.ts, diagnose the failure from the output below, and fix it. Do not remove or break the existing \`greet\` export or its test.

Do not run git commands, do not commit, do not open a PR.`;

const FIX_REVIEW_PROMPT = `You are working in the same git checkout as before, in a fresh session with no memory of the prior conversation. \`bun test\` is currently passing for the \`slugify\` implementation in src/index.ts and its test in src/index.test.ts. Review both for correctness and edge cases (empty string, already-slug input, unicode, repeated separators, leading/trailing punctuation). If you find a real bug, fix it and keep tests passing. If everything already looks correct, make no changes and say so.

Do not run git commands, do not commit, do not open a PR.`;

const PR_METADATA_PROMPT = `You are working in the same git checkout as before, in a fresh session. Read src/index.ts and src/index.test.ts to see the \`slugify\` implementation and its tests that close GitHub issue #1 ("Add a slugify(input: string): string export, with tests").

Do not modify any files. Respond only with the requested JSON object: a concise, accurate PR title and a short PR body (a couple of sentences plus a bullet list of what changed) describing this change.`;

export const PR_METADATA_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" },
  },
  required: ["title", "body"],
  additionalProperties: false,
} as const;

const TRACKED_FILES = ["src/index.ts", "src/index.test.ts"] as const;

/**
 * Substrings that must still be present in each tracked file after the fix
 * step for "step 2's contribution survived" to be considered true, above
 * and beyond "the file wasn't literally reverted to the seed". Chosen from
 * the actual 0a-1/0a-2 implement-step output (`docs/phase0-findings.md`,
 * `gh pr diff`), not guessed.
 */
const REQUIRED_MARKERS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "src/index.ts": ["function slugify", "function greet"],
  "src/index.test.ts": ["slugify", "greet"],
};

export interface WorkflowContext {
  readonly clonePath: string;
  agentStep(options: {
    step: string;
    prompt: string;
    outputSchema?: unknown;
  }): Promise<AgentStepResult>;
  exec(command: ReadonlyArray<string>): Promise<ExecResult>;
}

export type PrMetadataMechanism =
  | "structured-output-event"
  | "manual-json-parse-fallback"
  | "hardcoded-fallback";

export interface PrMetadata {
  readonly title: string;
  readonly body: string;
  readonly mechanism: PrMetadataMechanism;
}

/**
 * D11's mechanism question, resolved with a fallback chain and an honest
 * report of which tier fired. Tier 1 is the thing 0a-1 only read about:
 * `chat({ outputSchema, stream: true })`'s own `structured-output.complete`
 * CUSTOM event. Tier 2 re-parses the harness's last assistant message by
 * hand (the mechanism the docs implied might be necessary). Tier 3 is a
 * deterministic Factory-authored fallback so write-back never blocks on the
 * agent having said something parseable.
 */
export function resolvePrMetadata(step: AgentStepResult): PrMetadata {
  const structured = step.structuredOutput as { title?: unknown; body?: unknown } | undefined;
  if (
    structured !== undefined &&
    structured !== null &&
    typeof structured.title === "string" &&
    typeof structured.body === "string"
  ) {
    return { title: structured.title, body: structured.body, mechanism: "structured-output-event" };
  }

  try {
    const parsed = JSON.parse(step.finalAssistantText) as { title?: unknown; body?: unknown };
    if (typeof parsed.title === "string" && typeof parsed.body === "string") {
      return { title: parsed.title, body: parsed.body, mechanism: "manual-json-parse-fallback" };
    }
  } catch {
    // fall through to the hardcoded fallback
  }

  return {
    title: "Add slugify(input: string): string (closes #1)",
    body: "Automated PR from the factory-spike 0a-2 round trip. Structured-output extraction failed for this run; see the run's NDJSON corpus for the raw agent transcript.",
    mechanism: "hardcoded-fallback",
  };
}

export interface RoundTripResult {
  readonly implement: AgentStepResult;
  readonly testAfterImplement: ExecResult;
  /**
   * Weak assertion: both snapshots taken before the fix step's sandbox
   * exists. Spans only the host-side `bun test` exec, NOT the fix step's
   * sandbox re-bootstrap. See `fixStepSurvivalAssertion` for the one that
   * actually answers STATUS.md's step-4 question.
   */
  readonly hostSideStabilityAssertion: HostSideStabilityAssertion;
  readonly fix: AgentStepResult;
  /**
   * Strong assertion: post-implement snapshot vs. post-fix snapshot, so it
   * spans the fix step's own sandbox setup/re-bootstrap. This is
   * STATUS.md's "the single most important thing phase 0 can learn".
   */
  readonly fixStepSurvivalAssertion: FixStepSurvivalAssertion;
  readonly testAfterFix: ExecResult;
  readonly prMetadataStep: AgentStepResult;
  readonly prMetadata: PrMetadata;
  readonly writeBack: WriteBackResult;
}

export interface RoundTripOptions {
  readonly branch: string;
  readonly repoSlug: string;
  readonly baseBranch: string;
  readonly issueNumber: number;
}

/**
 * The full eight-step round trip (steps 1 and 8 — clone reset and NDJSON
 * sink wiring — are the runtime's job, per D13; this function starts from an
 * already-cloned `ctx.clonePath` and covers steps 2-7).
 */
export async function fullRoundTrip(
  ctx: WorkflowContext,
  options: RoundTripOptions,
): Promise<RoundTripResult> {
  // Step 2: implement.
  const implement = await ctx.agentStep({ step: "implement", prompt: ISSUE_1_PROMPT });

  // Snapshot immediately after the implement step, before anything else touches the tree.
  const snapshotAfterImplement = await snapshotFiles(ctx.clonePath, TRACKED_FILES);

  // Seed baseline for the *strong* assertion below: the content these paths
  // had at origin/main, read via `git show` without touching the working
  // tree. Lets us tell "reverted to seed" apart from "agent edited".
  const seedSnapshot = await seedFileSnapshot(ctx.clonePath, TRACKED_FILES, "origin/main");

  // Step 3: verify.
  const testAfterImplement = await ctx.exec(["bun", "test"]);

  // Weak, host-side-only check: re-read the same files right before the fix
  // step's fresh session starts. This spans only the host-side `bun test`
  // exec above, NOT the fix step's own sandbox re-bootstrap — do not mistake
  // this for STATUS.md's step-4 assertion.
  const snapshotBeforeFix = await snapshotFiles(ctx.clonePath, TRACKED_FILES);
  const hostSideStabilityAssertion = assertHostSideStability(
    snapshotAfterImplement,
    snapshotBeforeFix,
  );

  // Step 4: fix (or review/harden if tests already pass — still exercises
  // the sandbox-reuse question genuinely, per the task).
  const fixPrompt =
    testAfterImplement.exitCode === 0
      ? FIX_REVIEW_PROMPT
      : `${FIX_REPAIR_PROMPT_PREFIX}\n\nSTDOUT:\n${testAfterImplement.stdout}\n\nSTDERR:\n${testAfterImplement.stderr}`;
  const fix = await ctx.agentStep({ step: "fix", prompt: fixPrompt });

  // Strong assertion: snapshot taken right after the fix step *completes*,
  // compared against the post-implement snapshot. This span crosses the fix
  // step's own sandbox setup/re-bootstrap — the thing STATUS.md's step 4 is
  // actually asking about ("the single most important thing phase 0 can
  // learn"), not just host-side stability.
  const snapshotAfterFix = await snapshotFiles(ctx.clonePath, TRACKED_FILES);
  const fixStepSurvivalAssertion = assertFixStepSurvived({
    afterImplement: snapshotAfterImplement,
    afterFix: snapshotAfterFix,
    seed: seedSnapshot,
    requiredMarkers: REQUIRED_MARKERS,
  });

  // Step 5: verify again.
  const testAfterFix = await ctx.exec(["bun", "test"]);

  // Step 6: PR metadata via structured output (D11).
  const prMetadataStep = await ctx.agentStep({
    step: "pr-metadata",
    prompt: PR_METADATA_PROMPT,
    outputSchema: PR_METADATA_SCHEMA,
  });
  const prMetadata = resolvePrMetadata(prMetadataStep);

  // Step 7: deterministic write-back (D9) — host git + gh, not an agent instruction.
  const commitMessage = `Implement slugify per issue #${options.issueNumber}\n\nCloses #${options.issueNumber}.\n\nAutomated by the factory 0a-2 spike round trip.`;
  const writeBackResult = await writeBack({
    clonePath: ctx.clonePath,
    branch: options.branch,
    baseBranch: options.baseBranch,
    repoSlug: options.repoSlug,
    commitMessage,
    prTitle: prMetadata.title,
    prBody: prMetadata.body,
  });

  return {
    implement,
    testAfterImplement,
    hostSideStabilityAssertion,
    fix,
    fixStepSurvivalAssertion,
    testAfterFix,
    prMetadataStep,
    prMetadata,
    writeBack: writeBackResult,
  };
}
