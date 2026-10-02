/**
 * ADR 0013 Consequences: the daemon checks the configured agents at start and
 * names what is missing, rather than failing the first step.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, type AgentConfigInput } from "../config";
import { createSlowFakeAdapter } from "../replay/adapter";
import type { AcpAgentKind } from "../runtime/acp-agents";
import { defineWorkflow, Schema } from "../workflow";
import { reportAgentProblems, startDaemon } from "./daemon";

const PINNED = defineWorkflow("pinned-to-claude", {
  input: Schema.Struct({}),
  agent: { agent: "claude" },
  workspace: { kind: "scratch" },
  run: async () => ({}),
});

function config(agent: AgentConfigInput) {
  return defineConfig({
    repo: {
      sshUrl: "git@github.com:acme/widgets.git",
      identity: { name: "Factory", email: "factory@acme.test" },
      baseBranch: "main",
      slug: "acme/widgets",
    },
    workflows: [PINNED],
    agent,
  });
}

describe("agent availability at daemon start (ADR 0013)", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-daemon-agents-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("startDaemon checks the configured agents", async () => {
    const checked: Array<ReadonlyArray<AcpAgentKind>> = [];
    const handle = await startDaemon({
      dbPath: join(dir, "checked.db"),
      port: 0,
      config: config({ default: "opencode" }),
      checkAgents: async (agents) => {
        checked.push(agents);
        return [];
      },
    });
    await handle.stop();
    // The default, and claude because a workflow names it.
    expect(checked).toEqual([["claude", "opencode"]]);
  });

  test("an injected adapter skips the check: no agent process runs", async () => {
    let calls = 0;
    const handle = await startDaemon({
      dbPath: join(dir, "injected.db"),
      port: 0,
      config: config({ adapter: createSlowFakeAdapter([], 1) }),
      checkAgents: async () => {
        calls += 1;
        return [];
      },
    });
    await handle.stop();
    expect(calls).toBe(0);
  });

  test("reportAgentProblems logs each problem, naming the agent", async () => {
    const lines: string[] = [];
    const problems = await reportAgentProblems(
      ["claude", "opencode"],
      async () => [{ agent: "opencode", problem: "`opencode` is not on PATH" }],
      (line) => lines.push(line),
    );
    expect(problems).toHaveLength(1);
    expect(lines).toEqual([
      "agents: opencode is configured but cannot run on this host: `opencode` is not on PATH",
    ]);
  });

  test("reportAgentProblems logs a failing check instead of throwing", async () => {
    const lines: string[] = [];
    const problems = await reportAgentProblems(
      ["claude"],
      async () => {
        throw new Error("boom");
      },
      (line) => lines.push(line),
    );
    expect(problems).toEqual([]);
    expect(lines).toEqual(["agents: availability check failed: boom"]);
  });
});
