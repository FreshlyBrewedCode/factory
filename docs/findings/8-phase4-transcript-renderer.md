# Finding 8 — phase 4 transcript renderer: `@tanstack/ai-event-client` vs TanStack's `StreamProcessor`

**Date:** 2026-09-14
**Spike question (STATUS.md S4):** can `@tanstack/ai-event-client` render a real corpus
`AgentChunk` sequence (text deltas, tool calls, reasoning) **without Factory re-typing chunk
types**?
**Verdict:** **FAIL** for `@tanstack/ai-event-client`. It ships no renderer and no chunk reducer —
it is a devtools event bus. The deferred Factory-owned reducer therefore fires, but the spike
found that its chunk-folding half can be delegated to `StreamProcessor` from the already-installed
`@tanstack/ai/client`, so Factory writes only a thin projection plus presentation, not a chunk
state machine.
**Spin-off:** the shadcn `message-scroller` registry item is compatible and is the recommended
transcript scroll container; install command and two integration gotchas below.

## 1. The criterion and the verdict

The pass/fail criterion, verbatim from the S4 brief:

> can `@tanstack/ai-event-client` render a real corpus `AgentChunk` sequence (text deltas, tool
> calls, reasoning) **without Factory re-typing chunk types**? If it cannot, the deferred
> Factory-owned reducer over `AgentChunk` fires.

**PASS/FAIL: FAIL.**

The package has no rendering surface of any kind. `@tanstack/ai-event-client@0.11.3`'s only
exports (`node_modules/@tanstack/ai-event-client/src/index.ts:7-17`) are:

- type mirrors of `@tanstack/ai`'s part/usage shapes (`MessagePart`, `ToolCallPart`,
  `ThinkingPart`, `StructuredOutputPart`, `TokenUsage`, …);
- three envelope helpers (`createAIDevtoolsEventEnvelope`, `getAIDevtoolsDedupeKey`,
  `getAIDevtoolsRuntimeId`) in `src/envelope.ts`;
- a singleton devtools event client (`aiEventClient`, `src/index.ts:1547-1549`), an `emit`
  wrapper (`emitAIDevtoolsEvent`, `:1551-1555`), a browser `CustomEvent` dispatcher
  (`dispatchAIDevtoolsEvent`, `:1557-1573`), and `devtoolsMiddleware` (`:1575-1579`).

There is no component, no hook, no `parse`, no `render`, no reducer. `package.json` declares a
single `"."` export — no `/ui` subpath. The one processing function,
`devtoolsMiddleware()` (`src/devtools-middleware.ts:314`), is **not a renderer**:

- it is a server-side `ChatMiddleware` (`DevtoolsChatMiddleware`, `:228`) that the chat engine
  auto-injects while a **live** request runs; its context is a live run
  (`requestId`/`streamId`/`runId`/`provider`/`model`, `:169-187`), which a replay of persisted
  events does not have;
- it maps chunks to *devtools telemetry events* (`onChunk`, `:409`; e.g.
  `TEXT_MESSAGE_CONTENT → 'text:chunk:content'` `:415-424`, `TOOL_CALL_START → 'text:chunk:tool-call'`
  `:426-442`, `REASONING_MESSAGE_CONTENT → 'text:chunk:thinking'` `:518-528`), not to UI nodes;
- it is observation-only and returns `void` (`:531`), so even as a pipeline it never produces
  content.

This confirms and sharpens STATUS.md's "No React components, no renderer" claim (STATUS.md:183-188).

### Consequence

