/**
 * One opencode agent step: `chat()` + `withSandbox(localProcessSandbox)` +
 * `opencodeText`, with every raw chunk forwarded to a sink (D14) as it
 * streams. D10: never pass `modelOptions.sessionId` — every step gets a
 * fresh harness session; the tree (not the transcript) is the shared state.
 *
 * Workspace-source note (see docs/phase0-findings.md "0a-1" for the full
 * evidence): `localProcessSandbox({ dir })` is what actually pins the
 * sandbox at a host directory. `workspace.source` is set to `{ type: 'none'
 * }` deliberately — `{ type: 'local', path }` looks like the documented
 * knob for this, but the installed `@tanstack/ai-sandbox` bootstrap only
 * special-cases `source.type === 'git'`; `'local'` and `'none'` both fall
 * through as a no-op. The workspace's `source` field is required by the
 * type, so `'none'` is the honest way to say "bootstrap does nothing here,
 * the provider's `dir` already points at the tree."
 */

import { chat } from "@tanstack/ai";
import { opencodeText } from "@tanstack/ai-opencode";
import { defineSandbox, defineWorkspace, withSandbox } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import type { NdjsonSink } from "./ndjson";

export interface AgentStepOptions {
  readonly threadId: string;
  readonly clonePath: string;
  readonly model: string;
  readonly prompt: string;
  readonly sink: NdjsonSink;
  /**
   * Hard cap on the step. F4: closing the stream does not kill the opencode
   * process, so a timeout alone would leave an orphan — this drives an
   * explicit `AbortController.abort()`, the "only reliable way to stop the
   * agent burning tokens" per the sandbox docs.
   */
  readonly timeoutMs?: number;
}

export interface AgentStepResult {
  readonly chunkCount: number;
  readonly chunkTypeCounts: Record<string, number>;
  readonly customEventNames: ReadonlyArray<string>;
  readonly finalAssistantText: string;
  readonly timedOut: boolean;
}

/**
 * Run one fresh-session opencode turn against a host directory via
 * `localProcessSandbox`. Every chunk is appended to `options.sink` verbatim
 * (`JSON.stringify(chunk)`) before any inspection, so the NDJSON file is a
 * faithful recording even if this function's own bookkeeping below has bugs.
 */
export async function runAgentStep(options: AgentStepOptions): Promise<AgentStepResult> {
  const sandboxDefinition = defineSandbox({
    id: "factory-spike",
    provider: localProcessSandbox({ dir: options.clonePath }),
    workspace: defineWorkspace({ source: { type: "none" }, setup: [] }),
    lifecycle: { reuse: "thread", destroyOnComplete: false },
  });

  const abortController = new AbortController();
  const timer =
    options.timeoutMs !== undefined
      ? setTimeout(() => abortController.abort(), options.timeoutMs)
      : undefined;

  const stream = chat({
    threadId: options.threadId,
    adapter: opencodeText(options.model, { permissionMode: "acceptEdits" }),
    messages: [{ role: "user", content: options.prompt }],
    middleware: [withSandbox(sandboxDefinition)],
    abortController,
  });

  let chunkCount = 0;
  const chunkTypeCounts: Record<string, number> = {};
  const customEventNames = new Set<string>();
  let finalAssistantText = "";

  try {
    for await (const chunk of stream) {
      chunkCount += 1;
      await options.sink.append(chunk);

      const record = chunk as { type?: unknown; name?: unknown };
      const typeKey =
        typeof record.type === "string"
          ? record.type === "CUSTOM" && typeof record.name === "string"
            ? `CUSTOM:${record.name}`
            : record.type
          : "UNKNOWN";
      chunkTypeCounts[typeKey] = (chunkTypeCounts[typeKey] ?? 0) + 1;

      if (record.type === "CUSTOM" && typeof record.name === "string") {
        customEventNames.add(record.name);
      }
      if (
        record.type === "TEXT_MESSAGE_CONTENT" &&
        "content" in chunk &&
        typeof (chunk as { content?: unknown }).content === "string"
      ) {
        finalAssistantText = (chunk as { content: string }).content;
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  return {
    chunkCount,
    chunkTypeCounts,
    customEventNames: [...customEventNames],
    finalAssistantText,
    timedOut: abortController.signal.aborted,
  };
}
