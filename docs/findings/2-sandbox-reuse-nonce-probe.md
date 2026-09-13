# Phase 1 — The sandbox-reuse nonce probe (D10)

Evidence gathered 2026-09-14, live against real opencode (`opencode-go/deepseek-v4.1-flash`),
via `scripts/nonce-probe.ts` (throwaway, not committed — deleted after this document was
written). Written for a reader who was not there.

D10 claims: **one `threadId` per run ⇒ one sandbox, reused across every agent step in that run,
even though each step is a fresh opencode session with no shared transcript.** Phase 0's 0a-2
round trip exercised this indirectly (three steps, tracked files survived), but no run ever
isolated the claim down to "does the working tree specifically survive the session boundary,
independent of anything a workflow's own prompts happen to do." This probe does exactly that
and nothing else.

## Setup

Two `buildAgentStepEffect` calls against `opencodeAdapter`, same `threadId`
(`"nonce-probe-thread"`) and same `dir` (`/tmp/factory-nonce-probe`, empty before the run),
different prompts, no PR/write-back involved:

1. **Step 1** ("write"): "Write the exact text `"<nonce>"` ... to a new file named `nonce.txt`
   in the current directory."
2. **Step 2** ("read", a fresh session per D10 — no `sessionId` passed, no memory of step 1's
   conversation): "Read the file `nonce.txt` in the current directory and reply with only its
   exact contents, nothing else."

`<nonce>` is `` `nonce-${Math.random().toString(36).slice(2)}` ``, regenerated per run so a
stale file left over from a previous attempt can't produce a false positive.

## Finding — Confirmed: the tree survives, the transcript doesn't

Three independent runs, all consistent. Citing the third (`nonce-2my7lrkps6p`):

**1. Step 2's own tool call read back the exact byte the previous session wrote**, from inside
the sandbox, not just observed from the host:

```json
{"type":"TOOL_CALL_RESULT","toolCallId":"call_00_ET_SpKXNU2qa9XDA1wOydOd4905", ...,
 "content":"<path>/tmp/factory-nonce-probe/nonce.txt</path>\n<type>file</type>\n<content>\n1: nonce-2my7lrkps6p\n\n(End of file - total 1 lines)\n</content>"}
```

**2. The host filesystem agrees**, checked directly after step 2 completed:

```
$ cat /tmp/factory-nonce-probe/nonce.txt
nonce-2my7lrkps6p
```

**3. Step 2 has no memory of step 1**: its only assistant turn (below) is a prompt echo, not a
reference to "the file I just wrote" — it has to `read` the file to know what's in it, which is
exactly the fresh-session behaviour D10 specifies (see the caveat below for why "prompt echo"
is the *expected* shape here, not a broken run).

This confirms D10's two halves independently: the **tree** (the sandbox's working directory) is
shared state across steps within a run; the **session** is not — step 2 had to issue its own
`read` tool call to learn the nonce rather than already knowing it.

## Caveat, not a contradiction — `finalText` is the prompt echo for both steps

`outcome.finalText` in both steps equals the prompt itself, not a natural-language answer
(`nonce present in step2 output: false` when checked against `finalText` alone — checked against
the `TOOL_CALL_RESULT` and the host file, it's present). This is not new: ADR 0001 §5 already
documents "every step's first text message is a byte-for-byte echo of that step's own prompt,
not a model turn" as a load-bearing quirk `agent-step.ts` works around by keeping only the
**last completed** `TEXT_MESSAGE`. What this probe adds: for a prompt whose only assistant turn
comes *before* a tool call with no trailing text after it — as both of these deliberately
minimal prompts are — the echoed first message is also the *last* completed message, so
`finalText` surfaces the echo with nothing to override it. The chunk sequence for both steps
confirms the shape (`TEXT_MESSAGE_*` immediately after `RUN_STARTED`/`CUSTOM`, then
`REASONING_*`/`TOOL_CALL_*`, no second `TEXT_MESSAGE_*` block):

```
step1: RUN_STARTED,CUSTOM,CUSTOM,TEXT_MESSAGE_START,TEXT_MESSAGE_CONTENT,TEXT_MESSAGE_END,
       REASONING_START,...,TOOL_CALL_START,TOOL_CALL_ARGS,TOOL_CALL_END,TOOL_CALL_RESULT,CUSTOM,RUN_FINISHED
step2: RUN_STARTED,CUSTOM,TEXT_MESSAGE_START,TEXT_MESSAGE_CONTENT,TEXT_MESSAGE_END,
       TOOL_CALL_START,TOOL_CALL_ARGS,TOOL_CALL_END,TOOL_CALL_RESULT,RUN_FINISHED
```

Workflow prompts that need a genuine natural-language final answer (`PR_METADATA_PROMPT` in
`workflows/implement-issue.ts`) are already phrased to require reading/reasoning *then*
answering in text with no further tool call — which is exactly what 0a-2's corpus showed
producing a real, non-echoed `finalText`. Nothing here changes that design; it's a second,
independent citation of the same already-worked-around quirk, not a new one.

## Conclusion

D10 stands, now confirmed by a probe that isolates exactly the claim it rests on rather than
inferring it from a workflow that also happened to pass. No design change follows from this
finding — it closes the STATUS.md phase-1 checklist item ("run the sandbox-reuse nonce probe
early").