The Factory-owned reducer fires — **but far less of it than the fallback assumed**. STATUS.md
framed the choice as "typed chunk accessors vs. a hand-written reducer over `AgentChunk`"
(STATUS.md:185-188). That framing is now incomplete: the installed `@tanstack/ai`
already exports a client-side chunk reducer, `StreamProcessor`, and it folds every real corpus
cleanly (§3). So Factory owns the *projection* (which chunks belong to which step, what the
prompt is, how messages map to the mock's transcript) and the *presentation*, while TanStack owns
the AG-UI chunk state machine. This is a smaller Factory-owned surface than the fallback assumed,
and it does not re-type chunk types — it consumes TanStack's published `StreamChunk` union.

## 2. The React packages: what exists, and why not use them

`@tanstack/ai-react` is **not installed** in this repo (`ls node_modules/@tanstack` shows no
`ai-react` / `ai-react-ui`). Inspected in a throwaway `/tmp` install at the versions a fresh
`bun add` resolves today:

- `@tanstack/ai-react@0.24.1` exports a `/ui` subpath (`package.json` `exports`), and the old
  `@tanstack/ai-react-ui` is deprecated in favour of it (`@tanstack/ai-react-ui/package.json:20`,
  `"deprecated": "Use @tanstack/ai-react/ui instead."`). No `@tanstack/ai-*-ui` package should be
  added.
- `/ui` does provide message components — `ChatMessage`, `TextPart`, `ThinkingPart`,
  `ChatMessages`, `Chat` (`@tanstack/ai-react/src/ui.ts`) — that understand
  `UIMessage` parts (text / thinking / tool-call / tool-result), `src/chat-ui/chat-message.tsx:94`.
- But those components are already marked deprecated: *"Use `createChatUI()` Message instead.
  Deprecated in 0.9.0. Removed in 1.0.0."* (`src/chat-ui/chat-message.tsx:44`; same for
  `ChatMessages`, `Chat`, `ToolApproval`, `ChatInput`). Adopting them now buys a migration.
- More fundamentally, the whole package is a **live-chat** integration. `useChat` renders from a
  `connection`/`fetcher` and a `ChatClient` (`@tanstack/ai-react/src/use-chat.ts:1`, `:120`); it
  is built to drive a run, not to replay a persisted event log. Factory's transcript is the
  latter (`useRunEvents` in `src/web/hooks.ts:30` accumulates `RunEvent`s from SSE).
- The `/ui` renderers are also styled/opinionated (`TextPart` is `react-markdown` with
  `remark-gfm`/`rehype-highlight`/`rehype-sanitize`, `src/chat-ui/text-part.tsx`), which fights
  the mock's achromatic, disclosure-based transcript (finding 7) and would add four markdown
  dependencies.

The shadcn `@shadcn/helpers/tanstack-ai` package is likewise not a fit: it exists to replay
*hand-authored `UIMessage[]` fixtures* through `useChat` for demos and tests, and its published
peer range is `@tanstack/ai >=0.40.0 <0.41.0` while Factory has `0.54.0` (npm metadata) — it is
pinned to an older TanStack AI.

## 3. The measured alternative: `StreamProcessor` (already installed)

`@tanstack/ai` (a direct dependency, `0.54.0`) exports `StreamProcessor` from both its main entry
and the browser-safe `/client` subpath:

- value export: `node_modules/@tanstack/ai/dist/esm/client.d.ts:60`
  (`export { … StreamProcessor … } from './activities/chat/stream/index.js'`);
- type re-exports on the same entry: `StreamChunk`, `UIMessage`, `MessagePart`, `TextPart`,
  `ThinkingPart`, `ToolCallPart`, `ToolResultPart`, `StructuredOutputPart`
  (`client.d.ts:71`), where `StreamChunk = AGUIEvent` (`dist/esm/types.d.ts:1414`);
- API: `class StreamProcessor` with `processChunk(chunk: StreamChunk): void`
  (`dist/esm/activities/chat/stream/processor.d.ts:182`), `getMessages(): Array<UIMessage>`
  (`:155`), `setMessages` (`:95`), `prepareAssistantMessage` (`:128`).

`@tanstack/ai/client` imports no Node built-ins at its top level (`dist/esm/client.js` heads with
only relative ES imports), and `@tanstack/ai-react` imports its types from this same subpath
(`@tanstack/ai-react/src/use-chat.ts:1-10`).

### Experiment (throwaway, `/tmp/opencode/s4`, not in the repo)

