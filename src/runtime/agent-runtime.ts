/**
 * The agent runtime as an Effect context service (ADR 0012 §4).
 *
 * The runtime is the daemon's first service to move into Effect's dependency
 * injection: it stops being a value threaded through every interface between
 * the CLI and the step runner, and becomes a service resolved from context at
 * the point of use (`runtime/agent-step.ts`, `runtime/run.ts`).
 *
 * It carries the adapter (issue #36) and the config rung of the agent/model
 * choice (ADR 0013 §2): the default agent and each agent's default model.
 * The step resolves its agent and model against those, and hands both to the
 * adapter.
 *
 * The default adapter is the ACP runtime (ADR 0013 §1): one generic ACP
 * adapter per agent definition, picked per step by `AgentAdapterOptions.agent`.
 * `config.agent.adapter` stays the injection point for replay and fakes; an
 * injected adapter receives the resolved agent and may ignore it.
 */

import { Context, Layer, ManagedRuntime } from "effect";
import { acpAdapter } from "./acp-adapter";
import {
  acpAgent,
  type AcpAgentDefinition,
  type AcpAgentKind,
  type AcpAgentOptions,
  type HostSettings,
} from "./acp-agents";
import type { AgentAdapter, AgentAdapterOptions } from "./agent-adapter";
import { DEFAULT_AGENT, type AgentDefaults } from "./agent-choice";

export interface AgentRuntimeShape {
  /** The adapter that produces agent chunk streams (ADR 0012 §2). */
  readonly adapter: AgentAdapter;
  /** The config rung of the agent/model resolution (ADR 0013 §2). */
  readonly defaults: AgentDefaults;
}

/** What builds an agent runtime: `factory.config.ts`'s `agent` block, all optional. */
export interface AgentRuntimeConfig {
  /** Replaces the ACP runtime (replay, fakes). */
  readonly adapter?: AgentAdapter;
  /** The agent a step runs on when no level names one. Default `DEFAULT_AGENT`. */
  readonly default?: AcpAgentKind;
  /** Each agent's model when no level that may name one does. */
  readonly models?: Readonly<Partial<Record<AcpAgentKind, string>>>;
  /** Whether runs see the host's own settings, per agent. Default `"ignore"` (ADR 0013 §3). */
  readonly hostSettings?: Readonly<Partial<Record<AcpAgentKind, HostSettings>>>;
}

/**
 * The ACP runtime: each step launches the agent it resolved to, through one
 * generic `acpAdapter` per agent definition. Definitions are built on first
 * use, so an agent nobody calls is never set up.
 */
export function acpAgentsAdapter(
  hostSettings: Readonly<Partial<Record<AcpAgentKind, HostSettings>>> = {},
  /** The definition for an agent; `acpAgent` outside of tests. */
  define: (agent: AcpAgentKind, options: AcpAgentOptions) => AcpAgentDefinition = acpAgent,
): AgentAdapter {
  const adapters = new Map<AcpAgentKind, AgentAdapter>();
  const adapterFor = (agent: AcpAgentKind): AgentAdapter => {
    let adapter = adapters.get(agent);
    if (adapter === undefined) {
      adapter = acpAdapter(define(agent, { hostSettings: hostSettings[agent] ?? "ignore" }));
      adapters.set(agent, adapter);
    }
    return adapter;
  };
  return {
    // Permission is answered by the client; there is nothing to prepare.
    async prepareWorkspace(): Promise<void> {},
    stream: (options: AgentAdapterOptions) => adapterFor(options.agent).stream(options),
  };
}

/**
 * The agent-runtime service. Yield it inside an Effect to read the adapter
 * and the defaults; provide it with `AgentRuntimeLayer`.
 */
export class AgentRuntime extends Context.Service<AgentRuntime, AgentRuntimeShape>()(
  "AgentRuntime",
) {}

/**
 * A layer that provides the agent runtime for `config`: its `adapter`, or
 * the ACP runtime when none is given. This is the single place the default
 * lives.
 */
export const AgentRuntimeLayer = (config: AgentRuntimeConfig = {}): Layer.Layer<AgentRuntime> =>
  Layer.succeed(AgentRuntime, {
    adapter: config.adapter ?? acpAgentsAdapter(config.hostSettings),
    defaults: { default: config.default ?? DEFAULT_AGENT, models: config.models ?? {} },
  });

/**
 * Build a `ManagedRuntime` providing the agent runtime — the composition root
 * of the CLI's direct-run path, and a convenience for tests. The caller owns
 * it and must `dispose()` it once its runs are done.
 */
export const makeAgentRuntime = (
  config?: AgentRuntimeConfig,
): ManagedRuntime.ManagedRuntime<AgentRuntime, never> =>
  ManagedRuntime.make(AgentRuntimeLayer(config));
