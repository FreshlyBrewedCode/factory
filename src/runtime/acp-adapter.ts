/**
 * An `AgentAdapter` that drives any ACP-speaking coding agent over stdio
 * (ADR 0013): opencode (`opencode acp`) and Claude Code
 * (`@agentclientprotocol/claude-agent-acp`). What differs per agent lives in
 * its definition (`acp-agents.ts`); this module knows no agent by name.
 *
 * Ported from canvas's `src/server/agents.ts` (canvas findings 01, 04) and
 * proven in finding 13. `@agentclientprotocol/sdk` speaks ACP directly,
 * because `chat()` + `acpCompatible` drops `session/new`'s `configOptions`
 * and cannot call `session/set_config_option` — the only way to pick a model
 * in either agent. AG-UI chunks come from `@tanstack/ai-acp`'s
 * `translateAcpStream`, so stored chunks and the SPA stay AG-UI (ADR 0003 §2).
 *
 * One agent process per `stream()` call (ADR 0013 §6): spawn, `initialize`,
 * `session/new`, set the model, `session/prompt`, kill. A step is one fresh
 * session and one prompt, so canvas's idle timer and reconnect have no job.
 *
 * - **Model** (§2): required. A model the agent does not offer fails the step
 *   before the prompt, naming the agent and some of the ids it does offer.
 * - **Permission** (§4): every ask is allowed, `allow_always` before
 *   `allow_once` — #24's policy, without writing a file into the tree.
 * - **Usage** (§5): each ACP `usage_update` becomes a `CUSTOM` `acp.usage`
 *   chunk carrying a `usage` signal, in stream order.
 * - **Cancel** (§6): ACP `session/cancel`, then a kill after a grace period;
 *   always a kill in `finally`.
 * - **Exit mid-turn**: the step fails with the agent's exit code and the tail
 *   of its stderr.
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
import { resolve } from "node:path";
import { agentEnv, type AcpAgentDefinition } from "./acp-agents";
import type {
  AgentAdapter,
  AgentAdapterOptions,
  AgentAdapterYield,
  AgentUsage,
} from "./agent-adapter";

/** CUSTOM chunk names this adapter emits. */
export const ACP_CHUNK = {
  sessionId: "acp.session-id",
  content: "acp.message-content",
  plan: "acp.plan",
  usage: "acp.usage",
  structuredOutput: "structured-output.complete",
} as const;

/** What happened on the wire, for the spike runner and tests; not persisted. */
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

export interface AcpAdapterOptions {
  /** Called for every `AcpDiagnostic`. */
  readonly onDiagnostic?: (event: AcpDiagnostic) => void;
  /** How long a cancelled agent gets to settle its turn before it is killed. Default 2000. */
  readonly cancelGraceMs?: number;
}

/** A failure the adapter itself detected: bad model, agent exit, protocol gap. */
export class AcpAgentError extends Error {
  override readonly name = "AcpAgentError";
}

const STDERR_KEEP = 8192;
const STDERR_TAIL_LINES = 12;

/** Model choices an option offers, flattened out of its groups. */
export function choicesOf(option: SessionConfigOption): string[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "group" in entry ? entry.options.map((c) => c.value) : [entry.value],
  );
}