Ran under Bun 1.4.2. Script read each `test/corpus/*.ndjson`, normalised the two envelope shapes
the spike produced (`{step, chunk}` for eight corpora, bare chunk objects for
`run-1789306198987.ndjson`), grouped chunks by `step`, fed each group through a fresh
`new StreamProcessor({})` via `processChunk`, then called `getMessages()`:

```
import { StreamProcessor } from "@tanstack/ai/client";

for (const [step, chunks] of byStep) {
  const proc = new StreamProcessor({});
  for (const c of chunks) proc.processChunk(c as never);
  console.log(step, proc.getMessages());
}
```

Observed: **all nine corpora, every step, zero throws, zero `onError` events.** The per-step parts
came out as (abridged; `run-1789308170212.ndjson`):

```
step=implement chunks=39
  parts: [
    text:"You are working in a git checkout of a s",
    tool-call:read:complete:{} ×2, tool-result ×2,
    tool-call:read:complete:{}, tool-result,
    tool-call:edit:complete:{}, tool-result:"Edit applied successfully." ×2,
    tool-call:bash:complete:{}, tool-result:"bun test v1.4.2 …"
  ],
  text:"I'll start by exploring the existing fil",
  text:"Done. Added `slugify` to `src/index.ts:7`"
step=fix       chunks=63  → text, tool-calls, tool-results, thinking:7229ch, thinking:4237ch
step=pr-metadata chunks=33 → text, thinking:162ch, tool-calls, then
                             text:'{"title":"Add slugify…' + structured-output:complete
```

