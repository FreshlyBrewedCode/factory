/**
 * The agent runtime as a context service (ADR 0012 §4), and its default: the
 * ACP runtime, which launches the agent each step resolved to (ADR 0013 §1).
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import type { RunEvent } from "../events";
import { fakeAgents, createSlowFakeAdapter } from "../replay/adapter";
import { defineWorkflow, Schema } from "../workflow";
import type { AcpAgentDefinition, AcpAgentKind, AcpAgentOptions } from "./acp-agents";
import {
  acpAgentsAdapter,
  AgentRuntime,
  AgentRuntimeLayer,
  makeAgentRuntime,
} from "./agent-runtime";
import { startRun } from "./run";

const FAKE = join(import.meta.dir, "../../test/fixtures/fake-acp-agent.ts");

describe("AgentRuntime service", () => {
  test("without an adapter, the layer provides the ACP runtime and the bare defaults", async () => {
    const runtime = ManagedRuntime.make(AgentRuntimeLayer());
    const { adapter, defaults } = await runtime.runPromise(AgentRuntime);
    expect(typeof adapter.stream).toBe("function");
    expect(defaults).toEqual({ default: "opencode", models: {} });
    await runtime.dispose();
  });

  test("the layer carries the config's default agent and models", async () => {
    const runtime = makeAgentRuntime({
      default: "claude",
      models: { claude: "sonnet", opencode: "opencode/big-pickle" },
    });
    const { defaults } = await runtime.runPromise(AgentRuntime);
    expect(defaults).toEqual({
      default: "claude",
      models: { claude: "sonnet", opencode: "opencode/big-pickle" },
    });
    await runtime.dispose();
  });

  test("AgentRuntimeLayer swaps the adapter via context", async () => {
    const fake = createSlowFakeAdapter([], 1);
    const runtime = ManagedRuntime.make(AgentRuntimeLayer(fakeAgents(fake)));
    const { adapter } = await runtime.runPromise(AgentRuntime);
    expect(adapter).toBe(fake);
    await runtime.dispose();
  });

  test("an effect that requires the service resolves it from context", async () => {
    const fake = createSlowFakeAdapter([], 1);
    const program = Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      return runtime.adapter;
    });
    const runtime = ManagedRuntime.make(AgentRuntimeLayer(fakeAgents(fake)));
    const adapter = await runtime.runPromise(program);
    expect(adapter).toBe(fake);
    await runtime.dispose();
  });
});

describe("acpAgentsAdapter", () => {
  test("each step launches the agent it resolved to, on its model, with that agent's hostSettings", async () => {
    const defined: Array<{ agent: AcpAgentKind; options: AcpAgentOptions }> = [];
    // Both agents are the fake ACP agent, told apart by name; the fake's
    // `hello` reply names the session's model.
    const define = (agent: AcpAgentKind, options: AcpAgentOptions): AcpAgentDefinition => {
      defined.push({ agent, options });
      return { agent, command: [process.execPath, FAKE] };
    };
    const adapter = acpAgentsAdapter({ claude: "include" }, define);

    const events: Array<RunEvent> = [];
    const workflow = defineWorkflow("two-agents", {
      input: Schema.Struct({}),
      run: async (ctx) => {
        const a = await ctx.agent("on-claude", "hello", { agent: "claude" });
        const b = await ctx.agent("on-opencode", "hello", { agent: "opencode" });
        const c = await ctx.agent("on-claude-again", "hello", {
          agent: "claude",
          model: "fake/smart",
        });
        return { texts: [a.finalText, b.finalText, c.finalText] };
      },
    });
    const runtime = makeAgentRuntime({
      adapter,
      models: { claude: "fake/fast", opencode: "fake/default" },
    });
    const handle = startRun(workflow, runtime, {
      runId: "run-two-agents",
      dir: import.meta.dir,
      input: {},
      onEvent: (e) => events.push(e),
    });
    const outcome = await handle.result;
    await runtime.dispose();

    expect(outcome.outcome).toBe("completed");
    const texts =
      outcome.outcome === "completed" ? (outcome.output as { texts: string[] }).texts : [];
    expect(texts[0]).toContain("fake/fast");
    expect(texts[1]).toContain("fake/default");
    expect(texts[2]).toContain("fake/smart");
    // One definition per agent, built on first use, with its own setting.
    expect(defined).toEqual([
      { agent: "claude", options: { hostSettings: "include" } },
      { agent: "opencode", options: { hostSettings: "ignore" } },
    ]);
    const started = events.flatMap((e) =>
      e.payload._tag === "AgentStepStarted" ? [[e.payload.agent, e.payload.model]] : [],
    );
    expect(started).toEqual([
      ["claude", "fake/fast"],
      ["opencode", "fake/default"],
      ["claude", "fake/smart"],
    ]);
  });
});
