import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_CONCURRENT_RUNS,
  DEFAULT_RETAINED_WORKSPACES,
  DEFAULT_WORKSPACE_ROOT,
  defineConfig,
} from "./config";
import type { WorkflowDefinition } from "./workflow";

const ECHO_WORKFLOW = `${import.meta.dir}/../test/fixtures/echo-workflow.ts`;

describe("defineConfig (D27)", () => {
  test("carries the required repo + workflows keys through", () => {
    const config = defineConfig({
      repo: {
        sshUrl: "git@github.com:acme/widgets.git",
        identity: { name: "Factory", email: "factory@acme.test" },
        baseBranch: "main",
        slug: "acme/widgets",
      },
      workflows: [] as ReadonlyArray<WorkflowDefinition>,
    });

    expect(config.repo.slug).toBe("acme/widgets");
    expect(config.repo.baseBranch).toBe("main");
    expect(config.workflows).toEqual([]);
  });

  test("workspaceRoot, maxConcurrentRuns and retainedWorkspaces have defaults", () => {
    const config = defineConfig({
      repo: {
        sshUrl: "git@github.com:acme/widgets.git",
        identity: { name: "Factory", email: "factory@acme.test" },
        baseBranch: "main",
        slug: "acme/widgets",
      },
      workflows: [] as ReadonlyArray<WorkflowDefinition>,
    });

    expect(config.workspaceRoot).toBe(DEFAULT_WORKSPACE_ROOT);
    expect(config.maxConcurrentRuns).toBe(DEFAULT_MAX_CONCURRENT_RUNS);
    expect(config.retainedWorkspaces).toBe(DEFAULT_RETAINED_WORKSPACES);
    expect(config.repo).toBeDefined();
  });

  test("the config's workflow array is the registry, enumerating by id", async () => {
    const { default: echo } = await import(ECHO_WORKFLOW);
    const config = defineConfig({
      repo: {
        sshUrl: "git@github.com:acme/widgets.git",
        identity: { name: "Factory", email: "factory@acme.test" },
        baseBranch: "main",
        slug: "acme/widgets",
      },
      workflows: [echo as WorkflowDefinition],
    });
    expect(config.workflows.map((w) => w.id)).toEqual(["echo-test"]);
  });
});
