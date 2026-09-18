import { defineWorkflow, Schema } from "../../src/workflow";

export default defineWorkflow("registry-scratch-test", {
  input: Schema.Struct({}),
  workspace: { kind: "scratch" },
  run: async (ctx) => {
    const result = await ctx.agent("step", "irrelevant, replay ignores it");
    return { finalText: result.finalText };
  },
});
