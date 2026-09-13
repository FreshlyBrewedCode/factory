# Phase 1 — What the NDJSON corpora say about D3's event type

Evidence gathered 2026-09-14 from the nine chunk corpora recorded during phase 0 under D14
("dump every raw stream chunk, no schema, no types"), plus a read of the installed
`@tanstack/ai*` packages. Written for a reader who was not there.

The conclusions drawn from this evidence — the opaque-passthrough decision and the shape of
the event type — live in [`../adr/0003-run-event-type.md`](../adr/0003-run-event-type.md), not
here. This document is the measurements.

## The corpora

Nine files, promoted from the gitignored `.factory/runs/*/chunks.ndjson` into committed
fixtures at `test/corpus/` (128 KB total) so that tests survive a fresh checkout and phase 1's
corpus-replay adapter has something to replay.

| Corpus | Lines | Envelope | What it is |
|---|---|---|---|
| `run-1789306198987` | 44 | bare chunk | 0a-1, one agent step |
| `run-1789307176648` | 102 | `{step, chunk}` | 0a-2 round trip (implement / fix / pr-metadata) |
| `run-1789308170212` | 135 | `{step, chunk}` | 0a-2 round trip, second run |
| `effect-boundary-abort-{1,2}-*` (×4) | 5 each | `{step, chunk}` | 0b, fiber-interrupted mid-stream |
| `effect-boundary-control-{3,4}-*` (×2) | 5 each | `{step, chunk}` | 0b, control condition |

Two envelope shapes exist because 0a-1 dumped bare chunks and everything after it adopted the
`{step, chunk}` wrapper. Both are normalised on read.

## Finding 1 — The adapter's chunk set is genuinely closed, but the protocol's is not

15 distinct chunk types appear across all nine corpora:

```
    28 CUSTOM                        21 TEXT_MESSAGE_START        12 REASONING_START
    26 TOOL_CALL_START               21 TEXT_MESSAGE_CONTENT      12 REASONING_MESSAGE_START
    26 TOOL_CALL_RESULT              15 TEXT_MESSAGE_END          12 REASONING_MESSAGE_CONTENT
    26 TOOL_CALL_END                 12 RUN_STARTED               12 REASONING_MESSAGE_END
    26 TOOL_CALL_ARGS                 6 RUN_FINISHED              12 REASONING_END
```

Grepping the installed adapter for the types it can construct gives **16** — the 15 above plus
`RUN_ERROR`, which no corpus provoked:

```
$ grep -rhno "EventType\.[A-Z_]*" node_modules/@tanstack/ai-opencode/src/ | sed 's/.*EventType\.//' | sort -u
CUSTOM  REASONING_END  REASONING_MESSAGE_CONTENT  REASONING_MESSAGE_END  REASONING_MESSAGE_START
REASONING_START  RUN_ERROR  RUN_FINISHED  RUN_STARTED  TEXT_MESSAGE_CONTENT  TEXT_MESSAGE_END
TEXT_MESSAGE_START  TOOL_CALL_ARGS  TOOL_CALL_END  TOOL_CALL_RESULT  TOOL_CALL_START
```

So STATUS's phrase "a small closed set" is accurate **for this adapter**. It is not accurate
for the protocol. `EventType` in `node_modules/@tanstack/ai/src/client.ts:200` declares **33**
members, and the ones opencode never emits are not exotic:

- `TEXT_MESSAGE_CHUNK`, `TOOL_CALL_CHUNK`, `REASONING_MESSAGE_CHUNK` — combined variants that
  an adapter emits *instead of* start/content/end. An adapter that uses these produces a
  stream with none of the three-part framing the opencode corpora show.
- `STEP_STARTED` / `STEP_FINISHED` — a protocol-level notion of "step" that is **not**
  Factory's `ctx.agent(name, ...)` step. Name collision, noted so nobody conflates them.
- `STATE_SNAPSHOT`, `STATE_DELTA`, `MESSAGES_SNAPSHOT`, `ACTIVITY_*`, `THINKING_*`, `RAW`,
  `REASONING_ENCRYPTED_VALUE`.

This matters because phase 1 plans to run the same workflow under `claudeCodeText` to see what
a journal would have bought us. Any Factory type that enumerates opencode's 16 would need
changing the first time that comparison runs.

### These chunks are AG-UI, not a TanStack-private shape

`node_modules/@tanstack/ai/skills/ai-core/ag-ui-protocol/SKILL.md` documents them as the
**AG-UI streaming protocol**, sourced from `TanStack/ai:docs/protocol/chunk-definitions.md`.
The package already ships the transport and client for it:

