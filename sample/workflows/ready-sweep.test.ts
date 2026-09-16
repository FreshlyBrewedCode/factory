/**
 * Issue #18: the Ready sweep moves from a hardcoded dispatcher into an
 * ordinary scheduled wrapper workflow. These tests pin the ported logic at
 * the workflow-authoring seam — the sweep is a plain `async` function over
 * `ctx`, so a fake executor and a fake dispatch service stand in for `gh`
 * and the daemon; the runtime's ownership of `RunDispatched` /
 * `DispatchCollision` emission is already covered by the src/ suites
 * (`workflow.dispatch.test.ts`, `nested-runs.test.ts`, `dedupe.test.ts`).
 * The board knowledge itself — the GraphQL query and the hard-blocker rule —
 * is ported from wayful's `dispatch-ready-issues.sh` and validated live
 * against the real project board (docs/findings/12-ready-sweep-live-leg.md).
 */

import { describe, expect, test } from "bun:test";
import { DedupeKeyError } from "@frebreco/factory";
import readySweep from "./ready-sweep.ts";

interface ExecCall {
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
}

interface DispatchCall {
  readonly issueNumber: number;
  readonly dedupeKey: string | undefined;
}

interface SweepHarness {
  readonly execCalls: Array<ExecCall>;
  readonly dispatches: Array<DispatchCall>;
  readonly logs: Array<{ readonly name: string; readonly data: unknown }>;
  readonly run: (input: { readonly owner: string; readonly projectNumber: number }) => Promise<{
    outcome: string;
    error?: string;
    output?: unknown;
  }>;
}

function ghResponse(items: ReadonlyArray<unknown>): string {
  return JSON.stringify({ data: { user: { projectV2: { items: { nodes: items } } } } });
}

function readyItem(
  number: number,
  opts?: {
    readonly status?: string;
    readonly blockers?: ReadonlyArray<{
      readonly number: number;
      readonly state: string;
      readonly prStates?: ReadonlyArray<string>;
    }>;
  },
): Record<string, unknown> {
  return {
    id: `PVTI_item${number}`,
    fieldValueByName: {
      name: opts?.status ?? "Ready",
    },
    content: {
      __typename: "Issue",
      number,
      title: `issue ${number}`,
      blockedBy: {
        nodes: (opts?.blockers ?? []).map((b) => ({
          number: b.number,
          state: b.state,
          closedByPullRequestsReferences: {
            nodes: (b.prStates ?? []).map((state) => ({ state })),
          },
        })),
      },
    },
  };
}

