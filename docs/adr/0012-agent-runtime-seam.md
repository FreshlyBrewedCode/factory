# 0012. The agent-runtime seam — where opencode stops and Factory begins

## Status

Accepted, 2026-09-18. Decided **ahead of the implementation**, deliberately: this seam decides what
several tickets in the Effect epic are allowed to move, so it has to exist before the code does.
Unlike ADR 0001, nothing here is distilled from a spike — it is a boundary statement, and the
epic's tickets are what will test it. If a ticket falsifies a clause, this ADR gets amended rather
than the clause quietly ignored.

## Context

The agent runtime arrived from phase 0's spike and has not moved since. `AgentAdapter`
(`src/runtime/agent-adapter.ts`) is a genuine seam — one method, `stream(options) =>
AsyncIterable<unknown>`, with two real implementations (live opencode, corpus replay) and an
identical runtime code path through both. That part works and is not in question.

What is in question is the split of responsibilities *across* that seam. Interpretation of the
chunk stream sits on the Factory side, not the adapter side:

- `runtime/agent-step.ts` string-matches `CUSTOM` + `opencode.session-id` — an
  `@tanstack/ai-opencode` event name — to populate `AgentStepFinished.sessionId`, a field in the
  durable event schema.
- It also string-matches `structured-output.complete`, which is not a provider capability at all:
  ADR 0001 §1 records that the opencode **text** adapter *simulates* structured output by injecting
  JSON Schema into the prompt and re-parsing its own final message.
- `lib/sandbox-config.ts` writes `opencode.json` (`permission: {"*": "allow"}`, issue #24) into
  every run tree, called from `lib/workspace.ts`'s `allocateWorkspace` — opencode configuration
  living inside an otherwise git-shaped workspace allocator.
- `runtime/run.ts` carries a provider-qualified `DEFAULT_MODEL` constant, with no config rung in
  the otherwise four-level precedence chain.
- The adapter value is threaded by hand through eight files and roughly twenty call sites
  (`cli.ts` → `daemon.ts` → `ServerOptions` → `StartTrackedRunOptions` → `DispatchEnv` →
  `startRun` → `buildAgentStepEffect`), defaulted to `opencodeAdapter` in two separate places, and
  is not selectable from `factory.config.ts` at all.

The practical consequence: a second adapter — claude-code, codex, a raw provider loop — would have
to emit AG-UI chunks carrying **opencode's exact CUSTOM event names** just to surface a session id
or a structured output. The seam is in the right place. The responsibilities across it are not.

This is not a complaint about the POC. Every item above was the correct shortcut at the time, and
ADR 0001 says so explicitly. It is a statement that the shortcut has now been paid for twice
(issue #24's permission deadlock, and phase 5's port collision) and should stop being free.

## Decision

### 1. Chunks stay opaque and AG-UI-shaped

ADR 0003 §2 is upheld without qualification: `AgentChunk` carries an AG-UI chunk verbatim,
Factory does not re-type it into a house dialect, and the SPA keeps folding it with
`StreamProcessor` from `@tanstack/ai/client`. AG-UI is a published cross-vendor spec; re-typing 33
event types would make every adapter swap a schema migration over stored data.

This is the clause that makes the rest affordable. The seam is not "abstract away the stream" — the
stream format is already an open standard and is fine.

### 2. The adapter interprets its own stream

`AgentAdapter.stream` yields, per chunk, the opaque chunk **and** a normalized signal drawn from a
small closed union that Factory owns: the session identifier, the structured-output value, and the
run error. The runtime records those signals; it never again string-matches a vendor event name.

The union is deliberately tiny and grows only when a second adapter needs a member. It is the list
of things Factory has a *field for* — `AgentStepFinished.sessionId`, `.output`, `.error` — not a
general capability model for agents.

Corollary: `structured-output.complete` becomes an opencode-text-adapter implementation detail,
which is what ADR 0001 §1 always said it was. An adapter over a natively structured-output-capable
provider emits the same signal from a different mechanism, and the runtime's three-tier resolution
(`resolveOutput`) is unchanged.

### 3. The adapter owns its own workspace preparation

The agent runtime gets a workspace-preparation responsibility, and `opencode.json` writing moves
behind it. `lib/workspace.ts` goes back to being about git: mirror, clone, identity, retention.

The test is ownership, not mechanism: the permission policy exists because *opencode* asks
permissions nobody can answer headless (issue #24). A workspace allocator has no way to know that
and no business knowing it.

### 4. The agent runtime is a service, resolved from context

The adapter stops being a value threaded through every interface between the CLI and the step
runner, and becomes a service resolved from the Effect context at the daemon's composition root. It
becomes selectable from `factory.config.ts` rather than defaulted by hand in two call sites.

This is the concrete payoff that justifies introducing Effect's DI at all (ADR 0009, as amended):
roughly twenty pass-through sites exist for no reason other than the absence of a context to read
from, and `DispatchEnv` — a bag that exists to carry environment down a recursive dispatch chain —
loses a field.

### 5. The adapter interface stays plain async

`stream` keeps returning an `AsyncIterable`, not a `Stream.Stream`. ADR 0009 §2's rule applies: an
adapter is an integration point that someone should be able to write without knowing Effect, and
`Stream.fromAsyncIterable` at the boundary is one line. Effect's role in the agent runtime stays
what ADR 0001 §5 proved it good for — interruption and finalization inside `agent-step.ts` — and
does not spread into the adapter contract.

### 6. The sandbox provider is not abstracted yet

`localProcessSandbox` stays hardcoded in the opencode adapter, along with `defineWorkspace({source:
{type: "none"}})`, `lifecycle.reuse: "thread"`, and per-call free-port resolution. There is exactly
one implementation, and the adapter already documents that a published-ports docker path will force
the port logic open regardless. Abstracting one implementation is speculation; this ADR declines
it, and the trigger for revisiting is a real non-host sandbox, not a second model provider.

## Consequences

- **A second adapter becomes a normal amount of work.** It implements `stream` (opaque chunks plus
  signals) and `prepareWorkspace`, and nothing in `runtime/` or `lib/` changes. That is the whole
  point of the ADR; until it lands, "pluggable adapter" is a claim the code does not support.
- **`AgentStepFinished.sessionId` stays in the event schema and stays optional.** It is genuinely
  useful (it links a step to a resumable opencode session) and genuinely not universal. An adapter
  with no session concept simply never emits the signal. This is the one place a vendor-shaped
  field survives the refactor, knowingly.
- **The normalized signal union is a new thing to keep honest.** It will be tempting to grow it
  into a capability model. The rule above — a member exists only when Factory has a field for it —
  is the brake, and reviews should apply it.
- **The runtime keeps two structured-output extraction tiers.** Moving the event-name matching into
  the adapter does not remove the `finalText` re-parse fallback; ADR 0001 §1's tier-2 path is about
  the *value* being malformed, not about where the event came from.
- **`opencode.json` becomes invisible to the workspace tests.** `lib/workspace.test.ts`'s injected
  fake exec currently leaves `dir` absent, which is why `allocateWorkspace` guards the write with an
  `existsSync`. That guard goes away with the responsibility.
- **This ADR does not touch the authoring surface.** `ctx.agent`'s signature, the precedence chain,
  and the plain-async contract are ADR 0002/0009 and are unaffected. The one authoring-surface
  change in flight — `permissionMode` being declared and never read — is a separate defect, not a
  consequence of this seam.
