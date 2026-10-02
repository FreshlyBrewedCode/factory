/**
 * The live `AgentAdapter`: `chat()` + `withSandbox(localProcessSandbox)` +
 * `opencodeText`, exactly the plumbing proven in `src/spike/lib/effect-agent-step.ts`
 * (ADR 0001 §5). D15: `localProcessSandbox({dir})` implements D8, paired with
 * `defineWorkspace({source:{type:"none"}, setup:[]})` to get `lifecycle.reuse:"thread"`.
 *
 * ADR 0012 §2: this adapter interprets its own chunk stream. Vendor-specific
 * event names (`opencode.session-id`, `structured-output.complete`) are
 * recognized here and emitted as normalized `AgentSignal`s. The runtime
 * consumes signals and never matches these strings.
 */

import { chat } from "@tanstack/ai";
import { opencodeText } from "@tanstack/ai-opencode";
import { defineSandbox, defineWorkspace, withSandbox } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import net from "node:net";
import type {
  AgentAdapter,
  AgentAdapterOptions,
  AgentAdapterYield,
  AgentSignal,
} from "./agent-adapter";
import { writeHeadlessPermissions } from "../lib/sandbox-config";

/**
 * Inspect one raw AG-UI chunk for opencode-specific signals. Returns the
 * matching `AgentSignal` when the chunk carries a recognized vendor event,
 * or `undefined` when it does not. This is the only place in the runtime
 * layer that string-matches opencode event names.
 */
export function extractOpencodeSignal(chunk: unknown): AgentSignal | undefined {
  const record = chunk as {
    type?: unknown;
    name?: unknown;
    value?: unknown;
    message?: unknown;
  };

  if (record.type === "CUSTOM" && typeof record.name === "string") {
    if (record.name === "opencode.session-id") {
      const value = record.value as { sessionId?: unknown } | undefined;
      if (typeof value?.sessionId === "string") {
        return { _tag: "sessionId", value: value.sessionId };
      }
    } else if (record.name === "structured-output.complete") {
      const value = record.value as { object?: unknown } | undefined;
      if (value?.object !== undefined) {
        return { _tag: "structuredOutput", value: value.object };
      }
    }
  }

  if (record.type === "RUN_ERROR") {
    const message = record.message;
    return {
      _tag: "runError",
      value: typeof message === "string" ? message : JSON.stringify(chunk),
    };
  }

  return undefined;
}

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

export const opencodeAdapter: AgentAdapter = {
  async prepareWorkspace(dir: string): Promise<void> {
    await writeHeadlessPermissions(dir);
  },

  async *stream(options: AgentAdapterOptions): AsyncIterable<AgentAdapterYield> {
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
      const signal = extractOpencodeSignal(chunk);
      yield signal !== undefined ? { chunk, signal } : { chunk };
    }
  },
};
