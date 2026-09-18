/**
 * The live `AgentAdapter`: `chat()` + `withSandbox(localProcessSandbox)` +
 * `opencodeText`, exactly the plumbing proven in `src/spike/lib/effect-agent-step.ts`
 * (ADR 0001 §5). D15: `localProcessSandbox({dir})` implements D8, paired with
 * `defineWorkspace({source:{type:"none"}, setup:[]})` to get `lifecycle.reuse:"thread"`.
 *
 * ADR 0012 §2: this adapter interprets its own stream. `@tanstack/ai-opencode`'s
 * CUSTOM event names are an implementation detail of *this file* — the
 * interpreter turns them into the normalized `AgentSignal` union, and nothing
 * outside here ever matches a vendor event name again.
 */

import { chat } from "@tanstack/ai";
import { opencodeText } from "@tanstack/ai-opencode";
import { defineSandbox, defineWorkspace, withSandbox } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import net from "node:net";
import type {
  AgentAdapter,
  AgentAdapterOptions,
  AgentSignal,
  AgentStreamItem,
} from "./agent-adapter";

/**
 * The adapter boots `opencode serve --port=…` inside the run's sandbox on a
 * fixed port (the package's DEFAULT_PORT 4096). Under `localProcessSandbox`
 * the sandbox is the host itself, so two concurrent runs both try to bind
 * that same host port — the first wins, the second exits before readiness
 * ("opencode serve exited before becoming ready"). Found live in phase 5's
 * P6 concurrency leg on 2026-09-15 (two runs ~1s apart: the later one failed
 * deterministically). Per-call free-port resolution removes the collision;
 * only valid while the sandbox is the host — a published-ports docker path
 * will need this revisited.
 */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Interpret one raw opencode-stream chunk into `{chunk, signal}`.
 *
 * `structured-output.complete` is not a provider capability: the opencode
 * *text* adapter simulates structured output by injecting JSON Schema into
 * the prompt and re-parsing its own final message (ADR 0001 §1). Here is
 * where that simulation is decoded into the neutral signal; an adapter over
 * a natively structured-output-capable provider emits the same signal from a
 * different mechanism, and the runtime cannot tell the difference.
 */
export function interpretOpencodeChunk(chunk: unknown): AgentStreamItem {
  const record = chunk as {
    type?: unknown;
    name?: unknown;
    value?: unknown;
    message?: unknown;
  };

  if (record.type === "CUSTOM" && typeof record.name === "string") {
    if (record.name === "structured-output.complete") {
      const value = record.value as { object?: unknown } | undefined;
      return {
        chunk,
        signal: { kind: "structured-output", value: value?.object } satisfies AgentSignal,
      };
    }
    if (record.name === "opencode.session-id") {
      const value = record.value as { sessionId?: unknown } | undefined;
      if (typeof value?.sessionId === "string") {
        return { chunk, signal: { kind: "session", sessionId: value.sessionId } satisfies AgentSignal };
      }
    }
  }

  if (record.type === "RUN_ERROR") {
    const message =
      typeof record.message === "string" ? record.message : JSON.stringify(chunk);
    return { chunk, signal: { kind: "error", message } satisfies AgentSignal };
  }

  return { chunk };
}

export const opencodeAdapter: AgentAdapter = {
  async *stream(options: AgentAdapterOptions): AsyncIterable<AgentStreamItem> {
    const sandboxDefinition = defineSandbox({
      id: "factory-run",
      provider: localProcessSandbox({ dir: options.dir }),
      workspace: defineWorkspace({ source: { type: "none" }, setup: [] }),
      lifecycle: { reuse: "thread", destroyOnComplete: false },
    });

    const port = await freePort();

    const baseChatOptions = {
      threadId: options.threadId,
      adapter: opencodeText(options.model, {
        permissionMode: "acceptEdits" as const,
        port,
      }),
      messages: [{ role: "user" as const, content: options.prompt }],
      middleware: [withSandbox(sandboxDefinition)],
      abortController: options.abortController,
    };

    // Branch the call itself (not spread/ternary) so each `chat()` overload
    // resolves cleanly; the caller treats every chunk as `unknown` regardless.
    const stream =
      options.outputSchema !== undefined
        ? (chat({
            ...baseChatOptions,
            outputSchema: options.outputSchema,
            stream: true,
          } as unknown as Parameters<typeof chat>[0]) as AsyncIterable<unknown>)
        : (chat(baseChatOptions) as unknown as AsyncIterable<unknown>);

    for await (const chunk of stream) {
      yield interpretOpencodeChunk(chunk);
    }
  },
};