| Capability | Where |
|---|---|
| SSE framing | `toServerSentEventsStream()`, `toServerSentEventsResponse()` — `src/stream-to-response.ts:266,702` |
| NDJSON framing | `toHttpStream()` — `src/stream-to-response.ts:1053` |
| Resumable streams with offsets | `durableStreamSource()`, `resumeServerSentEventsResponse()` — `src/stream-to-response.ts:378,1005` |
| WebSocket framing | `toWebSocketStream()` — `src/stream-to-websocket.ts:115` |
| Client consumption | `@tanstack/ai-event-client` 0.11.3 |
| Spec normalisation | `strip-to-spec-middleware.ts`, `utilities/spec-event-keys.ts` |

Phase 3 needs SSE replay and phase 4 needs rendering. Both already exist for this protocol.

## Finding 2 — Chunk timestamps are not a valid ordering key, and the cause is structural

Every corpus contains timestamp inversions. This is not clock jitter:

```
run-1789307176648 (102 lines, 4 inversions)
  line   2: CUSTOM:sandbox.file   587 ms BEFORE the RUN_STARTED it arrives after
  line  28: CUSTOM:sandbox.file   467 ms BEFORE the TOOL_CALL_RESULT it arrives after
  line  30: CUSTOM:sandbox.file  1473 ms BEFORE the REASONING_START it arrives after
  line 102: RUN_FINISHED            1 ms BEFORE structured-output.complete

run-1789308170212 (135 lines, 3 inversions)  — all three CUSTOM:sandbox.file, 415–947 ms
run-1789306198987  (44 lines, 3 inversions)  — all three CUSTOM:sandbox.file, 143–876 ms
```

Root cause: a `sandbox.file` chunk's `timestamp` **is the watched file's mtime**, not its
emission time. In 12 of 15 occurrences `chunk.timestamp === chunk.value.timestamp` exactly;
in the other 3 they differ by 1 ms. The filesystem watcher back-dates its events, so they
arrive up to 1.5 seconds "in the past".

**Consequence:** sorting a corpus by `timestamp` reorders real events. The ordering key must be
a Factory-assigned monotonic counter (`seq`), and the chunk's own timestamp must be left
untouched inside the chunk rather than silently corrected.

This is pinned as an executable assertion in `src/events.test.ts`, so that a future
"simplification" to timestamp-ordering fails loudly.

## Finding 3 — Cancellation emits nothing at all

The four abort corpora are the whole record of an interrupted step:

```
RUN_STARTED
CUSTOM:sandbox.file
CUSTOM:opencode.session-id
TEXT_MESSAGE_START
TEXT_MESSAGE_CONTENT      <- stream ends here
```

No `RUN_FINISHED`. No `RUN_ERROR`. No terminal chunk of any kind. The message is left
**unclosed** — `TEXT_MESSAGE_START` with no matching `TEXT_MESSAGE_END`.

The control corpora (not aborted, just truncated by the experiment) are byte-identical in
shape. So from the chunk stream alone, a cancelled step, a crashed step, and a step still in
flight are indistinguishable.

**Consequences:**

1. Step and run termination must be *Factory* events carrying an explicit outcome. Nothing can
   be derived from the chunks.
2. Unclosed messages and unresolved tool calls are a normal terminal state. Any consumer that
   assumes START implies a later END will hang on a real cancelled run.

## Finding 4 — Tool calls interleave; correlate by id, never by nesting

In `run-1789307176648`, two tool calls are open simultaneously and their results arrive out of
start order:

```
 1: START  …5Tz0303  -> open=1
 4: START  …O807809  -> open=2     <- second call opens before the first resolves
 7: RESULT …5Tz0303  -> open=1
 8: RESULT …O807809  -> open=0
```

`toolCallId` is the only correct join key. A renderer that treats START/END as a stack will
mis-attribute results. Also noted: `TOOL_CALL_START` carries the tool name twice, on
`toolCallName` and `toolName` — identical in all 32 occurrences. `TOOL_CALL_END.input` is an
object; `TOOL_CALL_RESULT.content` is a string.

Tools observed: `read` (17), `bash` (9), `edit` (6).

## Finding 5 — Step names are not unique, so the 0a-2 envelope does not generalise

The `{step, chunk}` envelope keys on a step *name*:

```
$ jq -r 'select(has("step")) | .step' */chunks.ndjson | sort | uniq -c
     20 abort      10 control      99 fix      81 implement      57 pr-metadata
```

