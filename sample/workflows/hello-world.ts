import { defineWorkflow, Schema } from "@frebreco/factory";

export default defineWorkflow("hello-world", {
  input: Schema.Struct({
    task: Schema.String,
  }),

  output: Schema.Struct({
    prUrl: Schema.NullOr(Schema.String),
  }),

  run: async (ctx, input) => {
    // Run a sandboxed agent
    await ctx.agent("implement", `Implement the following task: ${input.task}`);

    // Create a PR
    const writeBack = await ctx.writeBack({
      branch: "factory/hello-world",
      commitMessage: `${input.task}\n\nAutomated by the factory 'hello' workflow.`,
      prTitle: input.task,
      prBody: `Opened by factory.\n\nTask: ${input.task}`,
    });

    return { prUrl: writeBack.prUrl };
  },
});
