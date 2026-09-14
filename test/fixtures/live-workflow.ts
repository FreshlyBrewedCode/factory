import { defineWorkflow, Schema } from "../../src/workflow";

/**
 * S3's live-leg fixture: a small, multi-step run with no git or gh, so the
 * real daemon's SSE tail can be watched from the browser while the injected
 * `createSlowFakeAdapter` spaces the chunks out. Steps are agent-only so the
 * step list grows one row at a time.
 */
export default defineWorkflow("live-test", {
  input: Schema.Struct({}),
  run: async (ctx) => {
    await ctx.log("started", {});
    await ctx.agent("one", "first step");
    await ctx.agent("two", "second step");
    await ctx.agent("three", "third step");
    return { ok: true };
  },
});
