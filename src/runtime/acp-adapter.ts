/**
 * SPIKE (finding 13): an `AgentAdapter` that drives any ACP-speaking coding
 * agent over stdio — opencode (`opencode acp`) and Claude Code
 * (`@agentclientprotocol/claude-agent-acp`) — in place of `@tanstack/ai-opencode`.
 *
 * Ported from canvas's `src/server/agents.ts` (canvas findings 01 and 04):
 * `@agentclientprotocol/sdk` speaks ACP directly, because `chat()` +
 * `acpCompatible` drops `session/new`'s `configOptions` and cannot call
 * `session/set_config_option` — and that is the only way to pick a model in
 * either agent. AG-UI chunks still come from `@tanstack/ai-acp`'s
 * `translateAcpStream`, so stored chunks and the SPA stay AG-UI (ADR 0003 §2).
 *
 * One agent process per `stream()` call: a factory step is one fresh session
 * and one prompt, so canvas's idle timer and reconnect logic have no job here.
 * Headless permission is answered here, by the client, for either agent:
 * every ask is allowed (the #24 policy, without writing `opencode.json`).
 */

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PlanEntry,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import {
  appendOutputSchemaInstruction,
  parseJsonFromAssistantText,
} from "@tanstack/ai/adapter-internals";
import {
  AsyncQueue,
  translateAcpStream,
  type AcpSessionUpdate,
  type AcpStreamEvent,
} from "@tanstack/ai-acp";
import type { AgentAdapter, AgentAdapterOptions, AgentAdapterYield } from "./agent-adapter";

export type AcpAgentKind = "claude" | "opencode";

export interface AcpAgentDefinition {
  readonly kind: AcpAgentKind;
  readonly command: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
  /** Agent-specific `_meta` for `session/new`. */
  readonly sessionMeta?: Record<string, unknown>;
}

/** What the spike measures; a production adapter would not have this. */
export type AcpDiagnostic =
  | { readonly kind: "spawned"; readonly pid: number; readonly at: number }
  | { readonly kind: "initialized"; readonly at: number; readonly agentInfo: unknown }
  | {
      readonly kind: "session";
      readonly at: number;
      readonly sessionId: string;
      readonly configOptions: ReadonlyArray<SessionConfigOption>;
    }
  | {
      readonly kind: "configured";
      readonly at: number;
      readonly configId: string;
      readonly value: string;
      readonly configOptions: ReadonlyArray<SessionConfigOption>;
    }
  | {
      readonly kind: "permission";
      readonly at: number;
      readonly title: string;
      readonly options: ReadonlyArray<{ optionId: string; kind: string }>;
      readonly chosen: string | null;
    }
  | { readonly kind: "update"; readonly at: number; readonly update: SessionUpdate }
  | {
      readonly kind: "done";
      readonly at: number;
      readonly stopReason: string;
      readonly usage: unknown;
    }
  | { readonly kind: "exited"; readonly at: number; readonly code: number | null };

const claudeAcpBin = Bun.resolveSync(
  "@agentclientprotocol/claude-agent-acp/dist/index.js",
  import.meta.dir,
);

export const ACP_AGENTS: Record<AcpAgentKind, AcpAgentDefinition> = {
  claude: { kind: "claude", command: ["bun", claudeAcpBin] },
  opencode: { kind: "opencode", command: ["opencode", "acp"] },
};

/** Model choices an option offers, flattened out of its groups. */
function choicesOf(option: SessionConfigOption): string[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "group" in entry ? entry.options.map((c) => c.value) : [entry.value],
  );
}

/** Allow every ask, preferring "always" so the agent stops asking (#24). */
function headlessAllow(request: RequestPermissionRequest): string | null {
  const pick =
    request.options.find((o) => o.kind === "allow_always") ??
    request.options.find((o) => o.kind === "allow_once");
  return pick?.optionId ?? null;
}

/**
 * opencode keeps its todo list in `todowrite`'s input and sends no ACP
 * `plan` update; read it as one, so every agent has one kind of plan
 * (canvas `todo-plan.ts`).
 */
function todoPlan(update: SessionUpdate): SessionUpdate | null {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")
    return null;
  const input = update.rawInput as { todos?: unknown } | null | undefined;
  if (!Array.isArray(input?.todos)) return null;
  const entries = input.todos.flatMap((todo: unknown): PlanEntry[] => {
    const { content, status } = (todo ?? {}) as Record<string, unknown>;
    if (typeof content !== "string") return [];
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return [];
    return [{ content, status, priority: "medium" }];
  });
  return entries.length ? { sessionUpdate: "plan", entries } : null;
}

