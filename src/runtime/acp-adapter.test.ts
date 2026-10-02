/**
 * The ACP adapter against a fake agent over stdio (`test/fixtures/
 * fake-acp-agent.ts`, built on the SDK's `AgentSideConnection`): the real
 * protocol, process and pipes, with the agent's behaviour scripted.
 */

import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { acpAdapter, AcpAgentError, type AcpDiagnostic } from "./acp-adapter";
import type { AcpAgentDefinition } from "./acp-agents";
import type { AgentAdapterYield, AgentSignal } from "./agent-adapter";
import type { RunEvent } from "../events";
import { defineWorkflow, Schema } from "../workflow";
import { makeAgentRuntime } from "./agent-runtime";
import { startRun } from "./run";
import { fakeAgents } from "../replay/adapter";

const FAKE = join(import.meta.dir, "../../test/fixtures/fake-acp-agent.ts");

function fake(env: Record<string, string> = {}): AcpAgentDefinition {
  return { agent: "fake", command: [process.execPath, FAKE], env };
}

interface Collected {
  readonly yields: AgentAdapterYield[];
  readonly diagnostics: AcpDiagnostic[];
  readonly error: unknown;
}

async function collect(
  prompt: string,
  options: {
    model?: string;
    dir?: string;
    definition?: AcpAgentDefinition;
    outputSchema?: unknown;
    abortAfter?: (y: AgentAdapterYield) => boolean;
    cancelGraceMs?: number;
  } = {},
): Promise<Collected & { abortController: AbortController }> {
  const diagnostics: AcpDiagnostic[] = [];
  const adapter = acpAdapter(options.definition ?? fake(), {
    onDiagnostic: (d) => diagnostics.push(d),
    cancelGraceMs: options.cancelGraceMs ?? 300,
  });
  const abortController = new AbortController();
  const yields: AgentAdapterYield[] = [];
  let error: unknown;
  try {
    for await (const y of adapter.stream({
      threadId: "thread",
      dir: options.dir ?? import.meta.dir,
      agent: "opencode",
      model: options.model ?? "fake/fast",
      prompt,
      outputSchema: options.outputSchema,
      abortController,
    })) {
      yields.push(y);
      if (options.abortAfter?.(y)) abortController.abort();
    }
  } catch (cause) {
    error = cause;
  }
  return { yields, diagnostics, error, abortController };
}

const signals = (c: Collected, tag: AgentSignal["_tag"]) =>
  c.yields.flatMap((y) => (y.signal?._tag === tag ? [y.signal] : []));
const types = (c: Collected) => c.yields.map((y) => (y.chunk as { type: string }).type);
const text = (c: Collected) =>
  c.yields
    .map((y) => y.chunk as { type: string; delta?: string })
    .filter((ch) => ch.type === "TEXT_MESSAGE_CONTENT")
    .map((ch) => ch.delta)
    .join("");
