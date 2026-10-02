/**
 * The agent runtime as a context service (ADR 0012 §4).
 */

import { describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { createSlowFakeAdapter } from "../replay/adapter";
import { opencodeAdapter } from "./opencode-adapter";
import { AgentRuntime, AgentRuntimeLayer } from "./agent-runtime";

describe("AgentRuntime service", () => {
  test("without an adapter, the layer provides the live opencode adapter", async () => {
    const runtime = ManagedRuntime.make(AgentRuntimeLayer());
    const { adapter } = await runtime.runPromise(AgentRuntime);
    expect(adapter).toBe(opencodeAdapter);
    await runtime.dispose();
  });

  test("AgentRuntimeLayer swaps the adapter via context", async () => {
    const fake = createSlowFakeAdapter([], 1);
    const runtime = ManagedRuntime.make(AgentRuntimeLayer(fake));
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
    const runtime = ManagedRuntime.make(AgentRuntimeLayer(fake));
    const adapter = await runtime.runPromise(program);
    expect(adapter).toBe(fake);
    await runtime.dispose();
  });
});