Text, reasoning (`REASONING_MESSAGE_CONTENT → thinking` part), tool calls with args, tool results,
and `structured-output.complete` all fold correctly, and tool calls are correlated by `toolCallId`
across interleaving (ADR 0003 §5's hazard is handled by the library, not by Factory).

### How a real corpus renders under the winning option

For one agent step, Factory's transcript becomes:

```
[ prompt header ]  ← AgentStepStarted.prompt (src/events.ts:106), the mock's top block
[ transcript ]     ← UIMessage[] from StreamProcessor over that step's AgentChunk.chunk values
                     (filter payload.chunkType === "AgentChunk" by payload.stepId, in seq order)
```

- **text** → prose block.
- **thinking** → the existing `Disclosure` (finding 7: collapsed-by-default bordered
  summary/body), labelled "Reasoning".
- **tool-call** → the same `Disclosure`, summary = tool name + state, body = args; **tool-result**
  is joined back to its tool-call by `toolCallId` and shown in the same disclosure (the processor
  emits them as sibling parts, so the renderer does the join — the only non-presentational logic
  left).
- **structured-output** → a disclosure (or the step's existing structured-output block); note this
  now comes from the stream, so `AgentStepFinished.output` is not needed for the transcript.
- Multiple assistant messages per step (the processor emits one per `TEXT_MESSAGE_START`/iteration,
  visible in §3's output) are each a transcript row.

**What Factory still has to write:** the `deriveTranscript(events, stepId)` projection, the
tool-call↔tool-result join, and the React render tree. It does **not** write chunk accumulation,
tool-call state transitions, thinking buffering, or structured-output assembly.

**Gotcha found in the corpus:** the first `TEXT_MESSAGE_CONTENT` of every agent step *is the
prompt echoed back* with `role: "assistant"` (e.g. `test/corpus/run-1789306198987.ndjson` line 5;
the workflow constant is `workflows/implement-issue.ts:28`). Rendering `AgentStepStarted.prompt`
at the top *and* the processor's first message will show the prompt twice. The implementation
agent must dedupe (skip the leading assistant message when it equals the prompt) or derive the
header from the stream.

## 4. Message scroller

Source: <https://ui.shadcn.com/docs/components/base/message-scroller> (base/New) and the registry
item fetched with `bunx --bun shadcn@latest view message-scroller` (CLI `4.21.0`). It is a
chat-transcript scroll container: `MessageScrollerProvider` (headless, owns scroll state),
`MessageScroller` (styled frame), `MessageScrollerViewport`, `MessageScrollerContent`,
`MessageScrollerItem`, `MessageScrollerButton`, plus `useMessageScroller`,
`useMessageScrollerVisibility`, `useMessageScrollerScrollable`. It provides exactly the behaviours
the mock's transcript needs and a live stream needs:

- `autoScroll` follows the live edge but releases the moment the reader scrolls away;
- `defaultScrollPosition="start" | "end" | "last-anchor"` (open a saved transcript per the mock:
  prompt at top → `"start"`);
- `scrollAnchor` on a row, `scrollPreviousItemPeek`, `preserveScrollOnPrepend`;
- imperative `scrollToMessage`/`scrollToEnd`/`scrollToStart` for the back/jump controls.

**Install command** (from the repo root, bun):

```
bunx --bun shadcn@latest add message-scroller
```

**Registry/dependency implications**, read from the `view` output:

- writes `src/web/components/ui/message-scroller.tsx` (the repo's `components.json` maps
  `aliases.ui` to `@/web/components/ui`), rewriting the `Button` import to
  `@/web/components/ui/button` (already present) and the registry `cn` dependency to the project's
  `aliases.utils` (`@/web/lib/utils`, which defines `cn` — verify after generation and repoint if
  the CLI emits a bare `from "cn"` to the standalone `cn` package);
- `registryDependencies: ["button"]`, `dependencies: ["cn", "@shadcn/react"]` — adds
  **`@shadcn/react`** (`0.3.1`, peer `react >=19`; the repo has `react@19.3.0`, compatible). It is
  headless behaviour and is imported as `@shadcn/react/message-scroller`.
- **Gotcha — CSS utilities:** the generated styled component uses `scroll-fade-b`, `scrollbar-thin`,
  `scrollbar-gutter-stable`, `scrollbar-none`/`no-scrollbar` classes. Those are **not** in this
  repo's `src/web/styles.css`, which imports only `tailwindcss` and the fonts (`styles.css:1-3`).
  Per the shadcn `scroll-fade` docs they ship with the `shadcn` npm package's shared CSS, imported
  as `@import "shadcn/tailwind.css";`. Either add `shadcn` (the runtime CSS package, `4.21.0`) and
  that import, or trim the utility classes. Tailwind v4 via `bun-plugin-tailwind` is otherwise
  compatible — the component is plain Tailwind classes plus `cn`.
- Tailwind v4 / `bun-plugin-tailwind`: no conflict. The component has no Tailwind config file
  requirement (`components.json` already has `"config": ""`), and `content-visibility`/
  `contain-intrinsic-size` are emitted as arbitrary-value utilities.

**Where it attaches:** the transcript fills the inspector panel (finding 7). In
`src/web/pages/run-detail.tsx` that panel is the desktop `aside` at `:601-605` and the mobile sheet
at `:614-626`, both of which currently scroll themselves (`overflow-y-auto` on the aside). The
scroller must own the scroll, so make the panel `flex flex-col overflow-hidden` and the scroller
itself `min-h-0 flex-1`; wrap the prompt and each message part in `MessageScrollerItem`, put
`scrollAnchor` on the prompt row, and use `defaultScrollPosition="start"` with `autoScroll` only
while the step is `streaming && active`.

## 5. Recommendation

**Approach the implementation agent must take:** a Factory-owned transcript layer whose
chunk-folding half is TanStack's `StreamProcessor`, plus shadcn's `message-scroller` for the
viewport.

1. **Do not add `@tanstack/ai-event-client` as a direct dependency** and do not add
   `@tanstack/ai-react`/`/ui`. Neither fits a replayed event log.
2. **Reducer** — add a pure projection beside the S3 one, e.g. `src/web/lib/transcript.ts`:

   ```ts
   import { StreamProcessor } from "@tanstack/ai/client";
   import type { StreamChunk, UIMessage } from "@tanstack/ai/client";
   ```

   `deriveTranscript(events, stepId)` filters `RunEvent`s for
   `payload._tag === "AgentChunk" && payload.stepId === stepId` in `seq` order, casts each
   `payload.chunk` (opaque `Schema.Json`, `src/events.ts:124-128`) to `StreamChunk`, feeds a fresh
   `StreamProcessor`, and returns `{ prompt, messages: UIMessage[] }`. Keep it framework-free and
   unit-test it against `test/corpus/` like `src/web/lib/run-events.ts`.
3. **Presentation** — Factory-owned React: prose for text, the existing `Disclosure` element for
   reasoning / tool-call / structured-output, joined by `toolCallId`. Reuse the mock's layout.
4. **Scroll** — `bunx --bun shadcn@latest add message-scroller`, plus `shadcn` +
   `@import "shadcn/tailwind.css";` in `src/web/styles.css` for the fade/scrollbar utilities (or
   drop those classes).

**Fallback trigger:** if `StreamProcessor` proves wrong for replay — it needs a live
`ChatMiddlewareContext` or live-run ordering, it breaks on a partial/cancelled step (no terminal
chunk, ADR 0003 §3), it fails to bundle or typecheck in the SPA's Bun bundle, or a chunk-shape
regression appears on an adapter swap — replace step 2 with a hand-written reducer over
`AgentChunk.chunk`, typed with the same imported `StreamChunk`/`MessagePart` unions. The corpus
probe in §3 is the reference input set for that fallback.

## 6. What remains unverified

- **Multi-delta accumulation.** Every delta in every corpus is exactly one chunk
  (`TEXT_MESSAGE_CONTENT` 24, `TOOL_CALL_ARGS` 32, `REASONING_MESSAGE_CONTENT` 13; each equals its
  matching START/END count), so neither `StreamProcessor` nor a hand-written reducer has been
  exercised against a genuinely streaming provider. This stays open, same as STATUS.md and ADR
  0003.
- **Browser bundling of `@tanstack/ai/client`.** The probe ran under Bun (Node-like); the module
  graph showed no Node built-ins, but it has not been bundled into the SPA and loaded in a
  browser.
- **Malformed-chunk tolerance.** `AgentChunk.chunk` is `Schema.Json` (ADR 0003's accepted cost).
  Casting it to `StreamChunk` is unchecked; the probe only proves tolerance of *valid recorded*
  chunks. Whether `StreamProcessor` throws on a malformed known-type chunk is untested — wrap the
  fold defensively if it matters.
- **Cancelled/partial steps.** The abort corpora in §3 are partial by construction (`5` chunks, no
  terminal chunk) and folded without error, but their transcript is unremarkable; the cancelled
  UX path has not been designed against.
- **`StreamProcessor` semantics as a replay primitive.** It is built to be driven by
  `ChatClient`; driving it directly with `processChunk` per step worked here, but its behaviour
  under repeated remounts / step switching in React (state reset, `setMessages`) was not tested.
- **Exact `cn` import rewrite** by the shadcn CLI against this repo's `components.json` (asserted
  from the registry item and aliases, not observed by generating into the repo).

## References

- `node_modules/@tanstack/ai-event-client/{package.json,src/index.ts,src/envelope.ts,src/devtools-middleware.ts}`
- `node_modules/@tanstack/ai/dist/esm/{client.d.ts,types.d.ts,activities/chat/stream/processor.d.ts,client.js}`
- `test/corpus/*.ndjson` (nine corpora), `src/events.ts` (`AgentChunk`, `AgentStepStarted`),
  `src/web/lib/run-events.ts`, `src/web/hooks.ts`, `src/web/pages/run-detail.tsx`,
  `src/web/styles.css`, `components.json`
- `docs/findings/7-phase4-ui-prototype-refinement.md` (the transcript UX this serves),
  `docs/adr/0003-run-event-type.md` (opaque `AgentChunk`, `seq`, id-correlation)
- <https://ui.shadcn.com/docs/components/base/message-scroller>,
  <https://ui.shadcn.com/docs/utils/scroll-fade>,
  <https://ui.shadcn.com/docs/helpers/tanstack-ai>
- Throwaway probes: `/tmp/opencode/s4/probe.ts`, `/tmp/opencode/s4/probe2.ts` (not in the repo)
