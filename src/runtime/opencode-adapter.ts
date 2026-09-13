/**
 * The live `AgentAdapter`: `chat()` + `withSandbox(localProcessSandbox)` +
 * `opencodeText`, exactly the plumbing proven in `src/spike/lib/effect-agent-step.ts`
 * (ADR 0001 §5). D15: `localProcessSandbox({dir})` implements D8, paired with
 * `defineWorkspace({source:{type:"none"}, setup:[]})` to get `lifecycle.reuse:"thread"`.
 */

import { chat } from "@tanstack/ai";
import { opencodeText } from "@tanstack/ai-opencode";
import { defineSandbox, defineWorkspace, withSandbox } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import type { AgentAdapter, AgentAdapterOptions } from "./agent-adapter";

export const opencodeAdapter: AgentAdapter = {
  stream(options: AgentAdapterOptions): AsyncIterable<unknown> {
    const sandboxDefinition = defineSandbox({
      id: "factory-run",
      provider: localProcessSandbox({ dir: options.dir }),
      workspace: defineWorkspace({ source: { type: "none" }, setup: [] }),
      lifecycle: { reuse: "thread", destroyOnComplete: false },
    });

    const baseChatOptions = {
      threadId: options.threadId,
      adapter: opencodeText(options.model, { permissionMode: "acceptEdits" as const }),
      messages: [{ role: "user" as const, content: options.prompt }],
      middleware: [withSandbox(sandboxDefinition)],
      abortController: options.abortController,
    };

    // Branch the call itself (not spread/ternary) so each `chat()` overload
    // resolves cleanly; the caller treats every chunk as `unknown` regardless.
    return options.outputSchema !== undefined
      ? (chat({
          ...baseChatOptions,
          outputSchema: options.outputSchema,
          stream: true,
        } as unknown as Parameters<typeof chat>[0]) as AsyncIterable<unknown>)
      : (chat(baseChatOptions) as AsyncIterable<unknown>);
  },
};