/** Allow every ask, preferring "always" so the agent stops asking (#24). */
export function headlessAllow(request: Pick<RequestPermissionRequest, "options">): string | null {
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
export function todoPlan(update: SessionUpdate): SessionUpdate | null {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")
    return null;
  const input = update.rawInput as { todos?: unknown } | null | undefined;
  if (!Array.isArray(input?.todos)) return null;
  const entries = input.todos.flatMap((todo: unknown): PlanEntry[] => {
    const { content, status, priority } = (todo ?? {}) as Record<string, unknown>;
    if (typeof content !== "string") return [];
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return [];
    return [
      {
        content,
        status,
        priority: priority === "high" || priority === "low" ? priority : "medium",
      },
    ];
  });
  return entries.length ? { sessionUpdate: "plan", entries } : null;
}

/** An ACP `usage_update` as factory's `AgentUsage`. */
export function usageOf(update: {
  used: number;
  size: number;
  cost?: { amount: number; currency: string } | null;
}): AgentUsage {
  return {
    context: { used: update.used, size: update.size },
    ...(update.cost != null && {
      cost: { amount: update.cost.amount, currency: update.cost.currency },
    }),
  };
}

/** What the adapter's own queue carries: ACP events, plus usage, which AG-UI has no event for. */
type Incoming = AcpStreamEvent | { readonly kind: "usage"; readonly usage: AgentUsage };

/**
 * Drive `translateAcpStream` one input event at a time, so the adapter can
 * put its own chunks (usage) between the translated ones in arrival order.
 * `feed` hands the translator one event and returns what it yielded before
 * asking for the next; `fail` and `end` close its input.
 */
function stepTranslator<O>(translate: (input: AsyncIterable<AcpStreamEvent>) => AsyncIterable<O>) {
  let give: { resolve: (r: IteratorResult<AcpStreamEvent>) => void; reject: (e: unknown) => void };
  let asked!: () => void;
  let askedNext = new Promise<void>((resolve) => (asked = resolve));
  const source: AsyncIterable<AcpStreamEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<AcpStreamEvent>>((resolve, reject) => {
          give = { resolve, reject };
          asked();
        }),
    }),
  };
  const output = translate(source)[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<O>> = output.next();

  /**
   * Collect what the translator yields until it asks for input again, ends,
   * or throws — keeping what it yielded before throwing (it closes open text
   * and tool calls on the way out).
   */
  async function drain(): Promise<{ chunks: O[]; done: boolean; error?: unknown }> {
    const chunks: O[] = [];
    for (;;) {
      let result: IteratorResult<O> | "asked";
      try {
        result = await Promise.race([pending, askedNext.then(() => "asked" as const)]);
      } catch (error) {
        return { chunks, done: true, error };
      }
      if (result === "asked") return { chunks, done: false };
      if (result.done === true) return { chunks, done: true };
      chunks.push(result.value);
      pending = output.next();
    }
  }
  const handOver = async (send: () => void) => {
    // Wait until the translator is actually waiting on its input.
    await Promise.race([askedNext, pending]).catch(() => undefined);
    askedNext = new Promise<void>((resolve) => (asked = resolve));
    send();
    return drain();
  };
  return {
    feed: (event: AcpStreamEvent) => handOver(() => give.resolve({ value: event, done: false })),
    end: () => handOver(() => give.resolve({ value: undefined, done: true })),
    fail: (cause: unknown) => handOver(() => give.reject(cause)),
  };
}

