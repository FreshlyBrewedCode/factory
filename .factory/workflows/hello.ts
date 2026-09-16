/**
 * Your first workflow. A workflow is a plain async function over `ctx` —
 * `await`, `if`, `try`/`catch` and early returns all work, because there is
 * no step graph and no DSL to translate them into.
 *
 * This one is the whole round trip in four steps: ask the agent to do
 * something, look at what it did, and open a pull request.
 *
 * Run it:
 *   factory start hello --input '{"task": "add a CONTRIBUTING.md"}' --watch
 */

import { defineWorkflow, Schema } from "@frebreco/factory";

export default defineWorkflow("hello", {
  // The input schema drives the "New run" form in the UI and validates what
  // `factory start --input` sends, before the run is allowed to start.
  input: Schema.Struct({
    task: Schema.String,
  }),

  // What this workflow resolves to. Recorded in the run's event log.
  output: Schema.Struct({
    changedFiles: Schema.Int,
    prUrl: Schema.NullOr(Schema.String),
  }),

  run: async (ctx, input) => {
    // 1. One agent step. `ctx.dir` is a working tree the runtime cloned for
    //    this run alone — the agent is already in it.
    await ctx.agent(
      "implement",
      `You are working in a git checkout of this project.

Task: ${input.task}

Make the change, keeping the existing code style. When you are done, stop —
do not run git commands, do not commit, and do not open a pull request.`,
    );

    // 2. Look at what changed. `ctx.exec` returns a non-zero exit code rather
    //    than throwing, so checking it is ordinary control flow.
    const status = await ctx.exec(["git", "status", "--short"]);
    const changedFiles = status.stdout.split("\n").filter((line) => line.trim() !== "").length;

    // 3. Nothing to ship is a perfectly good outcome — just return early.
    if (changedFiles === 0) {
      await ctx.log("no-changes", { task: input.task });
      return { changedFiles: 0, prUrl: null };
    }

    // 4. Write back: branch, commit, push and open a PR. This is deterministic
    //    git and gh run by factory itself, never an instruction to the agent.
    //    If the branch name is already taken, factory retries once with a
    //    unique suffix.
    const writeBack = await ctx.writeBack({
      branch: "factory/hello",
      commitMessage: `${input.task}\n\nAutomated by the factory 'hello' workflow.`,
      prTitle: input.task,
      prBody: `Opened by factory.\n\nTask: ${input.task}`,
    });

    return { changedFiles, prUrl: writeBack.prUrl };
  },
});