export function acpAdapter(
  definition: AcpAgentDefinition,
  observe: (event: AcpDiagnostic) => void = () => {},
): AgentAdapter {
  return {
    // Permission is answered by the client (`headlessAllow`); nothing to write.
    async prepareWorkspace(): Promise<void> {},

    async *stream(options: AgentAdapterOptions): AsyncIterable<AgentAdapterYield> {
      const child = Bun.spawn([...definition.command], {
        cwd: options.dir,
        env: { ...process.env, ...definition.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      observe({ kind: "spawned", pid: child.pid, at: Date.now() });

      let stderr = "";
      void (async () => {
        for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream()))
          stderr = (stderr + chunk).slice(-4096);
      })().catch(() => undefined);

      const queue = new AsyncQueue<AcpStreamEvent>();
      const exited = child.exited.then((code) => {
        observe({ kind: "exited", at: Date.now(), code });
        const tail = stderr.trim().split("\n").at(-1);
        throw new Error(`${definition.kind} exited (code ${code})${tail ? `: ${tail}` : ""}`);
      });
      exited.catch((cause: unknown) => queue.fail(cause));
      const race = <T>(work: Promise<T>) => Promise.race([work, exited]);

      const acp = new ClientSideConnection(
        () => ({
          requestPermission: async (request): Promise<RequestPermissionResponse> => {
            const chosen = headlessAllow(request);
            observe({
              kind: "permission",
              at: Date.now(),
              title: request.toolCall.title ?? "tool call",
              options: request.options.map((o) => ({ optionId: o.optionId, kind: o.kind })),
              chosen,
            });
            return {
              outcome:
                chosen === null
                  ? { outcome: "cancelled" }
                  : { outcome: "selected", optionId: chosen },
            };
          },
          sessionUpdate: async ({ update }) => {
            observe({ kind: "update", at: Date.now(), update });
            if (update.sessionUpdate === "config_option_update") return;
            if (update.sessionUpdate === "usage_update") return;
            queue.push({ kind: "update", update: update as AcpSessionUpdate });
            const plan = todoPlan(update);
            if (plan) queue.push({ kind: "update", update: plan as AcpSessionUpdate });
          },
        }),
        ndJsonStream(
          new WritableStream<Uint8Array>({
            write: (chunk) => {
              void child.stdin.write(chunk);
              void child.stdin.flush();
            },
            close: () => void child.stdin.end(),
          }),
          child.stdout,
        ),
      );

      let sessionId: string | undefined;
      const onAbort = () => {
        if (sessionId !== undefined) void acp.cancel({ sessionId }).catch(() => undefined);
        // Give the agent a moment to settle the turn as `cancelled`, then make sure.
        setTimeout(() => child.kill(), 2000).unref();
      };
      options.abortController.signal.addEventListener("abort", onAbort, { once: true });

      try {
        const init = await race(
          acp.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: { name: "factory", version: "0.0.0" },
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          }),
        );
        observe({ kind: "initialized", at: Date.now(), agentInfo: init.agentInfo });

        const created = await race(
          acp.newSession({
            cwd: options.dir,
            mcpServers: [],
            ...(definition.sessionMeta && { _meta: definition.sessionMeta }),
          }),
        );
        sessionId = created.sessionId;
        let configOptions = created.configOptions ?? [];
        observe({ kind: "session", at: Date.now(), sessionId, configOptions });

        // The model decides which other options exist, so it goes first and
        // fails loudly: a workflow asked for it, and running on another
        // model silently is worse than not running.
        const modelOption = configOptions.find((o) => o.category === "model" || o.id === "model");
        if (modelOption === undefined) throw new Error(`${definition.kind} offers no model option`);
        if (modelOption.currentValue !== options.model) {
          const choices = choicesOf(modelOption);
          if (!choices.includes(options.model))
            throw new Error(
              `${definition.kind} has no model "${options.model}" (${choices.length} offered, e.g. ${choices.slice(0, 8).join(", ")})`,
            );
          const response = await race(
            acp.setSessionConfigOption({
              sessionId,
              configId: modelOption.id,
              value: options.model,
            }),
          );
          configOptions = response.configOptions;
          observe({
            kind: "configured",
            at: Date.now(),
            configId: modelOption.id,
            value: options.model,
            configOptions,
          });
        }

        const prompt =
          options.outputSchema !== undefined
            ? appendOutputSchemaInstruction(options.prompt, options.outputSchema)
            : options.prompt;
        queue.push({ kind: "session", sessionId });
        void acp
          .prompt({ sessionId, prompt: [{ type: "text", text: prompt }] })
          .then((response) => {
            observe({
              kind: "done",
              at: Date.now(),
              stopReason: response.stopReason,
              usage: response.usage,
            });
            queue.push({
              kind: "done",
              stopReason: response.stopReason,
              ...(response.usage && { usage: response.usage }),
            });
            queue.end();
          })
          .catch((cause: unknown) => queue.fail(cause));

        const runId = crypto.randomUUID();
        const chunks = translateAcpStream(queue, {
          model: options.model,
          runId,
          threadId: options.threadId,
          genId: () => crypto.randomUUID(),
          labels: {
            sessionIdEvent: "acp.session-id",
            contentEvent: "acp.message-content",
            planEvent: "acp.plan",
          },
        });

        let lastText = "";
        let finished: unknown;
        for await (const chunk of chunks) {
          const record = chunk as { type: string; delta?: unknown; message?: unknown };
          if (record.type === "TEXT_MESSAGE_START") lastText = "";
          else if (record.type === "TEXT_MESSAGE_CONTENT" && typeof record.delta === "string")
            lastText += record.delta;
          if (record.type === "RUN_FINISHED" && options.outputSchema !== undefined) {
            // Hold it: the structured output goes before the run's end.
            finished = chunk;
            continue;
          }
          if (record.type === "CUSTOM" && (chunk as { name?: string }).name === "acp.session-id") {
            yield { chunk, signal: { _tag: "sessionId", value: sessionId } };
          } else if (record.type === "RUN_ERROR") {
            const message = typeof record.message === "string" ? record.message : "agent error";
            yield { chunk, signal: { _tag: "runError", value: message } };
          } else yield { chunk };
        }

        if (options.outputSchema !== undefined) {
          try {
            const object = parseJsonFromAssistantText(lastText);
            yield {
              chunk: {
                type: "CUSTOM",
                name: "structured-output.complete",
                value: { object, raw: lastText },
                timestamp: Date.now(),
              },
              signal: { _tag: "structuredOutput", value: object },
            };
          } catch {
            // No JSON in the last message: the runtime's tier-2 re-parse of
            // `finalText` gets the same text and reports the miss.
          }
          if (finished !== undefined) yield { chunk: finished };
        }
      } finally {
        options.abortController.signal.removeEventListener("abort", onAbort);
        child.kill();
      }
    },
  };
}
