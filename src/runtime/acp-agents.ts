/**
 * The ACP agents factory knows how to launch (ADR 0013 §1, §3). Every
 * agent-specific detail lives in a definition: the command, the environment,
 * the `_meta` for `session/new`, and how the host's own agent settings are
 * kept out of a run. The adapter (`acp-adapter.ts`) is generic; a third ACP
 * agent is a third definition.
 *
 * Host settings (ADR 0013 §3, finding 13 addendum): with `hostSettings:
 * "ignore"` (the default) a run reads the project's agent configuration and
 * not the operator's. Credentials are not settings and stay available.
 *
 * - claude: `settingSources: ["project", "local"]` drops `~/.claude`'s
 *   settings, skills and `CLAUDE.md` from the Agent SDK. claude-agent-acp
 *   still reads the user's `model`, `permissions.defaultMode` and
 *   `availableModels` itself, which is why factory always sends a model and
 *   answers every permission ask.
 * - opencode: see `opencodeAgent`. In short, its global config dir and its
 *   home-level reads point at empty factory-owned directories, and a factory
 *   plugin hands the host's `XDG_CONFIG_HOME` back to the shell commands it
 *   runs, so `gh`, git and other tools keep their config.
 */

import { mkdirSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The agents factory ships definitions for. */
export const ACP_AGENT_KINDS = ["claude", "opencode"] as const;
export type AcpAgentKind = (typeof ACP_AGENT_KINDS)[number];

/** Whether a run sees the operator's own agent settings (ADR 0013 §3). */
export type HostSettings = "ignore" | "include";

export interface AcpAgentDefinition {
  /** The agent's name in errors and logs. */
  readonly agent: string;
  /** The launch command; the agent speaks ACP on stdin/stdout. */
  readonly command: ReadonlyArray<string>;
  /** Added to the (scrubbed) environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Removed from the inherited environment, beside the `CLAUDE_*` scrub. */
  readonly dropEnv?: ReadonlyArray<string>;
  /** Agent-specific `_meta` for `session/new`. */
  readonly sessionMeta?: Readonly<Record<string, unknown>>;
}

export interface AcpAgentOptions {
  /** Default `"ignore"`. */
  readonly hostSettings?: HostSettings;
}

/**
 * Inherited variables an agent must not see: a daemon started from inside a
 * Claude Code session would otherwise pass its effort, subagent model,
 * session ids and messaging socket down to every agent it runs (finding 13
 * addendum). Kept: the ones that say where Claude's credentials are, or which
 * provider pays — credentials are not settings.
 */
const CLAUDE_ENV_KEEP = new Set([
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
]);

/** `env` without the parent's Claude Code session variables. */
export function scrubAgentEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === "CLAUDECODE") continue;
    if (key.startsWith("CLAUDE_") && !CLAUDE_ENV_KEEP.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** The environment an agent process starts with. */
export function agentEnv(
  definition: AcpAgentDefinition,
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env = scrubAgentEnv(parent);
  for (const key of definition.dropEnv ?? []) delete env[key];
  return { ...env, ...definition.env };
}

let claudeAcpEntry: string | undefined;
/** claude-agent-acp's entry point, bundled as a dependency. */
export function claudeAcpBin(): string {
  claudeAcpEntry ??= Bun.resolveSync(
    "@agentclientprotocol/claude-agent-acp/dist/index.js",
    import.meta.dir,
  );
  return claudeAcpEntry;
}

/** Claude Code through Anthropic's claude-agent-acp (bundled). */
export function claudeAgent(options: AcpAgentOptions = {}): AcpAgentDefinition {
  const ignore = (options.hostSettings ?? "ignore") === "ignore";
  return {
    agent: "claude",
    // Run it on the daemon's own bun: `bun` need not be on PATH.
    command: [process.execPath, claudeAcpBin()],
    ...(ignore && {
      sessionMeta: { claudeCode: { options: { settingSources: ["project", "local"] } } },
    }),
  };
}

/**
 * The empty, factory-owned directories opencode sees as its config home and
 * its home when the host's are hidden. opencode creates `opencode/` under the
 * config home at start; nothing writes settings into either.
 */
export function opencodeIsolatedDirs(): { readonly configHome: string; readonly home: string } {
  const root = join(tmpdir(), `factory-${userInfo().username}`, "opencode-isolated");
  return { configHome: join(root, "config"), home: join(root, "home") };
}

/** The opencode plugin that hands the host's `XDG_CONFIG_HOME` back to shell commands. */
export const OPENCODE_HOST_ENV_PLUGIN = pathToFileURL(
  join(import.meta.dir, "acp-opencode-plugin.ts"),
).href;

/** The variable the plugin reads the host's value from. */
export const HOST_XDG_CONFIG_HOME = "FACTORY_HOST_XDG_CONFIG_HOME";

/**
 * opencode's own ACP server (`opencode acp`), from PATH.
 *
 * With host settings ignored (finding 13, addendum 2):
 * - `XDG_CONFIG_HOME` → an empty directory hides `~/.config/opencode`
 *   (config, providers, plugins, global `AGENTS.md`, skills, agents,
 *   commands). opencode reads the variable once at start. Provider logins
 *   live in the data dir (`~/.local/share/opencode/auth.json`) and stay.
 *   `OPENCODE_CONFIG_DIR` cannot do this: it adds a directory beside the
 *   global one.
 * - the host-env plugin (`acp-opencode-plugin.ts`, through
 *   `OPENCODE_CONFIG_CONTENT`) restores the host's `XDG_CONFIG_HOME` (or its
 *   default, `~/.config`) for every shell command, so `gh` keeps its auth and
 *   git its global config.
 * - `OPENCODE_TEST_HOME` → an empty directory hides what opencode reads from
 *   the home directory itself: `~/.claude/skills`, `~/.agents/skills`,
 *   `~/.claude/CLAUDE.md` and `~/.opencode`. It changes only opencode's own
 *   notion of home (not `HOME`, not the data dir); the project's
 *   `.claude/skills`, `.agents/skills`, `AGENTS.md` and `CLAUDE.md` stay. It
 *   is an undocumented (test) variable: should opencode drop it, the host's
 *   skills reappear in runs, nothing breaks. `OPENCODE_DISABLE_CLAUDE_CODE*`
 *   is no substitute: it also drops the project's Claude files and keeps
 *   `~/.agents/skills`.
 * - the host's `OPENCODE_CONFIG*` variables are dropped: they are settings.
 */
export function opencodeAgent(options: AcpAgentOptions = {}): AcpAgentDefinition {
  const ignore = (options.hostSettings ?? "ignore") === "ignore";
  if (!ignore) return { agent: "opencode", command: ["opencode", "acp"] };
  const { configHome, home } = opencodeIsolatedDirs();
  mkdirSync(configHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  return {
    agent: "opencode",
    command: ["opencode", "acp"],
    dropEnv: ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT"],
    env: {
      XDG_CONFIG_HOME: configHome,
      OPENCODE_TEST_HOME: home,
      [HOST_XDG_CONFIG_HOME]: process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [OPENCODE_HOST_ENV_PLUGIN] }),
    },
  };
}

