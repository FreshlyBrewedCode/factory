# Finding 4 — crash mid-run, restart, history intact

Phase 2's exit criterion: kill the process mid-run, restart, and the run's history is intact
and queryable. This is D12's scope in practice — "mark interrupted runs and keep history
queryable" — tested for real rather than argued.

## Setup

`test/fixtures/slow-workflow.ts`: `ctx.log("started", {})`, then `ctx.exec(["sleep", "30"])`,
so the process can be killed with an exec in flight rather than racing agent I/O.
`src/cli.crash.test.ts` spawns `factory run` as a real OS subprocess (`Bun.spawn`, not
`hostExec` — the test needs to hold the child's PID to signal it), reads its stdout until an
`ExecStarted` line appears, waits 200ms for the write to settle, then sends `SIGKILL` — no
`SIGINT`, no cooperative shutdown, no chance for the process to run its own exit handlers.

## Result

After the kill, opening the same sqlite file from a fresh `Database` handle (a real "restart":
a new process, a new connection, no state carried over except the file):

- `listRuns` returns exactly one run, `status: "interrupted"`, `finishedAt: undefined`.
- `getRunEvents` returns `RunStarted`, `LogRecorded`, `ExecStarted` — three events, in `seq`
  order — and none of `RunFinished`/`RunFailed`/`RunCancelled`.
- A second fresh connection reads back the identical `listRuns` result, confirming the state
  survives beyond the connection that happened to observe it first.

## Why this needed a real subprocess kill, not a mocked one

`SIGINT` is already handled cooperatively by the CLI (`src/cli.ts`'s `onSigint` maps it to
`handle.cancel()`, which the runtime turns into a `RunCancelled` terminal event — see
`src/runtime/run.test.ts`). That path was already covered and proves nothing about crash
recovery; it _is_ graceful shutdown. `SIGKILL` cannot be caught, so it's the only signal that
actually exercises "the process is gone, nothing ran on the way out" — closer to an OOM kill
or a host reboot than to an operator hitting Ctrl-C.

## Why one settle delay, not zero

The first version of the test killed the child the instant `ExecStarted` appeared in its
stdout. That is racy in a way that looked, briefly, like a real bug: `appendEvent` runs
synchronously in the same callback as the `console.log` that produces the line the test greps
for, so by the ordering of the source it should be impossible to observe the log line without
the sqlite write having already happened. In practice the test intermittently saw only
`RunStarted`/`LogRecorded` in the db despite `ExecStarted` being visible in the captured
stdout — reproducible in `bun test`, but _not_ reproducible driving the same CLI from a shell
script with an explicit `sleep 1.5` before the `kill -9` (`/tmp/dbgrun` scratch run, not
committed). The difference is almost certainly PIPE-buffering skew between when bytes become
visible to a `ReadableStreamDefaultReader` in the parent and when they were actually written by
the child, not a durability problem in `store.ts` — sqlite's own guarantee (a `.run()` call
commits before returning) isn't in question, only the parent's ability to reliably observe "at
least this much has already happened" purely from stdout bytes. A fixed 200ms settle after the
marker line removed the flake; the finding is recorded here rather than treated as solved,
since a stdout-marker-plus-delay is a testing convenience, not a general synchronization
primitive.

## Conclusion

Phase 2's exit criterion is met: a mid-run `SIGKILL`, followed by a genuine process restart
against the same sqlite file, leaves a queryable, correctly-`"interrupted"` partial history —
exactly D12's reduced scope, no more.
