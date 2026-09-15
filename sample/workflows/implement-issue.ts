/**
 * The sample project's one workflow: a minimal, issue-driven implementation
 * round trip for the target repo (see ../factory.config.ts). Same shape as the
 * factory repo's own `workflows/implement-issue.ts` but trimmed to the bare
 * pattern — this file exists to show the authoring surface in the smallest
 * honest form:
 *
 *   agent (implement) → verify (bun test) → conditional fix step →
 *   agent (PR metadata, structured output) → writeBack
 *
 * Everything here is plain async control flow over `ctx` — no step graph,
 * no DSL (D1). The runtime owns the tree (D8), the event log and
 * cancellation; the workflow owns everything else. `repoSlug`/`baseBranch`
 * are supplied by the config through the run environment (D27/D32) — the
 * workflow never carries them.
 */

import { defineWorkflow, Schema } from "../../src/workflow";

const Input = Schema.Struct({
  issueNumber: Schema.Int,
});

const Output = Schema.Struct({
  testExitCode: Schema.Int,
  prUrl: Schema.NullOr(Schema.String),
  prBranch: Schema.String,
});

interface PrMetadata {
  readonly title: string;
  readonly body: string;
  readonly branch?: string;
}

const PrMetadataOutput = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  branch: Schema.optional(Schema.String),
});

export default defineWorkflow("implement-issue", {
  input: Input,
  output: Output,
  agent: { model: "opencode-go/glm-5.3-flash" },
  run: async (ctx, input) => {
    // Step 1: implement the issue in the prepared tree (cloned by the runtime).
    await ctx.agent(
      "implement",
      `You are working in a git checkout of a small bun/TypeScript package.

Implement GitHub issue #${input.issueNumber} in this repository. First run \`gh issue view ${input.issueNumber}\` to read the issue, then implement exactly what it asks for, with tests in the same style as the existing test file, so \`bun test\` passes for the new behaviour.

When done, stop — do not run git commands, do not commit, do not open a PR.`,
    );

    // Step 2: verify. Non-zero exit is a branch, not a throw.
    let testResult = await ctx.exec(["bun", "test"]);

    // Step 3: one fix attempt if the tests fail (plain async control flow).
    if (testResult.exitCode !== 0) {
      await ctx.agent(
        "fix",
        `You are working in the same git checkout as before, in a fresh session with no memory of the prior conversation. \`bun test\` is failing while implementing GitHub issue #${input.issueNumber}. Diagnose from the output below and fix it. Do not run git commands, do not commit.

STDOUT:
${testResult.stdout}

STDERR:
${testResult.stderr}`,
      );
      testResult = await ctx.exec(["bun", "test"]);
    }

    // Step 4: PR metadata via structured output — branch, title and body are
    // agent-supplied (D32).
    const metadata = await ctx.agent<PrMetadata>(
      "pr-metadata",
      `You are working in the same git checkout as before, in a fresh session. Read GitHub issue #${input.issueNumber} via \`gh issue view ${input.issueNumber}\` and the working tree changes to see what was implemented to close it.

Do not modify any files and do not run mutating git commands. Respond only with the requested JSON object: the git branch name this change should live on (lowercase words joined by hyphens, prefixed with factory/issue-${input.issueNumber}-), a concise, accurate PR title, and a short PR body (a couple of sentences plus a bullet list of what changed).`,
      {
        output: PrMetadataOutput,
      },
    );

    // Step 5: deterministic write-back — host git + gh, not an agent
    // instruction (D9). A branch collision is retried once with the runId
    // suffix by the runtime.
    const fallback = metadata.output ?? {
      title: `Implement issue #${input.issueNumber}`,
      body: "Automated PR from the factory sample workflow.",
      branch: `factory/issue-${input.issueNumber}`,
    };
    const writeBackResult = await ctx.writeBack({
      branch: fallback.branch ?? `factory/issue-${input.issueNumber}`,
      commitMessage: `Implement issue #${input.issueNumber}\n\nCloses #${input.issueNumber}.\n\nAutomated by the factory sample workflow.`,
      prTitle: fallback.title,
      prBody: fallback.body,
    });

    return {
      testExitCode: testResult.exitCode,
      prUrl: writeBackResult.prUrl,
      prBranch: writeBackResult.branch,
    };
  },
});