/** The definition for one of factory's agents. */
export function acpAgent(kind: AcpAgentKind, options: AcpAgentOptions = {}): AcpAgentDefinition {
  return kind === "claude" ? claudeAgent(options) : opencodeAgent(options);
}

/** Something that keeps a configured agent from running on this host. */
export interface AgentProblem {
  readonly agent: AcpAgentKind;
  readonly problem: string;
}

/**
 * Which of `agents` cannot run on this host, so the daemon can say so at
 * start rather than fail the first step (ADR 0013 Consequences). opencode
 * needs `opencode` on PATH; Claude needs a login or an API key, which the
 * bundled CLI's `auth status` reports. When the status cannot be read the
 * agent is not reported: only a known problem is one.
 */
export async function checkAgents(
  agents: ReadonlyArray<AcpAgentKind>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<AgentProblem[]> {
  const problems: AgentProblem[] = [];
  for (const agent of new Set(agents)) {
    const problem = agent === "opencode" ? checkOpencode(env) : await checkClaude(env);
    if (problem !== undefined) problems.push({ agent, problem });
  }
  return problems;
}

function checkOpencode(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return Bun.which("opencode", { PATH: env.PATH ?? "" }) === null
    ? "`opencode` is not on PATH"
    : undefined;
}

async function checkClaude(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  let bin: string;
  try {
    bin = claudeAcpBin();
  } catch {
    return "@agentclientprotocol/claude-agent-acp is not installed";
  }
  if (env.ANTHROPIC_API_KEY) return undefined;
  const child = Bun.spawn([process.execPath, bin, "--cli", "auth", "status", "--json"], {
    env: scrubAgentEnv(env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    const stdout = await new Response(child.stdout).text();
    await child.exited;
    return claudeAuthProblem(stdout);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read `claude auth status --json`. Logged out means: no claude.ai login, no
 * API key from any source, and the first-party backend (Bedrock, Vertex, …
 * keep their credentials outside Claude, so `loggedIn` is false there).
 */
export function claudeAuthProblem(stdout: string): string | undefined {
  let status: { loggedIn?: unknown; apiKeySource?: unknown; apiProvider?: unknown };
  try {
    status = JSON.parse(stdout) as typeof status;
  } catch {
    return undefined;
  }
  if (typeof status !== "object" || status === null || typeof status.loggedIn !== "boolean")
    return undefined;
  const external = typeof status.apiProvider === "string" && status.apiProvider !== "firstParty";
  if (status.loggedIn || status.apiKeySource || external) return undefined;
  return "Claude is not logged in (run `claude auth login`, or set ANTHROPIC_API_KEY)";
}
