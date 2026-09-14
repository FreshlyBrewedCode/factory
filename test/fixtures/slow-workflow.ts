import { defineWorkflow, Schema } from "../../src/workflow";

export default defineWorkflow("slow-test", {
  input: Schema.Struct({}),
  run: async (ctx) => {
    await ctx.log("started", {});
    await ctx.exec(["sleep", "30"]);
    await ctx.log("finished", {});
    return {};
  },
});
