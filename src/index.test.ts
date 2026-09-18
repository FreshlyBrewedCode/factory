/**
 * The public export surface is a contract, not an accident. These tests import
 * through the *package specifier* a user actually types — not a relative path —
 * so they fail if `exports` in `package.json` stops resolving, or if a rename
 * inside `src/` silently drops something the README tells people to import.
 */

import { expect, test } from "bun:test";
import * as factory from "@frebreco/factory";
import {
  DedupeKeyError,
  defineConfig,
  defineWorkflow,
  isTerminal,
  Schema,
} from "@frebreco/factory";

test("the barrel exports the authoring surface a project imports", () => {
  expect(typeof defineWorkflow).toBe("function");
  expect(typeof defineConfig).toBe("function");
  expect(typeof isTerminal).toBe("function");
  expect(typeof Schema.Struct).toBe("function");
});

test("defineWorkflow round-trips through the package specifier", () => {
  const roundTrip = defineWorkflow("hello", {
    input: Schema.Struct({ name: Schema.String }),
    run: async (_ctx, input) => input.name,
  });
  expect(roundTrip.id).toBe("hello");
  expect(typeof roundTrip.run).toBe("function");
});

test("DedupeKeyError is catchable by type through the barrel (issue #18)", () => {
  const err = new DedupeKeyError("issue:1", "run-holder");
  expect(err instanceof Error).toBe(true);
  expect(err.key).toBe("issue:1");
  expect(err.holderRunId).toBe("run-holder");
});

test("defineConfig applies its documented defaults", () => {
  const config = defineConfig({
    repo: {
      sshUrl: "git@github.com:owner/repo.git",
      identity: { name: "n", email: "e" },
      baseBranch: "main",
      slug: "owner/repo",
    },
    workflows: [],
  });
  expect(config.maxConcurrentRuns).toBe(factory.DEFAULT_MAX_CONCURRENT_RUNS);
  expect(config.retainedWorkspaces).toBe(factory.DEFAULT_RETAINED_WORKSPACES);
  expect(config.workspaceRoot).toBe(factory.DEFAULT_WORKSPACE_ROOT);
  expect(config.maxDispatchDepth).toBe(factory.DEFAULT_MAX_DISPATCH_DEPTH);
  expect(config.maxChildrenPerRun).toBe(factory.DEFAULT_MAX_CHILDREN_PER_RUN);
});

test("the barrel does not leak daemon internals", () => {
  // Widening this list is a design decision (see src/index.ts's header), so it
  // should be a deliberate edit here rather than a silent export.
  expect(Object.keys(factory).toSorted()).toEqual([
    "DEFAULT_MAX_CHILDREN_PER_RUN",
    "DEFAULT_MAX_CONCURRENT_RUNS",
    "DEFAULT_MAX_DISPATCH_DEPTH",
    "DEFAULT_RETAINED_WORKSPACES",
    "DEFAULT_WORKSPACE_ROOT",
    "DedupeKeyError",
    "Schema",
    "defineConfig",
    "defineSchedule",
    "defineWorkflow",
    "isTerminal",
  ]);
});
