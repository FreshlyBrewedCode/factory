import { defineWorkflow, Schema } from "../../src/workflow";

/**
 * A run whose event stream goes *quiet* mid-flight: `ctx.exec` emits
 * `ExecStarted`, then nothing at all until `ExecFinished`. That gap is what
 * kills an SSE connection under Bun's default 10s `idleTimeout` — the real
 * runs that hit it are `bun test` and write-back's `git push`/`gh pr create`.
 *
 * The gap here is sub-second so the suite stays fast; the server's keepalive
 * interval is turned down to match (`sseKeepaliveMs`), which is the property
 * under test. The full-fidelity 10s version is a manual check, not a test.
 */
export default defineWorkflow("quiet-gap", {
  input: Schema.Struct({}),
  run: async (ctx) => {
    await ctx.exec(["sleep", "0.4"]);
    return {};
  },
});
