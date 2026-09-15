import { defineWorkflow, Schema } from "../../src/workflow";

export default defineWorkflow("tree-test", {
  input: Schema.Struct({ marker: Schema.String }),
  run: async (ctx, input) => {
    await ctx.exec(["sh", "-c", `echo ${input.marker} > ${input.marker}.txt`]);
    const result = await ctx.agent("step", "irrelevant, the adapter decides the pace");
    await ctx.exec(["sh", "-c", `echo final-${input.marker} > ${input.marker}.final.txt`]);
    return { marker: input.marker, finalText: result.finalText };
  },
});
