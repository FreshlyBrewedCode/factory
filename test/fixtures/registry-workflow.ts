import { defineWorkflow, Schema } from "../../src/workflow";

export default defineWorkflow("registry-test", {
  input: Schema.Struct({ issueNumber: Schema.Number }),
  run: async (ctx) => {
    const result = await ctx.agent("step", "irrelevant, replay ignores it");
    return { finalText: result.finalText };
  },
});
