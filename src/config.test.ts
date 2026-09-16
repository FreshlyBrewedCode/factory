import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  DEFAULT_MAX_CONCURRENT_RUNS,
  DEFAULT_RETAINED_WORKSPACES,
  DEFAULT_WORKSPACE_ROOT,
  defineConfig,
  type ScheduleConfigInput,
} from "./config";
import type { WorkflowDefinition } from "./workflow";

const ECHO_WORKFLOW = `${import.meta.dir}/../test/fixtures/echo-workflow.ts`;

function baseInput() {
  return {
    repo: {
      sshUrl: "git@github.com:acme/widgets.git",
      identity: { name: "Factory", email: "factory@acme.test" },
      baseBranch: "main",
      slug: "acme/widgets",
    },
    workflows: [] as ReadonlyArray<WorkflowDefinition>,
  };
}

describe("defineConfig (D27)", () => {
  test("carries the required repo + workflows keys through", () => {
    const config = defineConfig(baseInput());

    expect(config.repo.slug).toBe("acme/widgets");
    expect(config.repo.baseBranch).toBe("main");
    expect(config.workflows).toEqual([]);
  });

  test("workspaceRoot, maxConcurrentRuns and retainedWorkspaces have defaults", () => {
    const config = defineConfig(baseInput());

    expect(config.workspaceRoot).toBe(DEFAULT_WORKSPACE_ROOT);
    expect(config.maxConcurrentRuns).toBe(DEFAULT_MAX_CONCURRENT_RUNS);
    expect(config.retainedWorkspaces).toBe(DEFAULT_RETAINED_WORKSPACES);
    expect(config.repo).toBeDefined();
  });

  test("rejects maxConcurrentRuns below 1 (L5)", () => {
    expect(() => defineConfig({ ...baseInput(), maxConcurrentRuns: 0 })).toThrow(
      /maxConcurrentRuns must be an integer >= 1/,
    );
    expect(() => defineConfig({ ...baseInput(), maxConcurrentRuns: -1 })).toThrow(
      /maxConcurrentRuns/,
    );
    expect(() => defineConfig({ ...baseInput(), maxConcurrentRuns: 1.5 })).toThrow(
      /maxConcurrentRuns/,
    );
  });

  test("rejects retainedWorkspaces below maxConcurrentRuns with a clear error (L5)", () => {
    expect(() =>
      defineConfig({ ...baseInput(), maxConcurrentRuns: 3, retainedWorkspaces: 2 }),
    ).toThrow(/retainedWorkspaces \(2\) must be >= maxConcurrentRuns \(3\)/);
    expect(() =>
      defineConfig({ ...baseInput(), maxConcurrentRuns: 3, retainedWorkspaces: 3.5 }),
    ).toThrow(/retainedWorkspaces/);
  });

  test("the config's workflow array is the registry, enumerating by id", async () => {
    const { default: echo } = await import(ECHO_WORKFLOW);
    const config = defineConfig({ ...baseInput(), workflows: [echo as WorkflowDefinition] });
    expect(config.workflows.map((w) => w.id)).toEqual(["echo-test"]);
  });
});

describe("defineConfig schedules (issue #16)", () => {
  function baseWithWorkflow() {
    return {
      ...baseInput(),
      workflows: [
        {
          id: "issue-test",
          input: Schema.Struct({ issueNumber: Schema.Number }),
          output: undefined,
          agent: undefined,
          workspace: { kind: "clone" as const },
          run: async () => ({}),
        } as unknown as WorkflowDefinition,
      ],
    };
  }

  function scheduleInput(overrides: Partial<ScheduleConfigInput> = {}): ScheduleConfigInput {
    return {
      id: "nightly",
      workflow: "issue-test",
      input: { issueNumber: 12 },
      cron: "0 3 * * *",
      timezone: "UTC",
      ...overrides,
    };
  }

  test("carries schedules through with defaults applied", () => {
    const config = defineConfig({ ...baseWithWorkflow(), schedules: [scheduleInput()] });
    expect(config.schedules).toHaveLength(1);
    const schedule = config.schedules[0]!;
    expect(schedule).toMatchObject({
      id: "nightly",
      workflowId: "issue-test",
      input: { issueNumber: 12 },
      cron: "0 3 * * *",
      timezone: "UTC",
      overlap: "skip",
      runOnStart: false,
    });
  });

  test("schedules default to an empty list", () => {
    expect(defineConfig(baseWithWorkflow()).schedules).toEqual([]);
  });

  test("a schedule referencing an unregistered workflow fails at load, naming the schedule", () => {
    const config = {
      ...baseWithWorkflow(),
      schedules: [scheduleInput({ workflow: "noonexistent" })],
    };
    expect(() => defineConfig(config)).toThrow(
      /schedule "nightly" references workflow "noonexistent", which is not registered/,
    );
  });

  test("an invalid cron expression fails at load, naming the schedule", () => {
    const config = { ...baseWithWorkflow(), schedules: [scheduleInput({ cron: "not-a-cron" })] };
    expect(() => defineConfig(config)).toThrow(
      /schedule "nightly" has an invalid cron expression "not-a-cron"/,
    );
  });

  test("a named timezone parses, and a garbage zone fails at load", () => {
    const config = {
      ...baseWithWorkflow(),
      schedules: [scheduleInput({ timezone: "Europe/Berlin" })],
    };
    expect(defineConfig(config).schedules[0]!.timezone).toBe("Europe/Berlin");

    const broken = {
      ...baseWithWorkflow(),
      schedules: [scheduleInput({ timezone: "Not/AZone" })],
    };
    expect(() => defineConfig(broken)).toThrow(/schedule "nightly"/);
  });

  test("a schedule's input is validated against its workflow's schema at load", () => {
    const config = {
      ...baseWithWorkflow(),
      schedules: [scheduleInput({ input: { issueNumber: "twelve" } })],
    };
    expect(() => defineConfig(config)).toThrow(
      /schedule "nightly" has an input that fails workflow "issue-test"'s schema/,
    );
  });

  test("duplicate schedule ids fail at load", () => {
    const config = {
      ...baseWithWorkflow(),
      schedules: [scheduleInput(), scheduleInput()],
    };
    expect(() => defineConfig(config)).toThrow(/duplicate schedule id "nightly"/);
  });
});