It worked because `fullRoundTrip` happened to use three distinct names. ADR 0002 makes step
names mandatory but says nothing about uniqueness, and a retry loop calling `ctx.agent("fix",
…)` twice is an obvious thing a workflow would do. Name-keyed correlation would then merge two
steps' chunks.

**Consequence:** the event type needs a per-occurrence `stepId` as the join key, with the name
kept as a human label. Same for `ctx.exec`, which has no name at all — hence `execId`.

## Finding 6 — Exactly one harness run per agent step

Across every corpus, each step contains exactly one `RUN_STARTED` and (unless aborted) exactly
one `RUN_FINISHED`. This confirms D10's one-fresh-session-per-step model holds at the protocol
level and means agent-step boundaries pair cleanly with harness run boundaries.

`RUN_FINISHED.usage` carries real token accounting, worth surfacing later:

```json
{"promptTokens":260,"completionTokens":288,"totalTokens":548,
 "promptTokensDetails":{"cachedTokens":14208},
 "completionTokensDetails":{"reasoningTokens":927}}
```

Note `completionTokens: 288` alongside `reasoningTokens: 927` — the reasoning tokens are not a
subset of the completion tokens. Do not compute cost by summing naively.

## Finding 7 — Every observed delta is single-chunk, which proves nothing

STATUS listed multi-chunk `delta` accumulation as unverified. It still is:

| Type | Distinct ids | Deltas per id |
|---|---|---|
| `TEXT_MESSAGE_CONTENT` | 24 | 1, always |
| `TOOL_CALL_ARGS` | 32 | 1, always |
| `REASONING_MESSAGE_CONTENT` | 13 | 1, always |

Every single message and tool-call argument arrived in exactly one delta. The accumulation code
in `src/spike/lib/agent-step.ts` has therefore never been exercised on a multi-delta input.

This is a property of the model/gateway used (`opencode-go/deepseek-v4.1-flash`, non-streaming
deltas), not a guarantee. The event type must keep storing deltas as they arrive, and any
accumulation logic stays unverified until a genuinely streaming provider is tried.

## Finding 8 — CUSTOM events are the interesting ones, and one of them is polluted

Four `CUSTOM` names across the corpora:

| Name | Count | Carries |
|---|---|---|
| `sandbox.file` | 15 | `{type: "create"\|"change", path, timestamp}` |
| `opencode.session-id` | 13 | `{sessionId}` — fresh per step, confirming D10 |
| `structured-output.complete` | 2 | `{object, raw, messageId}` — the D11 mechanism at runtime |
| `structured-output.start` | 2 | `{messageId}` |

`sandbox.file` would be an attractive source of "files changed" UI, but its paths are in two
incompatible namespaces:

```
/workspace/src/index.ts                                                    <- sandbox-relative, fine
/workspace/src/index.test.ts                                               <- sandbox-relative, fine
/workspace/data/src/factory/.factory/factory-spike/.tanstack-projected-…   <- /workspace + host-absolute
```

The third is the D16 marker-path resolution bug leaking into the event stream: a host-absolute
path concatenated onto the sandbox root. 9 of 15 `sandbox.file` events are about that stray
marker file rather than about real work.

**Consequence:** `sandbox.file` is not usable as a host-path file-change feed today. It stays
inside the opaque chunk rather than being promoted to a typed Factory event. Recheck when the
upstream bug is fixed.

## Finding 9 — Metadata is uniform enough to ignore, except where it is not

`metadata.tanstack` is present on all chunk types except `TEXT_MESSAGE_CONTENT`,
`TOOL_CALL_ARGS` and the un-tagged `sandbox.file` CUSTOM events. It almost always contains just
`{model}`. Three exceptions carry more:

- `RUN_FINISHED` → `{model, finishReason}`
- `TOOL_CALL_END` → `{model, toolCallName, toolName, input}` (duplicating the top-level fields)
- `structured-output.*` CUSTOM → `{model, threadId, runId}`

Nothing here justifies a typed Factory field; it rides along inside the opaque chunk.

## Method

```bash
cd .factory/runs
cat */chunks.ndjson | jq -c 'if has("chunk") then .chunk else . end' \
  | jq -r '"\(.type)\t\(keys_unsorted|join(","))"' | sort | uniq -c   # field inventory
grep -rhno "EventType\.[A-Z_]*" node_modules/@tanstack/ai-opencode/src/ \
  | sed 's/.*EventType\.//' | sort -u                                  # adapter's closed set
sed -n '200,233p' node_modules/@tanstack/ai/src/client.ts              # the protocol's 33
```

The inversion, interleaving, delta-count and cancellation findings are all re-derived on every
`bun test` run from the committed fixtures, in `src/events.test.ts`.
