/**
 * ADR 0013 §2's resolution rule, as a table. Levels are most specific first:
 * call, run (request or schedule), workflow; the config rung is `defaults`.
 */

import { describe, expect, test } from "bun:test";
import {
  AgentChoiceError,
  DEFAULT_AGENT,
  resolveAgentChoice,
  type AgentChoice,
  type AgentDefaults,
  type ResolvedAgent,
} from "./agent-choice";
import type { AgentCallOptions, WorkflowAgentDefaults } from "../workflow";

const CONFIG: AgentDefaults = {
  default: "claude",
  models: { claude: "sonnet", opencode: "opencode/big-pickle" },
};

interface Row {
  readonly name: string;
  readonly call?: AgentChoice;
  readonly run?: AgentChoice;
  readonly workflow?: AgentChoice;
  readonly defaults?: AgentDefaults;
  readonly expected: ResolvedAgent | RegExp;
}

const ROWS: ReadonlyArray<Row> = [
  {
    name: "nothing named: config default agent and its model",
    expected: { agent: "claude", model: "sonnet" },
  },
  {
    name: "a model with no agent anywhere applies to the default agent",
    workflow: { model: "opus" },
    expected: { agent: "claude", model: "opus" },
  },
  {
    name: "the most specific model wins when no level names an agent",
    call: { model: "haiku" },
    run: { model: "opus" },
    workflow: { model: "sonnet-4" },
    expected: { agent: "claude", model: "haiku" },
  },
  {
    name: "the call's agent wins over the workflow's",
    call: { agent: "opencode" },
    workflow: { agent: "claude" },
    expected: { agent: "opencode", model: "opencode/big-pickle" },
  },
  {
    name: "a model below the level that changed the agent does not carry across",
    call: { agent: "opencode" },
    workflow: { model: "sonnet" },
    expected: { agent: "opencode", model: "opencode/big-pickle" },
  },
  {
    name: "a model below the chooser is dropped even when it is the run's",
    call: { agent: "opencode" },
    run: { agent: "claude", model: "opus" },
    expected: { agent: "opencode", model: "opencode/big-pickle" },
  },
  {
    name: "the chooser's own model applies",
    workflow: { agent: "opencode", model: "opencode/other" },
    expected: { agent: "opencode", model: "opencode/other" },
  },
  {
    name: "a model above the chooser applies to the chosen agent",
    call: { model: "opencode/fast" },
    workflow: { agent: "opencode", model: "opencode/other" },
    expected: { agent: "opencode", model: "opencode/fast" },
  },
  {
    name: "the run level chooses the agent over the workflow's",
    run: { agent: "opencode" },
    workflow: { agent: "claude", model: "opus" },
    expected: { agent: "opencode", model: "opencode/big-pickle" },
  },
  {
    name: "the run level's model applies to the workflow's agent",
    run: { model: "opus" },
    workflow: { agent: "claude", model: "sonnet" },
    expected: { agent: "claude", model: "opus" },
  },
  {
    name: "a call naming the same agent as the workflow still drops the workflow's model",
    call: { agent: "claude" },
    workflow: { agent: "claude", model: "opus" },
    expected: { agent: "claude", model: "sonnet" },
  },
  {
    name: "no model for the chosen agent fails, naming the agent and the config key",
    call: { agent: "opencode" },
    defaults: { default: "claude", models: { claude: "sonnet" } },
    expected: /no model for agent "opencode".*agent\.models\.opencode/,
  },
  {
    name: "no config at all: the built-in default agent, and no model",
    defaults: { default: DEFAULT_AGENT, models: {} },
    expected: /no model for agent "opencode"/,
  },
  {
    name: "no config, but the workflow names a model",
    workflow: { model: "opencode/big-pickle" },
    defaults: { default: DEFAULT_AGENT, models: {} },
    expected: { agent: "opencode", model: "opencode/big-pickle" },
  },
  {
    name: "an unknown agent fails",
    call: { agent: "codex" as never },
    expected: /unknown agent "codex"; expected one of claude, opencode/,
  },
];

describe("resolveAgentChoice (ADR 0013 §2)", () => {
  for (const row of ROWS) {
    test(row.name, () => {
      const resolve = () =>
        resolveAgentChoice([row.call, row.run, row.workflow], row.defaults ?? CONFIG);
      if (row.expected instanceof RegExp) {
        expect(resolve).toThrow(AgentChoiceError);
        expect(resolve).toThrow(row.expected);
      } else {
        expect(resolve()).toEqual(row.expected);
      }
    });
  }
});

describe("what ADR 0013 removed", () => {
  test("there is no built-in model: DEFAULT_MODEL is gone (#40)", async () => {
    const run = await import("./run");
    expect("DEFAULT_MODEL" in run).toBe(false);
  });

  test("permissionMode is not an agent option (#39): every ask is answered by the runtime", () => {
    // Type-level: these fail `bun run typecheck` if the field comes back.
    // @ts-expect-error permissionMode was removed from AgentCallOptions
    const call: AgentCallOptions = { permissionMode: "acceptEdits" };
    // @ts-expect-error permissionMode was removed from WorkflowAgentDefaults
    const defaults: WorkflowAgentDefaults = { permissionMode: "default" };
    expect([call, defaults]).toHaveLength(2);
  });
});