export function acpAdapter(
  definition: AcpAgentDefinition,
  adapterOptions: AcpAdapterOptions = {},
): AgentAdapter {
  const observe = adapterOptions.onDiagnostic ?? (() => {});
  const cancelGraceMs = adapterOptions.cancelGraceMs ?? 2000;
  const name = definition.agent;

  return {
    // Permission is answered by the client (`headlessAllow`); nothing to write.
    async prepareWorkspace(): Promise<void> {},

    async *stream(options: AgentAdapterOptions): AsyncIterable<AgentAdapterYield> {
      if (options.model.trim() === "")
        throw new AcpAgentError(`${name}: no model given; factory always sends one`);
      const signal = options.abortController.signal;
      if (signal.aborted) return;
      // ACP requires an absolute `cwd`; a workspace root may be relative
      // (`.factory/workspaces`, the default), resolved against the daemon's.
      const cwd = resolve(options.dir);

      let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
      try {
        child = Bun.spawn([...definition.command], {
          cwd,
          env: agentEnv(definition),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (cause) {
        throw new AcpAgentError(
          `${name} did not start (${definition.command[0]}): ${String(cause)}`,
        );
      }
      observe({ kind: "spawned", pid: child.pid, at: Date.now() });

      let stderr = "";
      const stderrDone = (async () => {
        for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream()))
          stderr = (stderr + chunk).slice(-STDERR_KEEP);
      })().catch(() => undefined);

      const incoming = new AsyncQueue<Incoming>();
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
            if (update.sessionUpdate === "usage_update") {
              incoming.push({ kind: "usage", usage: usageOf(update) });
              return;
            }
            incoming.push({ kind: "update", update: update as AcpSessionUpdate });
            const plan = todoPlan(update);
            if (plan) incoming.push({ kind: "update", update: plan as AcpSessionUpdate });
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

      // The agent is gone once it has exited and its stdout is read to the
      // end — so a reply it wrote just before exiting still lands first.
      let exitedCode: number | null | undefined;
      const died: Promise<AcpAgentError> = Promise.all([
        child.exited,
        acp.closed.catch(() => undefined),
      ]).then(async ([code]) => {
        exitedCode = code;
        observe({ kind: "exited", at: Date.now(), code });
        await Promise.race([stderrDone, Bun.sleep(200)]);
        const tail = stderr.trim().split("\n").slice(-STDERR_TAIL_LINES).join("\n");
        return new AcpAgentError(
          `${name} exited (code ${code ?? "signal"})${tail ? `; stderr:\n${tail}` : ""}`,
        );
      });
      void died.then((error) => incoming.fail(error));
      const race = <T>(work: Promise<T>) =>
        Promise.race([work, died.then((error) => Promise.reject(error))]);

      let sessionId: string | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (sessionId === undefined) {
          child.kill();
          return;
        }
        void acp.cancel({ sessionId }).catch(() => undefined);
        // Give the agent a moment to settle the turn as `cancelled`, then make sure.
        killTimer = setTimeout(() => child.kill(), cancelGraceMs);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        const init = await race(
          acp.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: { name: "factory", version: "0.0.0" },
            // The agent works in the tree directly; it never needs our fs.
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          }),
        );
        observe({ kind: "initialized", at: Date.now(), agentInfo: init.agentInfo });

        const created = await race(
          acp.newSession({
            cwd,
            mcpServers: [],
            ...(definition.sessionMeta && { _meta: { ...definition.sessionMeta } }),
          }),
        );
        sessionId = created.sessionId;
        const configOptions = created.configOptions ?? [];
        observe({ kind: "session", at: Date.now(), sessionId, configOptions });
        if (signal.aborted) return;

        // The model decides which other options exist, so it goes first, and
        // it fails loudly: running silently on another model is worse than not
        // running (ADR 0013 §2).
        const modelOption = configOptions.find((o) => o.category === "model" || o.id === "model");
        if (modelOption === undefined)
          throw new AcpAgentError(
            `${name} offers no model option; cannot select "${options.model}"`,
          );
        if (modelOption.currentValue !== options.model) {
          const choices = choicesOf(modelOption);
          if (!choices.includes(options.model))
            throw new AcpAgentError(
              `${name} has no model "${options.model}" (${choices.length} offered, e.g. ${choices.slice(0, 8).join(", ")})`,
            );
          const response = await race(
            acp.setSessionConfigOption({
              sessionId,
              configId: modelOption.id,
              value: options.model,
            }),
          );
          observe({
            kind: "configured",
            at: Date.now(),
            configId: modelOption.id,
            value: options.model,
            configOptions: response.configOptions,
          });
        }
        if (signal.aborted) return;

        const prompt =
          options.outputSchema !== undefined
            ? appendOutputSchemaInstruction(options.prompt, options.outputSchema)
            : options.prompt;
        incoming.push({ kind: "session", sessionId });
        void acp
          .prompt({ sessionId, prompt: [{ type: "text", text: prompt }] })
          .then((response) => {
            observe({
              kind: "done",
              at: Date.now(),
              stopReason: response.stopReason,
              usage: response.usage,
            });
            incoming.push({
              kind: "done",
              stopReason: response.stopReason,
              ...(response.usage && { usage: response.usage }),
            });
            incoming.end();
          })
          .catch(async (cause: unknown) => {
            // A dying agent rejects the pending prompt first; prefer the exit
            // (with its stderr) when that is what happened.
            const exit = await Promise.race([died, Bun.sleep(500).then(() => undefined)]);
            incoming.fail(exit ?? cause);
          });

        const translator = stepTranslator((input) =>
          translateAcpStream(input, {
            model: options.model,
            runId: crypto.randomUUID(),
            threadId: options.threadId,
            genId: () => crypto.randomUUID(),
            labels: {
              sessionIdEvent: ACP_CHUNK.sessionId,
              contentEvent: ACP_CHUNK.content,
              planEvent: ACP_CHUNK.plan,
            },
          }),
        );

        let lastText = "";
        let held: unknown;
        const handle = function* (chunks: ReadonlyArray<unknown>): Generator<AgentAdapterYield> {
          for (const chunk of chunks) {
            const record = chunk as {
              type: string;
              name?: unknown;
              delta?: unknown;
              message?: unknown;
            };
            if (record.type === "TEXT_MESSAGE_START") lastText = "";
            else if (record.type === "TEXT_MESSAGE_CONTENT" && typeof record.delta === "string")
              lastText += record.delta;
            if (record.type === "RUN_FINISHED" && options.outputSchema !== undefined) {
              // Hold it: the structured output goes before the run's end.
              held = chunk;
            } else if (record.type === "CUSTOM" && record.name === ACP_CHUNK.sessionId) {
              yield { chunk, signal: { _tag: "sessionId", value: sessionId! } };
            } else if (record.type === "RUN_ERROR") {
              const message = typeof record.message === "string" ? record.message : "agent error";
              yield { chunk, signal: { _tag: "runError", value: message } };
            } else yield { chunk };
          }
        };

        let done = false;
        try {
          for await (const event of incoming) {
            if (event.kind === "usage") {
              yield {
                chunk: {
                  type: "CUSTOM",
                  name: ACP_CHUNK.usage,
                  value: event.usage,
                  model: options.model,
                  timestamp: Date.now(),
                },
                signal: { _tag: "usage", value: event.usage },
              };
              continue;
            }
            const step = await translator.feed(event);
            yield* handle(step.chunks);
            if (step.error !== undefined) throw step.error;
            if (step.done) {
              done = true;
              break;
            }
          }
          if (!done) {
            const step = await translator.end();
            yield* handle(step.chunks);
            if (step.error !== undefined) throw step.error;
          }
        } catch (cause) {
          if (done) throw cause;
          done = true;
          // Let the translator close what it opened (text, tool calls), then fail.
          yield* handle((await translator.fail(cause)).chunks);
          throw cause;
        }

        if (options.outputSchema !== undefined) {
          try {
            const object = parseJsonFromAssistantText(lastText);
            yield {
              chunk: {
                type: "CUSTOM",
                name: ACP_CHUNK.structuredOutput,
                value: { object, raw: lastText },
                model: options.model,
                timestamp: Date.now(),
              },
              signal: { _tag: "structuredOutput", value: object },
            };
          } catch {
            // No JSON in the last message: the runtime's tier-2 re-parse of
            // `finalText` gets the same text and reports the miss.
          }
          if (held !== undefined) yield { chunk: held };
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        clearTimeout(killTimer);
        if (exitedCode === undefined) {
          child.kill();
          const gone = await Promise.race([
            child.exited.then(() => true),
            Bun.sleep(cancelGraceMs).then(() => false),
          ]);
          if (!gone) child.kill("SIGKILL");
        }
      }
    },
  };
}
