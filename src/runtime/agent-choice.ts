/**
 * Which agent runs a `ctx.agent` step, and on which model (ADR 0013 §2).
 *
 * `agent` and `model` are separate fields at every level of the precedence
 * chain, most specific first:
 *
 *   call (`ctx.agent` options) > run (the run request, or the schedule that
 *   started it) > workflow (`defineWorkflow`'s `agent`) > config
 *   (`agent.default` / `agent.models`)
 *
 * - **Agent:** the most specific level that names one, else
 *   `config.agent.default`.
 * - **Model:** the most specific level that names one, counting only the
 *   level that chose the agent and the levels more specific than it; else
 *   `config.agent.models[agent]`.
 *
 * A model never carries across a change of agent: a workflow pinned to
 * `sonnet`, called once with `{ agent: "opencode" }`, runs on opencode's
 * configured model, not on an invalid `sonnet`. And factory always sends a
 * model — an agent left on its own default runs on the host's settings
 * (finding 13 §1) — so a step whose model resolves to nothing fails before
 * the agent starts, naming the fix.
 */

import { ACP_AGENT_KINDS, type AcpAgentKind } from "./acp-agents";

/** One level's say in the choice. Either field may be absent. */
export interface AgentChoice {
  readonly agent?: AcpAgentKind;
  readonly model?: string;
}

/** The config rung: the default agent, and each agent's default model. */
export interface AgentDefaults {
  readonly default: AcpAgentKind;
  readonly models: Readonly<Partial<Record<AcpAgentKind, string>>>;
}

/** What a step runs on. */
export interface ResolvedAgent {
  readonly agent: AcpAgentKind;
  readonly model: string;
}

/**
 * The agent a project without `agent.default` runs on. opencode, because it
 * was factory's only agent before ADR 0013. There is deliberately no
 * built-in *model*: model ids belong to the agent and the host (ADR 0013 §2).
 */
export const DEFAULT_AGENT: AcpAgentKind = "opencode";

export function isAcpAgentKind(value: unknown): value is AcpAgentKind {
  return typeof value === "string" && (ACP_AGENT_KINDS as ReadonlyArray<string>).includes(value);
}

/** A step's agent or model could not be resolved. Thrown before the agent starts. */
export class AgentChoiceError extends Error {
  override readonly name = "AgentChoiceError";
}

/**
 * Resolve `levels` (most specific first; `undefined` for a level that says
 * nothing) over `defaults`. Throws `AgentChoiceError` for an unknown agent
 * name or an unresolvable model.
 */
export function resolveAgentChoice(
  levels: ReadonlyArray<AgentChoice | undefined>,
  defaults: AgentDefaults,
): ResolvedAgent {
  for (const level of levels) {
    if (level?.agent !== undefined && !isAcpAgentKind(level.agent)) {
      throw new AgentChoiceError(
        `unknown agent ${JSON.stringify(level.agent)}; expected one of ${ACP_AGENT_KINDS.join(", ")}`,
      );
    }
  }
  const chooser = levels.findIndex((level) => level?.agent !== undefined);
  const agent = chooser === -1 ? defaults.default : (levels[chooser]!.agent as AcpAgentKind);
  // Only the chooser and the levels above it may name the model: a model
  // named below the level that changed the agent belongs to another agent.
  const eligible = chooser === -1 ? levels : levels.slice(0, chooser + 1);
  const model =
    eligible.find((level) => level?.model !== undefined)?.model ?? defaults.models[agent];
  if (model === undefined) {
    throw new AgentChoiceError(
      `no model for agent "${agent}": name one with \`model\` on the ctx.agent call, the run, ` +
        `the schedule or the workflow, or set \`agent.models.${agent}\` in factory.config.ts`,
    );
  }
  return { agent, model };
}
