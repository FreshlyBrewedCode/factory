/**
 * The Ready sweep (issue #18) — the epic #19 end state: the wayful dispatch
 * script's board sweep as an ordinary scheduled wrapper workflow, replacing
 * the retired hardcoded dispatcher (`src/server/dispatch.ts`,
 * `src/server/ready-source.ts`).
 *
 * It runs on a **scratch** workspace and never clones the repo — it only
 * reads the project board over the GraphQL API and dispatches child runs,
 * so a full mirror refresh + clone per tick would be pure overhead (D37).
 *
 * Ported working knowledge, not a rewrite (wayful's
 * `scripts/dispatch-ready-issues.sh`):
 *
 * - The GraphQL query and its ordering (`orderBy: {field: POSITION,
 *   direction: ASC}` — the board's own top-to-bottom column order) come
 *   over verbatim (`fieldValueByName(name: "Status")`, `blockedBy(first:
 *   20)` walking GitHub's native issue-dependencies edges).
 * - The blocker rule also comes over: only an open blocker with **no**
 *   linked PR whose state is OPEN or MERGED is a hard block. The PR need
 *   not be merged — a merged PR whose issue is still open means the work
 *   landed and the issue just hasn't been closed, which is not grounds to
 *   hold the dependent back. (GitHub only auto-links a closing keyword when
 *   the PR targets the default branch; stacked PRs must be linked
 *   explicitly or they will not show up here.)
 * - What differs: there is no claim. The wayful script's "move to In
 *   Progress" — and the retired dispatcher's port of it — is replaced by a
 *   **per-issue dedupe key** on each dispatched child (`issue:<n>`, D40).
 *   While a child run is non-terminal, a second sweep hitting the same item
 *   collides — the collision is recorded and the sweep run fails visibly
 *   rather than silently dropping.
 *
 * Repeated dispatch of an item whose child has *finished* is deliberate
 * reduced to the board's own word: without the claim, the contract is
 * "retried each tick until it succeeds or the item is taken off the Ready
 * column" (issue #18's explicit non-parity with per-issue failure backoff).
 *
 * Collisions throw into the run (the epic's dispatch decision, D39/D40) —
 * they are recorded per item, the rest of the sweep still dispatches, and
 * the run then fails with a summary naming every key. A wrapper whose
 * dispatches are quietly dropped is indistinguishable from one that isn't
 * running; visible failure is the point of the UI.
 */

import implementIssue from "./implement-issue.ts";
import { DedupeKeyError, defineWorkflow, Schema } from "@frebreco/factory";

const Input = Schema.Struct({
  /** The project board's owner (a user login — the wayful query's `user(login:)`). */
  owner: Schema.String,
  /** The project board's number. */
  projectNumber: Schema.Int,
});

const Output = Schema.Struct({
  dispatched: Schema.Array(
    Schema.Struct({
      issueNumber: Schema.Int,
      childRunId: Schema.String,
    }),
  ),
});

interface GraphqlBlocker {
  readonly number: number;
  readonly state: string;
  readonly closedByPullRequestsReferences: {
    readonly nodes: ReadonlyArray<{ readonly state: string }>;
  };
}

interface GraphqlItem {
  readonly id: string;
  readonly fieldValueByName: { readonly name: string } | null;
  readonly content: {
    readonly __typename: string;
    readonly number?: number;
    readonly title?: string;
    readonly blockedBy?: { readonly nodes: ReadonlyArray<GraphqlBlocker> };
  };
}

