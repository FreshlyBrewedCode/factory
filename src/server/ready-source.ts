/**
 * D23: the dispatcher's pluggable source of "what's ready to run". Ported
 * from `wayful/scripts/dispatch-ready-issues.sh`'s GraphQL query and
 * claim-via-status-edit, adapted to Factory's shape:
 *
 * - `listReady` returns every Project item in Status=Ready, with the same
 *   soft/hard blocker distinction as the wayful script (an open blocker with
 *   an OPEN-or-MERGED linked PR doesn't hard-block; `hardBlockedBy` is what
 *   `reconcileOnce` filters on).
 * - `claim` is the wayful script's `gh project item-edit --single-select-
 *   option-id <In Progress>` call. A failed claim (exit != 0) is the same
 *   signal the script treats as "WIP limit or race, skip" — Factory has no
 *   separate lock beyond this project-field write.
 *
 * `makeFakeReadySource` exists for `dispatch.test.ts`: no live `gh` calls,
 * deterministic claim results, mirroring the corpus-replay-adapter and
 * `ExecFn`-injection testing patterns already used elsewhere.
 */

import type { ExecFn } from "../lib/writeback";

export interface ReadyItem {
  readonly issueNumber: number;
  readonly itemId: string;
  readonly title: string;
  /** Open native blockers with no OPEN-or-MERGED linked PR yet. */
  readonly hardBlockedBy: ReadonlyArray<number>;
}

export interface ReadySource {
  listReady(): Promise<ReadonlyArray<ReadyItem>>;
  /** `false` means the claim lost a race or the WIP limit rejected it — not an error. */
  claim(item: ReadyItem): Promise<boolean>;
}

export interface GitHubProjectsConfig {
  readonly owner: string;
  readonly projectNumber: number;
  readonly projectId: string;
  readonly statusFieldId: string;
  readonly inProgressOptionId: string;
}

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

export function makeGitHubProjectsSource(config: GitHubProjectsConfig, exec: ExecFn): ReadySource {
  return {
    async listReady(): Promise<ReadonlyArray<ReadyItem>> {
      const result = await exec([
        "gh",
        "api",
        "graphql",
        "-f",
        `query=${READY_ITEMS_QUERY}`,
        "-f",
        `owner=${config.owner}`,
        "-F",
        `number=${config.projectNumber}`,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`gh api graphql (list ready items) failed: ${result.stderr.trim()}`);
      }

      const parsed = JSON.parse(result.stdout) as {
        readonly data: {
          readonly user: {
            readonly projectV2: { readonly items: { readonly nodes: ReadonlyArray<GraphqlItem> } };
          };
        };
      };

      const ready: Array<ReadyItem> = [];
      for (const node of parsed.data.user.projectV2.items.nodes) {
        if (node.content.__typename !== "Issue") continue;
        if (node.fieldValueByName?.name !== "Ready") continue;
        if (node.content.number === undefined) continue;

        ready.push({
          issueNumber: node.content.number,
          itemId: node.id,
          title: node.content.title ?? "",
          hardBlockedBy: hardBlockedBy(node.content.blockedBy?.nodes ?? []),
        });
      }
      return ready;
    },

    async claim(item: ReadyItem): Promise<boolean> {
      const result = await exec([
        "gh",
        "project",
        "item-edit",
        "--project-id",
        config.projectId,
        "--id",
        item.itemId,
        "--field-id",
        config.statusFieldId,
        "--single-select-option-id",
        config.inProgressOptionId,
      ]);
      return result.exitCode === 0;
    },
  };
}

export interface FakeReadySource extends ReadySource {
  readonly claimedItemIds: ReadonlyArray<string>;
  readonly claimShouldFailFor: Set<string>;
}

/**
 * Deterministic in-memory source for `dispatch.test.ts` — no live `gh` calls.
 * A successful claim removes the item from subsequent `listReady` results,
 * mirroring the real source: claiming moves the project item's Status off
 * "Ready", so it stops matching the live GraphQL query too.
 */
export function makeFakeReadySource(items: ReadonlyArray<ReadyItem>): FakeReadySource {
  const claimedItemIds: Array<string> = [];
  const claimShouldFailFor = new Set<string>();

  return {
    claimedItemIds,
    claimShouldFailFor,
    async listReady() {
      return items.filter((item) => !claimedItemIds.includes(item.itemId));
    },
    async claim(item) {
      if (claimShouldFailFor.has(item.itemId) || claimedItemIds.includes(item.itemId)) return false;
      claimedItemIds.push(item.itemId);
      return true;
    },
  };
}
