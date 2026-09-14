import { StreamProcessor } from "@tanstack/ai/client";
import type {
  ContentPart,
  MessagePart,
  StreamChunk,
  ToolResultPart,
  UIMessage,
} from "@tanstack/ai/client";
import type { RunEvent } from "../../events";

/**
 * S4's transcript projection: the second pure, framework-free reducer beside
 * `run-events.ts`, unit-testable without a DOM.
 *
 * The chunk-folding half is **not** Factory's — `StreamProcessor` from the
 * already-installed `@tanstack/ai/client` owns the AG-UI chunk state machine
 * (text accumulation, tool-call state transitions, thinking buffering,
 * structured-output assembly). Factory owns what the library cannot know:
 * which chunks belong to which step (`stepId`, ADR 0003 §5), what the prompt
 * was (`AgentStepStarted`), and the presentation-shaped join of a tool call to
 * its result (`toolCallId`, §3's "only non-presentational logic left").
 *
 * See `docs/findings/8-phase4-transcript-renderer.md` §5 — this is the
 * recommendation, not a fallback. `@tanstack/ai-event-client` was rejected
 * (it ships no renderer); no `@tanstack/ai-react*` surface fits a replayed log.
 */

export interface Transcript {
  readonly stepId: string;
  /** `AgentStepStarted.prompt`, the header block. Empty if the event is absent. */
  readonly prompt: string;
  /** The step's assistant messages, with the leading prompt echo removed. */
  readonly messages: ReadonlyArray<UIMessage>;
}

/**
 * Fold one agent step's `AgentChunk` events into the mock's transcript shape.
 *
 * Events are read in the given order — the live `seq` order the SSE tail and
 * `deriveSteps` both assume. A fresh `StreamProcessor` per call is what keeps
 * step switches from leaking state: there is no shared instance to reset.
 */
export function deriveTranscript(events: ReadonlyArray<RunEvent>, stepId: string): Transcript {
  let prompt = "";
  const chunks: Array<StreamChunk> = [];

  for (const event of events) {
    const payload = event.payload;
    if (payload._tag === "AgentStepStarted" && payload.stepId === stepId) {
      prompt = payload.prompt;
    } else if (payload._tag === "AgentChunk" && payload.stepId === stepId) {
      chunks.push(payload.chunk as unknown as StreamChunk);
    }
  }

  const processor = new StreamProcessor({});
  for (const chunk of chunks) processor.processChunk(chunk);

  return { stepId, prompt, messages: stripEchoedPrompt(processor.getMessages(), prompt) };
}

/**
 * The harness echoes the step's prompt back as the first assistant text part
 * (finding 8 §3, final paragraph), so rendering `AgentStepStarted.prompt` as a
 * header *and* the processor's first message would show it twice. When the
 * leading text part is byte-identical to the prompt, drop it; if that empties
 * the message, drop the message. Byte-identical is the honest comparison — the
 * corpus prompt is emitted verbatim (`src/runtime/run.ts:153`).
 */
function stripEchoedPrompt(
  messages: ReadonlyArray<UIMessage>,
  prompt: string,
): ReadonlyArray<UIMessage> {
  const first = messages[0];
  if (prompt === "" || first === undefined) return messages;

  const [head, ...rest] = first.parts;
  if (head?.type !== "text" || head.content !== prompt) return messages;

  if (rest.length === 0) return messages.slice(1);
  return [{ ...first, parts: rest }, ...messages.slice(1)];
}

/** A render-ready transcript row: tool results are folded into their call. */
export type TranscriptRow =
  | { readonly kind: "text"; readonly content: string }
  | { readonly kind: "thinking"; readonly content: string }
  | {
      readonly kind: "tool-call";
      readonly toolCallId: string;
      readonly name: string;
      readonly args: string;
      readonly state: string;
      /** The matching `tool-result` content, joined by `toolCallId`, if it arrived. */
      readonly result: string | undefined;
      readonly isError: boolean;
    }
  | {
      readonly kind: "structured-output";
      readonly status: string;
      readonly data: unknown;
      readonly raw: string;
    };

/**
 * Join each `tool-call` to its `tool-result` by `toolCallId` (ADR 0003 §5:
 * tool calls interleave, results arrive out of start order — correlation by
 * id, never by nesting) and lay every part out as one ordered row list. The
 * result is emitted with its call, never as its own row.
 */
export function toTranscriptRows(messages: ReadonlyArray<UIMessage>): ReadonlyArray<TranscriptRow> {
  const results = new Map<string, ToolResultPart>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool-result") results.set(part.toolCallId, part);
    }
  }

  const rows: Array<TranscriptRow> = [];
  for (const message of messages) {
    for (const part of message.parts) {
      const row = rowFor(part, results);
      if (row !== undefined) rows.push(row);
    }
  }
  return rows;
}

function rowFor(
  part: MessagePart,
  results: ReadonlyMap<string, ToolResultPart>,
): TranscriptRow | undefined {
  switch (part.type) {
    case "text":
      return { kind: "text", content: part.content };
    case "thinking":
      return { kind: "thinking", content: part.content };
    case "tool-call": {
      const result = results.get(part.id);
      return {
        kind: "tool-call",
        toolCallId: part.id,
        name: part.name,
        args: part.arguments,
        state: part.state,
        result: result === undefined ? undefined : contentToText(result.content),
        isError: part.state === "error" || result?.state === "error",
      };
    }
    case "structured-output":
      return { kind: "structured-output", status: part.status, data: part.data, raw: part.raw };
    // `tool-result` renders with its call; media parts do not come from opencode.
    default:
      return undefined;
  }
}

/** `tool-result.content` is a string or multimodal parts; the transcript wants text. */
function contentToText(content: string | ReadonlyArray<ContentPart>): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.content : JSON.stringify(part)))
    .join("\n");
}