function harness(
  exec: { readonly stdout?: string; readonly exitCode?: number } = { stdout: ghResponse([]) },
  heldKeys: ReadonlyArray<string> = [],
): SweepHarness {
  const execCalls: Array<ExecCall> = [];
  const dispatches: Array<DispatchCall> = [];
  const logs: Array<{ name: string; data: unknown }> = [];
  const held = new Set(heldKeys);

  const run = async (input: { readonly owner: string; readonly projectNumber: number }) => {
    try {
      const output = await readySweep.run(
        {
          dir: "/scratch/nowhere",
          exec: async (argv) => {
            execCalls.push({ command: argv, cwd: "scratch" });
            if (exec.exitCode === 1) {
              return { command: argv[0]!, exitCode: 1, stdout: "", stderr: "gh: no auth" };
            }
            return {
              command: argv[0]!,
              exitCode: 0,
              stdout: exec.stdout ?? "",
              stderr: "",
            };
          },
          log: async (name, data) => {
            logs.push({ name, data });
          },
          assert: async () => ({ name: "unused", pass: true, details: null }),
          writeBack: async () => {
            throw new Error("scratch has no write-back");
          },
          agent: async () => {
            throw new Error("not used");
          },
          dispatch: async (_child, rawInput, opts) => {
            const input_ = rawInput as { issueNumber: number };
            const key = opts?.dedupeKey ?? "";
            if (held.has(key)) throw new DedupeKeyError(key, `run-holder-${key}`);
            dispatches.push({ issueNumber: input_.issueNumber, dedupeKey: key });
            return `run-child-issue-${input_.issueNumber}`;
          },
        },
        input,
      );
      return { outcome: "completed", output };
    } catch (err) {
      return {
        outcome: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  return { execCalls, dispatches, logs, run };
}

// -- the tests ----------------------------------------------------------------

describe("ready-sweep (issue #18)", () => {
  const input = { owner: "FreshlyBrewedCode", projectNumber: 4 };

  test("is a scratch-workspace wrapper — it never clones the repo", () => {
    expect(readySweep.workspace.kind).toBe("scratch");
  });

  test("dispatches exactly one child per eligible Ready issue, in board order, with a per-issue dedupe key", async () => {
    const board = harness({
      stdout: ghResponse([
        readyItem(1),
        readyItem(11),
        readyItem(12, { blockers: [{ number: 9, state: "OPEN" }] }),
        readyItem(13, {
          blockers: [{ number: 9, state: "OPEN", prStates: ["OPEN"] }],
        }),
        readyItem(14, { status: "In Progress" }),
      ]),
    });

    const result = await board.run(input);
    expect(result.outcome).toBe("completed");

    // Board order (POSITION ASC as the fixture provides it), over the
    // eligible set: 1 is unblocked, 13's only open blocker has a linked OPEN
    // PR (soft blocker) and 12's has none — exactly the wayful script's rule.
    expect(board.dispatches.map((d) => d.issueNumber)).toEqual([1, 11, 13]);
    expect(board.dispatches.map((d) => d.dedupeKey)).toEqual(["issue:1", "issue:11", "issue:13"]);
  });

  test("non-Issue content and non-Ready statuses never dispatch", async () => {
    const nodes: ReadonlyArray<unknown> = [
      {
        id: "PVTI_draft",
        fieldValueByName: { name: "Ready" },
        content: { __typename: "DraftIssue", title: "a draft" },
      },
      readyItem(21),
      {
        id: "PVTI_empty_status",
        fieldValueByName: null,
        content: { __typename: "Issue", number: 22, title: "no status" },
      },
    ];
    const board = harness({ stdout: ghResponse(nodes) });
    const result = await board.run(input);
    expect(result.outcome).toBe("completed");
    expect(board.dispatches.map((d) => d.issueNumber)).toEqual([21]);
  });

  test("two consecutive ticks over the same Ready item dispatch it exactly once", async () => {
    const item = [readyItem(7)];

    const first = await harness({ stdout: ghResponse(item) }).run(input);
    expect(first.outcome).toBe("completed");

    // A child run that is still non-terminal holds its dedupe key; the next
    // sweep hits the collision — recorded, visible, and *not* a second
    // dispatch of the same issue.
    const secondBoard = harness({ stdout: ghResponse(item) }, ["issue:7"]);
    const second = await secondBoard.run(input);
    expect(second.outcome).toBe("failed");
    expect(second.error).toContain("issue:7");
    expect(secondBoard.dispatches).toHaveLength(0);
  });

  test("a hard-blocked item is skipped with its blocker explained in the log", async () => {
    const board = harness({
      stdout: ghResponse([
        readyItem(30, { blockers: [{ number: 28, state: "OPEN" }] }),
        readyItem(31, {
          blockers: [
            { number: 28, state: "OPEN" },
            { number: 29, state: "OPEN", prStates: ["MERGED"] },
          ],
        }),
      ]),
    });
    const result = await board.run(input);
    expect(result.outcome).toBe("completed");
    expect(board.dispatches).toHaveLength(0);

    const logged = JSON.stringify(board.logs);
    expect(logged).toContain("#28");
    expect(logged).toContain("30");
  });

  test("a closed blocker never blocks — only OPEN blockers with no linked PR do", async () => {
    const board = harness({
      stdout: ghResponse([
        readyItem(40, { blockers: [{ number: 39, state: "CLOSED" }] }),
        readyItem(41, {
          blockers: [{ number: 42, state: "OPEN", prStates: ["MERGED"] }],
        }),
      ]),
    });
    const result = await board.run(input);
    expect(result.outcome).toBe("completed");
    expect(board.dispatches.map((d) => d.issueNumber)).toEqual([40, 41]);
  });

  test("degrades visibly when the GraphQL query fails", async () => {
    const board = harness({ exitCode: 1 });
    const result = await board.run(input);
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("gh api graphql");
  });
});