// Ported verbatim from wayful's dispatch script (`ready_items=$(gh api
// graphql ...)`), whose ordering and edge walks are real working knowledge:
// POSITION is the column's manual ordering; blockedBy(first: 20) lists
// native issue-dependency edges; closedByPullRequestsReferences(first: 10)
// carries each blocker's linked PR states (OPEN and MERGED both count).
const READY_ITEMS_QUERY = `
  query($owner: String!, $number: Int!) {
    user(login: $owner) {
      projectV2(number: $number) {
        items(first: 100, orderBy: {field: POSITION, direction: ASC}) {
          nodes {
            id
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
            content {
              __typename
              ... on Issue {
                number
                title
                blockedBy(first: 20) {
                  nodes {
                    number
                    state
                    closedByPullRequestsReferences(first: 10) { nodes { state } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/** Same rule as the wayful script: OPEN blockers whose work has no linked PR yet. */
function hardBlockedBy(blockers: ReadonlyArray<GraphqlBlocker>): ReadonlyArray<number> {
  return blockers
    .filter((b) => b.state === "OPEN")
    .filter(
      (b) =>
        !b.closedByPullRequestsReferences.nodes.some(
          (pr) => pr.state === "OPEN" || pr.state === "MERGED",
        ),
    )
    .map((b) => b.number);
}

export default defineWorkflow("ready-sweep", {
  input: Input,
  output: Output,
  workspace: { kind: "scratch" },
  run: async (ctx, input) => {
    const query = `query=${READY_ITEMS_QUERY}`;
    const apiResult = await ctx.exec([
      "gh",
      "api",
      "graphql",
      "-f",
      query,
      "-f",
      `owner=${input.owner}`,
      "-F",
      `number=${String(input.projectNumber)}`,
    ]);

    if (apiResult.exitCode !== 0) {
      throw new Error(
        `gh api graphql (list ready items) failed: ${apiResult.stderr.trim() || "(no stderr)"}`,
      );
    }

    const parsed = JSON.parse(apiResult.stdout) as {
      readonly data: {
        readonly user: {
          readonly projectV2: { readonly items: { readonly nodes: ReadonlyArray<GraphqlItem> } };
        };
      };
    };

    const readyItems: Array<{
      readonly issueNumber: number;
      readonly title: string;
      readonly hardBlockedBy: ReadonlyArray<number>;
    }> = [];
    for (const node of parsed.data.user.projectV2.items.nodes) {
      if (node.content.__typename !== "Issue") continue;
      if (node.fieldValueByName?.name !== "Ready") continue;
      if (node.content.number === undefined) continue;
      readyItems.push({
        issueNumber: node.content.number,
        title: node.content.title ?? "",
        hardBlockedBy: hardBlockedBy(node.content.blockedBy?.nodes ?? []),
      });
    }

    await ctx.log("ready-items", {
      owner: input.owner,
      projectNumber: input.projectNumber,
      readyCount: readyItems.length,
      items: readyItems.map((item) => ({ issueNumber: item.issueNumber, title: item.title })),
    });

    const dispatches: Array<{ issueNumber: number; childRunId: string }> = [];
    const collisions: Array<{ readonly key: string; readonly holderRunId: string }> = [];

    for (const item of readyItems) {
      if (item.hardBlockedBy.length > 0) {
        await ctx.log("skipped-blocked", {
          issueNumber: item.issueNumber,
          hardBlockedBy: item.hardBlockedBy.map((n) => `#${n}`),
        });
        continue;
      }

      const dedupeKey = `issue:${item.issueNumber}`;
      try {
        const childRunId = await ctx.dispatch(
          implementIssue,
          { issueNumber: item.issueNumber },
          {
            dedupeKey,
          },
        );
        await ctx.log("dispatched", { issueNumber: item.issueNumber, childRunId });
        dispatches.push({ issueNumber: item.issueNumber, childRunId });
      } catch (err) {
        // A collision is never a silent no-op (the epic's dispatch decision):
        // the runtime records `DispatchCollision` on this run's log either
        // way; recorded here too, the remaining items still dispatch, and the
        // run fails with the summary below instead of quietly dropping.
        if (err instanceof DedupeKeyError) {
          collisions.push({ key: err.key, holderRunId: err.holderRunId });
          continue;
        }
        throw err;
      }
    }

    if (collisions.length > 0) {
      const keys = collisions.map((c) => c.key).join(", ");
      const holders = collisions.map((c) => c.holderRunId).join(", ");
      await ctx.log("collision-summary", { collisions });
      throw new Error(
        `${collisions.length} dispatch collision(s) (in-flight child run(s) still hold ` +
          `their dedupe key(s)): ${keys} — held by ${holders}. No second run was started; ` +
          `nothing is silently dropped.`,
      );
    }

    return { dispatched: dispatches };
  },
});
