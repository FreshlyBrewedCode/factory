/**
 * One opencode agent step: `chat()` + `withSandbox(localProcessSandbox)` +
 * `opencodeText`, with every raw chunk forwarded to a sink (D14) as it
 * streams. D10: never pass `modelOptions.sessionId` — every step gets a
 * fresh harness session; the tree (not the transcript) is the shared state.
 *
 * Workspace-source note (see docs/findings/0a-1-single-agent-step.md for the full
 * evidence): `localProcessSandbox({ dir })` is what actually pins the
 * sandbox at a host directory. `workspace.source` is set to `{ type: 'none'
 * }` deliberately — `{ type: 'local', path }` looks like the documented
 * knob for this, but the installed `@tanstack/ai-sandbox` bootstrap only
 * special-cases `source.type === 'git'`; `'local'` and `'none'` both fall
 * through as a no-op. The workspace's `source` field is required by the
 * type, so `'none'` is the honest way to say "bootstrap does nothing here,
 * the provider's `dir` already points at the tree."
 *
 * Structured output (0a-2): passing `outputSchema` makes `chat()` inject the
 * schema into the prompt and, on completion, emit a CUSTOM
 * `structured-output.complete` chunk with the parsed object (see
 * `node_modules/@tanstack/ai-opencode/src/adapters/text.ts` and
 * `node_modules/@tanstack/ai/src/utilities/structured-output-events.ts`,
 * read directly — this is exercised at runtime here, not just read from
 * source as 0a-1 left it). `stream: true` must be passed alongside
 * `outputSchema` or `chat()`'s return type collapses to a bare
 * `Promise<T>` with no chunk stream to dump to NDJSON.
 *
 * finalAssistantText bug fix (0a-2): the 0a-1 corpus
 * (`.factory/runs/run-1789306198987/chunks.ndjson`) shows
 * `TEXT_MESSAGE_CONTENT` chunks carry the text on a `delta` field, not
 * `content` — the original code checked for `content`, which never existed
 * on this chunk type, so `finalAssistantText` was always `""`. Fixed by
 * accumulating `delta` between `TEXT_MESSAGE_START` and `TEXT_MESSAGE_END`
 * per message, then keeping the last completed message's buffer as
 * `finalAssistantText` (i.e. the harness's last assistant turn, which is
 * what structured-output parsing and PR-metadata fallback both need).
 */

import { chat } from "@tanstack/ai";
import { opencodeText } from "@tanstack/ai-opencode";
import { defineSandbox, defineWorkspace, withSandbox } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import type { NdjsonSink } from "./ndjson";

export interface AgentStepOptions {
  /** Label recorded on every NDJSON line for this step, e.g. "implement". */
  readonly step: string;
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
  /**
   * JSON Schema for structured output. When set, `chat()` is called with
   * `{ outputSchema, stream: true }` and the resulting
   * `structured-output.complete` CUSTOM event (if any) is captured into
   * `AgentStepResult.structuredOutput`.
   */
  readonly outputSchema?: unknown;
}

export interface AgentStepResult {
  readonly step: string;
  readonly chunkCount: number;
  readonly chunkTypeCounts: Record<string, number>;
  readonly customEventNames: ReadonlyArray<string>;
  readonly finalAssistantText: string;
  /** Parsed object from a `structured-output.complete` CUSTOM event, if one arrived. */
  readonly structuredOutput: unknown;
  /** Raw text the adapter attempted to parse as JSON for structured output, if attempted. */
  readonly structuredOutputRaw: string | undefined;
  /** Message from a `RUN_ERROR` chunk, if one arrived (e.g. structured-output parse failure). */
  readonly runError: string | undefined;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/**
 * Run one fresh-session opencode turn against a host directory via
 * `localProcessSandbox`. Every chunk is appended to `options.sink` verbatim
 * as `{ step, chunk }` (D14: raw chunk kept byte-for-byte; the wrapper only
 * adds which step it came from) before any inspection, so the NDJSON file is
 * a faithful recording even if this function's own bookkeeping has bugs.
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

  const baseChatOptions = {
    threadId: options.threadId,
    adapter: opencodeText(options.model, { permissionMode: "acceptEdits" as const }),
    messages: [{ role: "user" as const, content: options.prompt }],
    middleware: [withSandbox(sandboxDefinition)],
    abortController,
  };

  // `chat()`'s return type is inferred from the literal options shape passed
  // to it; a spread/ternary confuses that inference into a union it can't
  // narrow. Branching the call itself keeps each branch's inference correct,
  // and the loop below treats every chunk as `unknown` and duck-types it
  // anyway (matching 0a-1's approach), so the `AsyncIterable<unknown>` cast
  // costs nothing in practice.
  const stream: AsyncIterable<unknown> =
    options.outputSchema !== undefined
      ? (chat({
          ...baseChatOptions,
          outputSchema: options.outputSchema,
          stream: true,
        } as unknown as Parameters<typeof chat>[0]) as AsyncIterable<unknown>)
      : (chat(baseChatOptions) as AsyncIterable<unknown>);

  let chunkCount = 0;
  const chunkTypeCounts: Record<string, number> = {};
  const customEventNames = new Set<string>();
  let finalAssistantText = "";
  let currentMessageBuffer: string | undefined;
  let structuredOutput: unknown;
  let structuredOutputRaw: string | undefined;
  let runError: string | undefined;

  const startedAt = Date.now();
  try {
    for await (const chunk of stream) {
      chunkCount += 1;
      await options.sink.append({ step: options.step, chunk });

      const record = chunk as { type?: unknown; name?: unknown; value?: unknown };
      const typeKey =
        typeof record.type === "string"
          ? record.type === "CUSTOM" && typeof record.name === "string"
            ? `CUSTOM:${record.name}`
            : record.type
          : "UNKNOWN";
      chunkTypeCounts[typeKey] = (chunkTypeCounts[typeKey] ?? 0) + 1;

      if (record.type === "CUSTOM" && typeof record.name === "string") {
        customEventNames.add(record.name);

        if (record.name === "structured-output.complete") {
          const value = record.value as { object?: unknown; raw?: unknown } | undefined;
          structuredOutput = value?.object;
          structuredOutputRaw = typeof value?.raw === "string" ? value.raw : undefined;
        }
      }

      if (record.type === "TEXT_MESSAGE_START") {
        currentMessageBuffer = "";
      } else if (record.type === "TEXT_MESSAGE_CONTENT") {
        const delta = (chunk as { delta?: unknown }).delta;
        if (typeof delta === "string") {
          currentMessageBuffer = (currentMessageBuffer ?? "") + delta;
        }
      } else if (record.type === "TEXT_MESSAGE_END") {
        if (currentMessageBuffer !== undefined) {
          finalAssistantText = currentMessageBuffer;
        }
        currentMessageBuffer = undefined;
      } else if (record.type === "RUN_ERROR") {
        const message = (chunk as { message?: unknown }).message;
        runError = typeof message === "string" ? message : JSON.stringify(chunk);
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  return {
    step: options.step,
    chunkCount,
    chunkTypeCounts,
    customEventNames: [...customEventNames],
    finalAssistantText,
    structuredOutput,
    structuredOutputRaw,
    runError,
    timedOut: abortController.signal.aborted,
    durationMs: Date.now() - startedAt,
  };
}
