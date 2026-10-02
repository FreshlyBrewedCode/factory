/**
 * An opencode plugin factory loads into every opencode agent whose host
 * settings are ignored (`acp-agents.ts`, `opencodeAgent`).
 *
 * opencode is started with `XDG_CONFIG_HOME` pointing at an empty directory,
 * which hides `~/.config/opencode`. Every process opencode spawns would
 * inherit that, and `gh` (auth in `~/.config/gh`), git and other XDG tools
 * would lose their config with it. opencode reads `XDG_CONFIG_HOME` once at
 * start, so this hook can hand the host's value back to each shell command
 * (opencode's `shell.env` plugin hook) without un-hiding opencode's own
 * config.
 *
 * Loaded by opencode from its file URL; it must not import anything.
 */

type ShellEnvOutput = { env: Record<string, string> };

export const FactoryHostShellEnv = async () => ({
  "shell.env": async (_input: unknown, output: ShellEnvOutput) => {
    const host = process.env.FACTORY_HOST_XDG_CONFIG_HOME;
    if (host) output.env.XDG_CONFIG_HOME = host;
  },
});
