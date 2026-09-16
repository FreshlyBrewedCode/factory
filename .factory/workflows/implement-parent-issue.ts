/**
 * The multi-issue round trip: implement a GitHub parent issue *and all of its
 * sub-issues* in one run. Same authoring surface as `implement-issue.ts` (plain
 * async control flow over `ctx`, no step graph) but with a loop at its core:
 *
 *   find-next (agent, structured output) → implement (agent) → ship (agent)
 *   → repeat until the finder reports nothing left to do
 *
 * Deliberately NOT using `ctx.writeBack` (D9's demotion trigger: this is the
 * second shape the writeBack border case was reserved for). Branching,
 * committing, pushing and `gh pr create` are the ship step's own job — the
 * agent owns them here, because each sub-issue's PR is created mid-run (not
 * once, at the end), which `writeBack`'s single-write shape doesn't cover.
 *
 * Inputs: the parent issue number and an optional `model` override, forwarded
 * as the per-call model for every agent step (run.ts's precedence:
 * per-call > workflow default > runtime fallback).
 *
 * Output: the array of pull requests the loop opened, `{ issueNumber, prUrl,
 * branch }` per sub-issue served.
 */

import { defineWorkflow, Schema, type AgentCallOptions } from "@frebreco/factory";

const DEFAULT_MODEL = "omniroute/opencode-go/glm-5.3-flash";

const NextIssueOutput = Schema.Struct({
  /** The sub-issue to work on next, or null when every sub-issue is served/blockered. */
  issueNumber: Schema.NullOr(Schema.Int),
});

const ShipOutput = Schema.Struct({
  prUrl: Schema.String,
  branch: Schema.String,
});

const PullRequest = Schema.Struct({
  issueNumber: Schema.Int,
  prUrl: Schema.String,
  branch: Schema.String,
});

const Input = Schema.Struct({
  parentIssueNumber: Schema.Int,
  model: Schema.optional(Schema.String),
});

const Output = Schema.Struct({
  prs: Schema.Array(PullRequest),
});

const findNextPrompt = (
  parentIssueNumber: number,
  attemptDone: ReadonlyArray<number>,
) => `
This is a non-interactive session.
You are a dispatcher working in a git checkout of a GitHub repository. \`gh\` and \`git\` are authenticated.

Parent issue: #${parentIssueNumber}. Your only job is to decide which sub-issue of that parent should be worked on NEXT, or that none should.

Read the parent and discover its sub-issues (the parent's body, \`gh issue view ${parentIssueNumber}\`, plus \`gh issue view <n>\` on each candidate; combine with what the issue's task list / dependency relationships state). For each candidate sub-issue figure out, using \`gh\`:

1. Whether an open pull request already closes it (check open PRs' bodies for "Closes #<n>", and \`gh pr list\`). A sub-issue with an open PR counts as done — its PR exists even if unmerged, and MERGING it is what unblocks issues depending on it; you skip it either way.
2. Whether it is blocked by an unserved sub-issue: a "blocked by"/"depends on" relationship pointing at a sub-issue that has neither an open PR nor a merged one, and has not been implemented in this run yet.

Then pick the best next sub-issue: one that is not already served by a PR, whose blockers are all satisfied (or has none), preferring the one that would unblock the most other sub-issues.

Already handled in this run, so exclude them: ${attemptDone.length > 0 ? attemptDone.map((n) => `#${n}`).join(", ") : "(none yet)"}.

If no sub-issue is eligible — every sub-issue has a PR, is unimplementable, or the parent has no sub-issues left — return issueNumber: null. `;

const implementPrompt = (
  parentIssueNumber: number,
  issueNumber: number,
) => `
This is a non-interactive session.
You are working in a git checkout of the repository. Implement GitHub sub-issue #${issueNumber}, one of the sub-issues of parent issue #${parentIssueNumber}.

- Check-out a new branch for your work
  - if your issue is based on another (unmerged) issue, base your branch on it
- Implement using tdd
- Use atomic commits along the way
- Validate your work. Do not just assume your implementation works.
- Do not create a PR yet
- In your final response, briefly describe:
  - what was done
  - how was it validated (evidence)
  - what issues did you encounter along the way
