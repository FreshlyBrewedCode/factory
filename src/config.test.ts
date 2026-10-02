import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  DEFAULT_MAX_CONCURRENT_RUNS,
  DEFAULT_RETAINED_WORKSPACES,
  DEFAULT_SCHEDULE_TIMEZONE,
  DEFAULT_WORKSPACE_ROOT,
  configuredAgents,
  defineConfig,
  type ScheduleConfigInput,
} from "./config";
import { defineSchedule } from "./config";
import type { ScheduleDefinition } from "./config";
import { defineWorkflow, type WorkflowDefinition } from "./workflow";

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

  test("a schedule without a timezone defaults to the system's zone", () => {
    const config = defineConfig({
      ...baseWithWorkflow(),
      schedules: [scheduleInput({ timezone: undefined })],
    });
    expect(config.schedules[0]!.timezone).toBe(DEFAULT_SCHEDULE_TIMEZONE);
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

describe("defineSchedule", () => {
  const ISSUE_WORKFLOW = defineWorkflow("issue-test", {
    input: Schema.Struct({ issueNumber: Schema.Number }),
    run: async () => ({}),
  });

  function scheduleDef(
    overrides: Partial<
      Pick<
        ScheduleDefinition<never>,
        "id" | "cron" | "timezone" | "overlap" | "runOnStart" | "agent"
      >
    > = {},
  ) {
    return defineSchedule(ISSUE_WORKFLOW, {
      id: "nightly",
      input: { issueNumber: 12 },
      cron: "0 3 * * *",
      timezone: "UTC",
      ...overrides,
    });
  }

  test("carries the workflow definition itself, not its id", () => {
    const schedule = scheduleDef();
    expect(schedule.workflow).toBe(ISSUE_WORKFLOW);
    expect(schedule.id).toBe("nightly");
    expect(schedule.input).toEqual({ issueNumber: 12 });
    expect(schedule.cron).toBe("0 3 * * *");
  });

  test("defineConfig accepts a definition and normalizes it like the plain form", () => {
    const withWorkflow = { ...baseInput(), workflows: [ISSUE_WORKFLOW as WorkflowDefinition] };
    expect(defineConfig({ ...withWorkflow, schedules: [scheduleDef()] }).schedules).toEqual(
      defineConfig({
        ...withWorkflow,
        schedules: [
          {
            id: "nightly",
            workflow: "issue-test",
            input: { issueNumber: 12 },
            cron: "0 3 * * *",
            timezone: "UTC",
          },
        ],
      }).schedules,
    );
  });

  test("a schedule definition whose workflow is not registered fails at load", () => {
    expect(() => defineConfig({ ...baseInput(), schedules: [scheduleDef()] })).toThrow(
      /schedule "nightly" references workflow "issue-test", which is not registered/,
    );
  });

  test("a schedule definition's input is still validated against the schema at load", () => {
    const withWorkflow = { ...baseInput(), workflows: [ISSUE_WORKFLOW as WorkflowDefinition] };
    expect(() =>
      defineConfig({
        ...withWorkflow,
        schedules: [
          defineSchedule(ISSUE_WORKFLOW, {
            id: "nightly",
            input: { issueNumber: "twelve" as never },
            cron: "0 3 * * *",
            timezone: "UTC",
          }),
        ],
      }),
    ).toThrow(/schedule "nightly" has an input that fails workflow "issue-test"'s schema/);
  });

  // Not invoked — the marked compile error at the bottom of the file is the assertion.
  test("defineSchedule infers the input type from the workflow definition", () => {
    typeCheckScheduleDefinition(ISSUE_WORKFLOW);
  });
});

const TYPED_WORKFLOW = defineWorkflow("issue-typed", {
  input: Schema.Struct({ issueNumber: Schema.Number }),
  run: async () => ({}),
});

// Not invoked — the marked compile error is the assertion.
export function typeCheckScheduleDefinition(workflow: typeof TYPED_WORKFLOW): void {
  defineSchedule(workflow, {
    id: "typed",
    // @ts-expect-error defineSchedule type-checks the input against the workflow's schema
    input: { issueNumber: "twelve" },
    cron: "0 3 * * *",
  });
  defineSchedule(workflow, {
    id: "typed",
    input: { issueNumber: 1 },
    cron: "0 3 * * *",
  });
}

describe("defineSchedule inference", () => {
  test("the input type comes from the workflow definition", () => {
    typeCheckScheduleDefinition(TYPED_WORKFLOW);
  });
});

describe("defineConfig agent (ADR 0013 §2, §3)", () => {
  const withAgent = (agent: unknown) => defineConfig({ ...baseInput(), agent: agent as never });

  test("defaults: opencode, no models, host settings ignored for both agents", () => {
    const config = defineConfig(baseInput());
    expect(config.agent).toEqual({
      default: "opencode",
      models: {},
      hostSettings: { claude: "ignore", opencode: "ignore" },
    });
  });

  test("carries default, models and hostSettings through", () => {
    const config = withAgent({
      default: "claude",
      models: { claude: "sonnet", opencode: "opencode/big-pickle" },
      hostSettings: { opencode: "include" },
    });
    expect(config.agent).toEqual({
      default: "claude",
      models: { claude: "sonnet", opencode: "opencode/big-pickle" },
      hostSettings: { claude: "ignore", opencode: "include" },
    });
  });

  test("keeps an injected adapter", () => {
    const adapter = { prepareWorkspace: async () => {}, stream: () => [] as never };
    expect(withAgent({ adapter }).agent.adapter).toBe(adapter);
  });

  test.each([
    [{ default: "codex" }, /agent.default must be one of "claude" \| "opencode" \(got "codex"\)/],
    [{ models: { codex: "x" } }, /agent.models has an unknown agent "codex"/],
    [{ models: { claude: "" } }, /agent.models.claude must be a non-empty model id/],
    [{ models: { claude: 4 } }, /agent.models.claude must be a non-empty model id \(got 4\)/],
    [
      { hostSettings: { claude: "yes" } },
      /agent.hostSettings.claude must be "ignore" or "include"/,
    ],
    [{ hostSettings: { codex: "ignore" } }, /agent.hostSettings has an unknown agent "codex"/],
  ])("rejects %j at load", (agent, message) => {
    expect(() => withAgent(agent)).toThrow(message);
  });

  test("a workflow's unknown agent fails at load, naming the workflow", () => {
    const workflow = defineWorkflow("bad-agent", {
      input: Schema.Struct({}),
      agent: { agent: "codex" as never },
      run: async () => ({}),
    });
    expect(() => defineConfig({ ...baseInput(), workflows: [workflow] })).toThrow(
      /workflow "bad-agent"'s agent has an unknown agent "codex"/,
    );
  });

  test("a schedule's unknown agent or empty model fails at load, naming the schedule", () => {
    const workflow = defineWorkflow("wf", { input: Schema.Struct({}), run: async () => ({}) });
    const schedule = (agent: unknown): ScheduleConfigInput => ({
      id: "nightly",
      workflow: "wf",
      input: {},
      cron: "0 3 * * *",
      agent: agent as never,
    });
    expect(() =>
      defineConfig({
        ...baseInput(),
        workflows: [workflow],
        schedules: [schedule({ agent: "x" })],
      }),
    ).toThrow(/schedule "nightly"'s agent has an unknown agent "x"/);
    expect(() =>
      defineConfig({ ...baseInput(), workflows: [workflow], schedules: [schedule({ model: "" })] }),
    ).toThrow(/schedule "nightly"'s agent has an invalid model ""/);
    const ok = defineConfig({
      ...baseInput(),
      workflows: [workflow],
      schedules: [schedule({ agent: "claude", model: "haiku" })],
    });
    expect(ok.schedules[0]?.agent).toEqual({ agent: "claude", model: "haiku" });
  });

  test("configuredAgents: the default, agents with a model, and agents a workflow or schedule names", () => {
    const pinned = defineWorkflow("pinned", {
      input: Schema.Struct({}),
      agent: { agent: "claude" },
      run: async () => ({}),
    });
    expect(configuredAgents(defineConfig(baseInput()))).toEqual(["opencode"]);
    expect(configuredAgents(withAgent({ default: "claude" }))).toEqual(["claude"]);
    expect(
      configuredAgents(
        withAgent({ default: "claude", models: { opencode: "opencode/big-pickle" } }),
      ),
    ).toEqual(["claude", "opencode"]);
    expect(configuredAgents(defineConfig({ ...baseInput(), workflows: [pinned] }))).toEqual([
      "claude",
      "opencode",
    ]);
  });
});