const pidOf = (c: Collected) =>
  c.diagnostics.flatMap((d) => (d.kind === "spawned" ? [d.pid] : []))[0]!;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("acpAdapter", () => {
  test("selects the requested model before prompting", async () => {
    const c = await collect("hello", { model: "fake/smart" });
    expect(c.error).toBeUndefined();
    expect(text(c)).toBe("hello from fake/smart");
    const configured = c.diagnostics.find((d) => d.kind === "configured");
    expect(configured).toMatchObject({ configId: "model", value: "fake/smart" });
    expect(types(c)[0]).toBe("RUN_STARTED");
    expect(types(c).at(-1)).toBe("RUN_FINISHED");
    expect(signals(c, "sessionId")).toHaveLength(1);
  });

  test("runs in a relative dir: ACP gets it as an absolute cwd", async () => {
    // The default workspace root, `.factory/workspaces`, is relative.
    const dir = relative(process.cwd(), import.meta.dir) || ".";
    const c = await collect("hello", { dir });
    expect(c.error).toBeUndefined();
    expect(text(c)).toBe("hello from fake/fast");
  });

  test("sets the model even when the agent reports it as current", async () => {
    // claude-agent-acp reports the user's `model` setting as current even
    // when host settings are ignored and the SDK runs another model.
    const c = await collect("hello", { model: "fake/default" });
    expect(text(c)).toBe("hello from fake/default");
    const configured = c.diagnostics.find((d) => d.kind === "configured");
    expect(configured).toMatchObject({ configId: "model", value: "fake/default" });
  });

  test("fails before the prompt on a model the agent does not offer", async () => {
    const c = await collect("hello", { model: "nope/model" });
    expect(c.error).toBeInstanceOf(AcpAgentError);
    expect((c.error as Error).message).toBe(
      'fake has no model "nope/model" (3 offered, e.g. fake/default, fake/fast, fake/smart)',
    );
    expect(c.yields).toHaveLength(0);
    expect(c.diagnostics.some((d) => d.kind === "update")).toBe(false);
  });

  test("fails when the agent offers no model option", async () => {
    const c = await collect("hello", { definition: fake({ FAKE_ACP_NO_MODEL: "1" }) });
    expect((c.error as Error).message).toContain("fake offers no model option");
  });

  test("fails without a model", async () => {
    const c = await collect("hello", { model: "" });
    expect((c.error as Error).message).toContain("no model given");
    expect(c.diagnostics).toHaveLength(0);
  });

  test("answers a permission ask with allow_always", async () => {
    const c = await collect("permission");
    expect(text(c)).toBe("permission: always");
    expect(c.diagnostics.find((d) => d.kind === "permission")).toMatchObject({
      title: "Edit math.ts",
      chosen: "always",
    });
  });

  test("forwards each usage_update as an acp.usage chunk with a usage signal, in order", async () => {
    const c = await collect("hello");
    expect(signals(c, "usage")).toEqual([
      { _tag: "usage", value: { context: { used: 1000, size: 200_000 } } },
      {
        _tag: "usage",
        value: { context: { used: 1200, size: 200_000 }, cost: { amount: 0.25, currency: "USD" } },
      },
    ]);
    const names = c.yields.map((y) => {
      const chunk = y.chunk as { type: string; name?: string };
      return chunk.type === "CUSTOM" ? chunk.name : chunk.type;
    });
    // usage, then the text, then usage with cost, then the end of the run.
    expect(names.indexOf("acp.usage")).toBeLessThan(names.indexOf("TEXT_MESSAGE_CONTENT"));
    expect(names.lastIndexOf("acp.usage")).toBeGreaterThan(names.indexOf("TEXT_MESSAGE_CONTENT"));
    expect(names.lastIndexOf("acp.usage")).toBeLessThan(names.indexOf("RUN_FINISHED"));
    const finished = c.yields.at(-1)!.chunk as { usage?: unknown };
    expect(finished.usage).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
      promptTokensDetails: { cachedTokens: 990 },
    });
  });

  test("carries each tool call title the translator drops as an acp.tool-call chunk", async () => {
    const c = await collect("tools");
    const chunks = c.yields.map((y) => y.chunk as { type: string; name?: string; value?: unknown });
    const tools = chunks.filter((ch) => ch.type === "CUSTOM" && ch.name === "acp.tool-call");
    expect(tools.map((ch) => ch.value)).toEqual([
      { toolCallId: "t1", title: "Edit" },
      { toolCallId: "t1", title: "Edit math.ts", input: { file_path: "math.ts" } },
    ]);
    // The translator keeps the first, generic title only.
    const end = chunks.find((ch) => ch.type === "TOOL_CALL_END") as { input?: unknown };
    expect(end.input).toEqual({ title: "Edit" });
    // Each info chunk follows the call's TOOL_CALL_START, and carries no signal.
    expect(chunks.indexOf(tools[0]!)).toBeGreaterThan(
      chunks.findIndex((ch) => ch.type === "TOOL_CALL_START"),
    );
    expect(c.yields.filter((y) => tools.includes(y.chunk as never)).map((y) => y.signal)).toEqual([
      undefined,
      undefined,
    ]);
  });

  test("parses structured output from the last message and yields it before RUN_FINISHED", async () => {
    const c = await collect("json", { outputSchema: { type: "object" } });
    expect(signals(c, "structuredOutput")).toEqual([
      { _tag: "structuredOutput", value: { summary: "done", count: 2 } },
    ]);
    const last = c.yields
      .slice(-2)
      .map(
        (y) =>
          (y.chunk as { type: string; name?: string }).name ?? (y.chunk as { type: string }).type,
      );
    expect(last).toEqual(["structured-output.complete", "RUN_FINISHED"]);
  });

  test("a refusal becomes RUN_ERROR with a runError signal", async () => {
    const c = await collect("refuse");
    expect(signals(c, "runError")).toHaveLength(1);
    expect(types(c)).toContain("RUN_ERROR");
  });

  test("the agent does not inherit the parent's Claude Code session variables", async () => {
    const before = { ...process.env };
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_EFFORT = "high";
    process.env.CLAUDE_CODE_SESSION_ID = "parent";
    process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-config";
    try {
      const seen = text(await collect("env")).split(",");
      expect(seen).toContain("CLAUDE_CONFIG_DIR");
      expect(seen).not.toContain("CLAUDECODE");
      expect(seen).not.toContain("CLAUDE_EFFORT");
      expect(seen).not.toContain("CLAUDE_CODE_SESSION_ID");
    } finally {
      for (const key of [
        "CLAUDECODE",
        "CLAUDE_EFFORT",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CONFIG_DIR",
      ])
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
    }
  });

  test("cancel sends session/cancel, the turn settles as cancelled, and the process is gone", async () => {
    const c = await collect("hang", {
      abortAfter: (y) => (y.chunk as { type: string }).type === "TEXT_MESSAGE_CONTENT",
    });
    expect(c.error).toBeUndefined();
    expect(c.diagnostics.find((d) => d.kind === "done")).toMatchObject({ stopReason: "cancelled" });
    expect(alive(pidOf(c))).toBe(false);
  });

  test("an agent that ignores cancel is killed after the grace period", async () => {
    const started = Date.now();
    const c = await collect("deaf", {
      cancelGraceMs: 200,
      abortAfter: (y) => (y.chunk as { type: string }).type === "TEXT_MESSAGE_CONTENT",
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(c.diagnostics.some((d) => d.kind === "exited")).toBe(true);
    expect(alive(pidOf(c))).toBe(false);
  });

  test("an agent that exits mid-turn fails the step with its exit code and stderr tail", async () => {
    const c = await collect("crash");
    expect(c.error).toBeInstanceOf(AcpAgentError);
    const message = (c.error as Error).message;
    expect(message).toContain("fake exited (code 3)");
    expect(message).toContain("fatal: the fake agent fell over");
    // The translator closed the open text message before the failure surfaced.
    expect(types(c)).toContain("TEXT_MESSAGE_END");
  });

  test("an agent that cannot be started fails with its command", async () => {
    const c = await collect("hello", {
      definition: { agent: "ghost", command: ["/nonexistent/acp-agent"] },
    });
    expect((c.error as Error).message).toContain("ghost did not start (/nonexistent/acp-agent)");
  });

  test("the process is gone after a normal turn", async () => {
    const c = await collect("hello");
    expect(c.error).toBeUndefined();
    expect(alive(pidOf(c))).toBe(false);
  });

  test("through the runtime: a cancelled run cancels the step and leaves no agent process", async () => {
    const diagnostics: AcpDiagnostic[] = [];
    const runtime = makeAgentRuntime(
      fakeAgents(
        acpAdapter(fake(), { onDiagnostic: (d) => diagnostics.push(d), cancelGraceMs: 300 }),
      ),
    );
    const workflow = defineWorkflow("acp-cancel", {
      input: Schema.Struct({}),
      run: async (ctx) => {
        await ctx.agent("hang", "hang until cancelled", { model: "fake/fast" });
      },
    });
    const events: RunEvent[] = [];
    const handle = startRun(workflow, runtime, {
      runId: "acp-cancel",
      dir: import.meta.dir,
      input: {},
      onEvent: (event) => events.push(event),
    });
    while (!events.some((e) => e.payload._tag === "AgentChunk")) await Bun.sleep(10);
    await handle.cancel();
    expect((await handle.result).outcome).toBe("cancelled");
    await handle.settled;
    await runtime.dispose();
    const step = events.find((e) => e.payload._tag === "AgentStepFinished")?.payload;
    expect(step).toMatchObject({ outcome: "cancelled" });
    const pid = diagnostics.flatMap((d) => (d.kind === "spawned" ? [d.pid] : []))[0]!;
    expect(alive(pid)).toBe(false);
  });
});