`;

const shipPrompt = (
  parentIssueNumber: number,
  issueNumber: number,
  implementReport: string,
) => `
This is a non-interactive session.
The working tree contains the implementation of GitHub sub-issue #${issueNumber} (a sub-issue of parent issue #${parentIssueNumber}), commited, and checkout out on a seperate branch.
Your only job is to ship that work as a pull request.

The implementer provided the following report:
${implementReport}

---

- Push the branch
- Create a PR
  - use conventional commit formatting for the PR title
  - include "closes <ISSUE_NUMBER>"
  - include a section describing the user-facing change (i.e. like a changelog)
    - if possible, include a <details> block with most relevant before and after examples
      - ui: screenshots
      - cli: example output
  - if the issue is dependant on other isses with open PRs: create a stacked PR using /gh-stack
  - if the PR does not target main, link it to the issue explicitly (see below)

## Linking a stacked PR to its issue

GitHub only honours the closes #{{ISSUE_NUMBER}} keyword when the PR targets the
default branch. A stacked PR targeting another branch stays unlinked, and the
dispatcher will treat every issue that depends on this one as still blocked. So
after creating a PR whose base is not main, link it explicitly:

# $PR is the new pull request number
gh api graphql -f query='
  mutation($issue: ID!, $prs: [ID!]!) {
    addCloseIssueReferences(input: {issueId: $issue, pullRequestIds: $prs}) {
      issue { number closedByPullRequestsReferences(first: 10) { nodes { number state } } }
    }
  }' \
  -f issue="$(gh issue view {{ISSUE_NUMBER}} --json id --jq .id)" \
  -f prs="$(gh pr view "$PR" --json id --jq .id)"

The mutation takes node IDs, not numbers, which is what the two gh sub-shells
resolve. It works regardless of base branch. Check the returned
closedByPullRequestsReferences contains the PR — that is the same field the
dispatcher reads. Keep the closes <ISSUE_NUMBER> line in the body as well,
so the issue still closes automatically once the stack lands on main.

To undo a link, use removeCloseIssueReferences with the same inputs. It only
works while the issue is open.
`;

const agentOpts = (input: { readonly model?: string }): AgentCallOptions => ({
  model: input.model ?? DEFAULT_MODEL,
});

export default defineWorkflow("implement-parent-issue", {
  input: Input,
  output: Output,
  run: async (ctx, input) => {
    const opts = agentOpts(input);
    const prs: Array<{ issueNumber: number; prUrl: string; branch: string }> = [];
    const attempted: Array<number> = [];

    for (;;) {
      // Step 1: the finder picks the next serving-able sub-issue (or null).
      const finder = await ctx.agent<{ issueNumber?: number | null }>(
        "find-next-issue",
        findNextPrompt(input.parentIssueNumber, attempted),
        { output: NextIssueOutput, ...opts },
      );

      const issueNumber = finder.output?.issueNumber ?? null;
      if (issueNumber === null) break;

      // Glitch guard: the finder re-selected an issue this run already shipped.
      if (attempted.includes(issueNumber)) {
        await ctx.log("find-next-repeat", {
          parentIssueNumber: input.parentIssueNumber,
          repeatedIssueNumber: issueNumber,
          attempted,
        });
        break;
      }
      attempted.push(issueNumber);

      // Step 2: implementation. A fresh session, working in the same tree.
      const implementer = await ctx.agent("implement", implementPrompt(input.parentIssueNumber, issueNumber), opts);

      // Step 3: ship — the agent owns git/gh here (no ctx.writeBack).
      const ship = await ctx.agent<{ prUrl?: string; branch?: string }>(
        "ship-pr",
        shipPrompt(input.parentIssueNumber, issueNumber, implementer.finalText),
        { output: ShipOutput, ...opts },
      );

      if (
        ship.output === undefined ||
        ship.output.prUrl === undefined ||
        ship.output.branch === undefined
      ) {
        await ctx.log("ship-pr-fallback", {
          subIssueNumber: issueNumber,
          finalText: ship.finalText,
        });
        break;
      }

      prs.push({
        issueNumber,
        prUrl: ship.output.prUrl,
        branch: ship.output.branch,
      });
    }

    return { prs };
  },
});
