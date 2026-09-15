# 0007. Per-run free port for the in-sandbox opencode serve (D34)

## Status

Accepted (2026-09-15). Live-leg-proven, not pre-implementation: the failure it fixes recurred
deterministically in phase 5's P6 concurrency leg before it, and the retried leg after the fix
passed clean (`docs/findings/11-phase5-live-leg.md`, finding L1).

## Context

The opencode adapter (`@tanstack/ai-opencode`) boots an `opencode serve` process *inside* the
run's sandbox and connects the host client to it over a port. D10 gives one sandbox per run
(`threadId = runId`), and D28 allocates a working tree per run — but phase 5's P6 live leg
showed the third concurrently-shared resource: when two `factory start` runs launch within
about a second of each other, the later one fails at its first agent step, ~1 s in, with
`opencode serve exited before becoming ready … ServeError`.

Root cause, reproduced twice (runs `run-1dd587f0` and `run-8ba43cef`): the adapter's
`DEFAULT_PORT` is a compile-time constant (4096). Under D7's `localProcessSandbox` the
"sandbox" is the host itself, so two runs' servers race to bind the *same host port*; the
loser exits before readiness and the sandbox boot's readiness probe rejects. Two concurrent
`createOpencode` boots on the host-side SDK path (no sandbox) do **not** collide — this is
specific to the in-sandbox fixed-port boot. Fakes never showed it: the corpus-replay adapter
spawns no server at all, and the concurrency tests run slow-fake adapters against real
sqlite/trees — exactly the boundary where fakes are blind.

## Decision

`src/runtime/opencode-adapter.ts` resolves a **fresh free port per `stream()` call** — an
ephemeral bind-then-close probe — and passes it as the adapter's `port`. No config surface,
no allocation registry: the OS picks unused ports, the collision window shrinks to the
millisecond between close-and-reuse (acceptable for a POC; two runs would have to probe the
same port in that window).

Scoped to D7's local-process sandbox: with a docker sandbox, ports must be *published* up
front (`publishPorts`), so a per-call dynamic port is not portable there — the file carries
this as a comment, and the constraint is the revisit trigger when docker lands (phase 6).

## Consequences

- **Concurrency with the real agent adapter works.** The retried leg: two simultaneous
  runs, two in-sandbox serve processes streaming at once, zero ServeError, both to real PRs
  (#12/#13).
- **No falsification elsewhere:** the adapter is per-call constructed; no run's
  threadId/sandbox identity changes; the corpus-replay path is untouched (133 `bun test`
  green, 11 playwright specs green after the change).
- Every agent step *increases* its boot work by one socket probe (sub-millisecond). Step
  durations are 30–80% of the previous path; the port is not a measurable cost.
- If opencode's own server ever binds only IPv6 (or a hostname) such that the probe's
  127.0.0.1 free-port answer is stale, the error surfaces exactly as before (readiness
  timeout) — retry semantics unchanged.
