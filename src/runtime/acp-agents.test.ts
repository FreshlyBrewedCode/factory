import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { FactoryHostShellEnv } from "./acp-opencode-plugin";
import {
  agentEnv,
  checkAgents,
  claudeAgent,
  claudeAuthProblem,
  HOST_XDG_CONFIG_HOME,
  OPENCODE_HOST_ENV_PLUGIN,
  opencodeAgent,
  opencodeIsolatedDirs,
  scrubAgentEnv,
} from "./acp-agents";

describe("scrubAgentEnv", () => {
  test("drops the parent's Claude Code session variables and keeps credentials", () => {
    expect(
      scrubAgentEnv({
        PATH: "/bin",
        CLAUDECODE: "1",
        CLAUDE_EFFORT: "high",
        CLAUDE_CODE_SESSION_ID: "s",
        CLAUDE_CODE_SUBAGENT_MODEL: "sonnet",
        CLAUDE_CODE_MESSAGING_TOKEN: "t",
        CLAUDE_CONFIG_DIR: "/c",
        CLAUDE_CODE_OAUTH_TOKEN: "o",
        ANTHROPIC_API_KEY: "k",
        UNSET: undefined,
      }),
    ).toEqual({
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: "/c",
      CLAUDE_CODE_OAUTH_TOKEN: "o",
      ANTHROPIC_API_KEY: "k",
    });
  });
});

describe("agentEnv", () => {
  test("scrubs, drops the definition's variables, then adds its own", () => {
    const env = agentEnv(
      { agent: "x", command: ["x"], dropEnv: ["OPENCODE_CONFIG"], env: { A: "new" } },
      { A: "old", OPENCODE_CONFIG: "/host.json", CLAUDECODE: "1", PATH: "/bin" },
    );
    expect(env).toEqual({ A: "new", PATH: "/bin" });
  });
});

describe("claudeAgent", () => {
  test("ignores host settings by default: settingSources without user", () => {
    const agent = claudeAgent();
    expect(agent.agent).toBe("claude");
    expect(agent.command[0]).toBe(process.execPath);
    expect(agent.command[1]).toEndWith("claude-agent-acp/dist/index.js");
    expect(agent.sessionMeta).toEqual({
      claudeCode: { options: { settingSources: ["project", "local"] } },
    });
  });

  test("includes host settings when asked: no _meta, the agent's own defaults", () => {
    expect(claudeAgent({ hostSettings: "include" }).sessionMeta).toBeUndefined();
  });
});

describe("opencodeAgent", () => {
  test("ignores host settings by default: config home and home hidden, plugin loaded", () => {
    const agent = opencodeAgent();
    const { configHome, home } = opencodeIsolatedDirs();
    expect(agent.command).toEqual(["opencode", "acp"]);
    expect(agent.env).toMatchObject({
      XDG_CONFIG_HOME: configHome,
      OPENCODE_TEST_HOME: home,
      [HOST_XDG_CONFIG_HOME]: process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    });
    expect(JSON.parse(agent.env!.OPENCODE_CONFIG_CONTENT!)).toEqual({
      plugin: [OPENCODE_HOST_ENV_PLUGIN],
    });
    expect(agent.dropEnv).toEqual([
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_CONFIG_CONTENT",
    ]);
  });

  test("includes host settings when asked: plain `opencode acp`", () => {
    expect(opencodeAgent({ hostSettings: "include" })).toEqual({
      agent: "opencode",
      command: ["opencode", "acp"],
    });
  });

  test("the plugin file exists where the definition points", async () => {
    expect(await Bun.file(new URL(OPENCODE_HOST_ENV_PLUGIN)).exists()).toBe(true);
  });
});

describe("the opencode host-env plugin", () => {
  test("hands the host's XDG_CONFIG_HOME to shell commands", async () => {
    const before = process.env[HOST_XDG_CONFIG_HOME];
    process.env[HOST_XDG_CONFIG_HOME] = "/home/someone/.config";
    try {
      const hooks = await FactoryHostShellEnv();
      const output = { env: {} as Record<string, string> };
      await hooks["shell.env"]({}, output);
      expect(output.env).toEqual({ XDG_CONFIG_HOME: "/home/someone/.config" });
    } finally {
      if (before === undefined) delete process.env[HOST_XDG_CONFIG_HOME];
      else process.env[HOST_XDG_CONFIG_HOME] = before;
    }
  });

  test("leaves the shell alone outside factory", async () => {
    const before = process.env[HOST_XDG_CONFIG_HOME];
    delete process.env[HOST_XDG_CONFIG_HOME];
    try {
      const output = { env: {} as Record<string, string> };
      await (await FactoryHostShellEnv())["shell.env"]({}, output);
      expect(output.env).toEqual({});
    } finally {
      if (before !== undefined) process.env[HOST_XDG_CONFIG_HOME] = before;
    }
  });
});

describe("claudeAuthProblem", () => {
  test("logged in, API key, or an external provider: no problem", () => {
    expect(claudeAuthProblem('{"loggedIn":true,"apiProvider":"firstParty"}')).toBeUndefined();
    expect(
      claudeAuthProblem(
        '{"loggedIn":false,"apiKeySource":"ANTHROPIC_API_KEY","apiProvider":"firstParty"}',
      ),
    ).toBeUndefined();
    expect(claudeAuthProblem('{"loggedIn":false,"apiProvider":"bedrock"}')).toBeUndefined();
  });

  test("logged out on the first-party backend is a problem", () => {
    expect(
      claudeAuthProblem('{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'),
    ).toContain("Claude is not logged in");
  });

  test("output it cannot read is not reported", () => {
    expect(claudeAuthProblem("")).toBeUndefined();
    expect(claudeAuthProblem("not json")).toBeUndefined();
    expect(claudeAuthProblem('{"something":"else"}')).toBeUndefined();
  });
});

describe("checkAgents", () => {
  test("reports opencode missing from PATH", async () => {
    expect(await checkAgents(["opencode"], { PATH: "/nonexistent" })).toEqual([
      { agent: "opencode", problem: "`opencode` is not on PATH" },
    ]);
  });

  test("an API key in the environment is enough for Claude", async () => {
    expect(await checkAgents(["claude"], { ANTHROPIC_API_KEY: "sk-test", PATH: "" })).toEqual([]);
  });
});
