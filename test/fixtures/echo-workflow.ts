import { defineWorkflow, Schema } from "../../src/workflow";

export default defineWorkflow("echo-test", {
  input: Schema.Struct({}),
  run: async (ctx) => {
    const result = await ctx.agent("step", "irrelevant, replay ignores it");
    return { finalText: result.finalText };
  },
});
