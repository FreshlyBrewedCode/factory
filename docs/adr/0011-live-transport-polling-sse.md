# 0011. Live data to the SPA: polled list, per-run SSE, and a reconnecting client (D26)

## Status

Accepted. D26 decided 2026-09-14 in phase 4's transport question and shipped with the SPA;
**amended 2026-09-16** by the keepalive/resume work that fixed live runs reading as `interrupted`,
and recorded here 2026-09-17 when `docs/decisions.md` was retired. The amendment is
live-proven, not designed: the failure was watched against a real daemon and the fix measured the
same way.

## Context

Two consumers tail a run: the SPA's run-detail page and `factory start --watch`. The question in
phase 4 was SSE per run versus one multiplexed WebSocket for the whole app. The question in phase 6
was why a perfectly healthy run turned `interrupted` in the UI after about twelve seconds.

## Decision

### 1. Polling for the list, SSE for a run (D26)

The runs list is polled; run detail opens `GET /api/runs/:id/events`, which replays from the store
and then tails. Frames carry `id: ${seq}` and the handler honours `Last-Event-ID`, so a reconnect
resumes instead of replaying. Clients go through one seam — `subscribeToRun(runId, sinceSeq,
onEvent)` — so swapping transport later is one file.

A multiplexed WebSocket is **deferred, not rejected**. The transcript is not a separate stream —
`AgentChunk` is a `RunEventPayload` sharing the same `seq` space (ADR 0003) — so the only
multiplexing available is *across runs*, and the SPA opens SSE only on run detail, which shows one
run. What a WebSocket would genuinely buy, resumable reconnect, `seq` + `Last-Event-ID` already
buys in about five lines. Against that, a WS rewrite must reproduce `sseStream`'s
subscribe-before-read → buffer → dedupe-by-`seq` ordering per dynamic subscription, which is the
subtlest thing phase 3 built. (D26's original trigger was "WIP rises above 1"; D29 fired that and
the conclusion did not move, for the reason above. The live trigger is the SPA needing more than
one run on screen at once, or per-run connection count becoming a real problem.)

### 2. The server keeps a quiet stream open

`Bun.serve`'s `idleTimeout` defaults to **10 seconds** and closes any connection with no traffic. A
run's SSE stream is only as chatty as the workflow, so a `ctx.exec` running a test suite or a
write-back pushing goes quiet past the cliff. `server/http.ts` sends a `:keepalive` comment frame
every 5 s (`DEFAULT_SSE_KEEPALIVE_MS`), cleared with the subscription in `finish()`/`cancel()`.

A keepalive rather than a raised `idleTimeout` because Bun caps that option at 255 s, which one long
agent step would still outlast; a comment frame holds a stream open for any gap length.

### 3. One reconnecting client, shared by both consumers

`src/lib/sse-client.ts` is the single implementation of the retry policy, read by the SPA
(`web/api.ts`) and by `factory start --watch`. Two copies of a retry policy drift, and these had:
the CLI's budget never reset, so four quiet gaps killed a tail against a healthy daemon, while the
SPA had no policy at all. The budget (`DEFAULT_MAX_RECONNECTS = 5`, 1 s apart; the CLI passes 3)
counts only
*consecutive* attempts that received nothing; any bytes — an event, or just a keepalive — are
progress and refill it. Resuming is idempotent because every event is durable and `Last-Event-ID`
is an offset the server already honours.

### 4. "Live" is the stream **or** the registry, never the store alone

`web/lib/status.ts`'s `runDetailStatus` is a pure projection: a run reads live if the stream is open
*or* the polled summary's `active` bit says the server still holds it. The bug it replaced passed a
hardcoded `active: false` and so could never report a live run once the stream was down — falling
back to the store's read-time `interrupted` (ADR 0010), which is what the store derives for *every*
run without a terminal event, live ones included.

## Consequences

- **`interrupted` keeps its ADR 0010 meaning** — no terminal event *and* no process holding the
  run. The transport layer supplies the second half rather than the store learning about liveness.
- **A dropped connection is no longer an outcome.** Both consumers survive laptop sleep, a network
  blip and any idle gap; a genuinely unreachable server still gives up promptly, because the budget
  counts consecutive *empty* attempts.
- **Every open stream costs a 5 s timer.** Cleared on both close paths, with a cleanup guard in
  `http.test.ts`; a leak here would be a timer per abandoned connection.
- **Keepalive frames are invisible to `RunEvent` consumers** — a `:`-prefixed comment has no
  `data:`, so parsers skip it — but they are *not* invisible to the retry budget, which is the
  point: quiet progress still counts as progress.
- **The WebSocket deferral now has a second cost centre.** Anything replacing this transport must
  reproduce the keepalive and the resume budget as well as phase 3's ordering.
- _Validated by:_ `server/http.test.ts` (keepalive across a real quiet gap, timer cleanup),
  `lib/sse-client.test.ts` (resume offsets, budget exhaustion, refill on interleaved progress, quiet
  exit on abort — each verified to fail against a mutant of the line it covers),
  `web/lib/status.test.ts` (the six-way projection) and `cli.start.test.ts` (five drops against a
  budget of three, no reprinting). Manual leg: a real 15 s `ctx.exec` gap watched through the real
  server — zero drops with the keepalive; with it disabled the drop lands at 12.0 s and the
  reconnect recovers it.
