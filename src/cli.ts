#!/usr/bin/env bun
/**
 * `factory run <workflow.ts>` (STATUS.md phase 1: "CLI-driven, in-memory; no
 * server, no sqlite"). Dynamic-imports a workflow module's `default` export,
 * optionally clones a fresh working tree, runs it against real opencode,
 * and streams `RunEvent`s to stdout and an NDJSON file. `SIGINT` cancels the
 * in-flight run rather than killing the process outright, so the runtime's
 * own cancellation path (`RunCancelledSignal`, `AgentStepFinished{outcome:
 * "cancelled"}`) gets exercised instead of an unclean process kill.
 *
 * Phase 2: every event is also written to sqlite as it's emitted (`--db`,
 * default `.factory/factory.db`), and `factory runs`/`factory log <runId>`
 * read that store back — including for runs the process never lived to see
 * finish (D12: an interrupted run's history stays intact and queryable).
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, FileSystem, Layer, ManagedRuntime, Path, Stdio, Terminal } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { CliError, Command } from "effect/unstable/cli";
import type { RunEvent } from "./events";
import { findFactoryConfig, loadFactoryConfig } from "./config";
import { initCli } from "./init";
import type { RunRepo } from "./runtime/run";
import { resetClone, type GitIdentity } from "./lib/clone";
import { loadWorkflow } from "./lib/load-workflow";
import { streamSse } from "./lib/sse-client";
import { appendEvent, getRunEvents, listRuns, openStore } from "./persistence/store";
import type { AgentAdapter } from "./runtime/agent-adapter";
import { opencodeAdapter } from "./runtime/opencode-adapter";
import { AgentRuntimeLayer } from "./runtime/agent-runtime";
import { startRun } from "./runtime/run";
import { startDaemon, type DaemonOptions } from "./server/daemon";

const DEFAULT_DB_PATH = ".factory/factory.db";
const DEFAULT_DAEMON_URL = "http://localhost:3000";

export interface CliOptions {
  readonly workflowPath: string;
  readonly input: unknown;
  readonly dir: string;
  readonly clone?: { readonly sshUrl: string; readonly identity: GitIdentity };
  readonly outPath: string;
  readonly dbPath: string;
  /**
   * Injectable agent adapter for tests. When omitted, `runCli` falls back to
   * `factory.config.ts`'s `agent.adapter` (or the live opencode adapter).
   */
  readonly adapter?: AgentAdapter;
}

function formatEvent(event: RunEvent): string {
  const { _tag, ...rest } = event.payload as { _tag: string } & Record<string, unknown>;
  return `[${event.seq}] ${_tag} ${JSON.stringify(rest)}`;
}

export async function runCli(options: CliOptions): Promise<number> {
  const workflow = await loadWorkflow(options.workflowPath);

  if (options.clone !== undefined) {
    await resetClone(options.dir, options.clone.sshUrl, options.clone.identity);
  }

  await mkdir(dirname(options.outPath), { recursive: true });
  const sink = Bun.file(options.outPath).writer();

  await mkdir(dirname(options.dbPath), { recursive: true });
  const db = openStore(options.dbPath);

  const runId = `run-${Date.now()}`;
  let repo: RunRepo | undefined;
  let adapter = options.adapter ?? opencodeAdapter;
  try {
    const config = await loadFactoryConfig();
    repo = { slug: config.repo.slug, baseBranch: config.repo.baseBranch };
    adapter = options.adapter ?? config.agent.adapter;
  } catch {
    repo = undefined;
  }
  const runtime = ManagedRuntime.make(AgentRuntimeLayer(adapter));
  const handle = await startRun(workflow, runtime, {
    runId,
    dir: options.dir,
    input: options.input,
    ...(repo !== undefined ? { repo } : {}),
    onEvent: (event) => {
      console.log(formatEvent(event));
      void sink.write(`${JSON.stringify(event)}\n`);
      appendEvent(db, event);
    },
  });

  const onSigint = () => {
    console.error("\nSIGINT received, cancelling run...");
    void handle.cancel();
  };
  process.on("SIGINT", onSigint);

  const outcome = await handle.result;
  process.off("SIGINT", onSigint);
  await sink.end();
  db.close();

  console.log(`\nrun ${runId}: ${outcome.outcome}`);
  if (outcome.outcome === "failed") {
    console.error(outcome.error);
    return 1;
  }
  if (outcome.outcome === "cancelled") return 130;
  return 0;
}

/** `factory runs [--db <path>]` — every run this store has ever seen, including interrupted ones. */
export function listRunsCli(dbPath: string): void {
  const db = openStore(dbPath);
  try {
    const runs = listRuns(db);
    if (runs.length === 0) {
      console.log("no runs recorded");
      return;
    }
    for (const run of runs) {
      const finished = run.finishedAt !== undefined ? new Date(run.finishedAt).toISOString() : "-";
      console.log(
        `${run.runId}\t${run.workflowId ?? "?"}\t${run.status}\t${run.eventCount} events\tfinished ${finished}`,
      );
    }
  } finally {
    db.close();
  }
}

/** `factory log <runId> [--db <path>]` — replay a persisted run's event history. */
export function logRunCli(dbPath: string, runId: string): void {
  const db = openStore(dbPath);
  try {
    const events = getRunEvents(db, runId);
    if (events.length === 0) {
      console.error(`no events recorded for run ${runId}`);
      process.exit(1);
    }
    for (const event of events) console.log(formatEvent(event));
  } finally {
    db.close();
  }
}

export interface StartCliOptions {
  readonly baseUrl: string;
  readonly workflowId: string;
  readonly input: unknown;
  readonly watch: boolean;
}

export interface WatchSseOptions {
  readonly maxReconnects?: number;
  readonly reconnectDelayMs?: number;
}

/**
 * Tail one run to its terminal event, printing as it goes, and map that event
 * to an exit code.
 *
 * The reconnect policy is `lib/sse-client.ts`'s, shared with the SPA. It
 * replaces a local loop whose budget never reset, so a run with more dropped
 * connections than the budget — four quiet gaps was enough — died mid-tail
 * against a healthy daemon. It also resumes from the last seq rather than
 * re-reading from 0, so a reconnect no longer reprints the run so far.
 */
async function watchSse(
  baseUrl: string,
  runId: string,
  options: WatchSseOptions = {},
): Promise<number> {
  let exitCode: number | undefined;

  try {
    await streamSse(`${baseUrl}/api/runs/${runId}/events`, {
      maxReconnects: options.maxReconnects ?? 3,
      ...(options.reconnectDelayMs !== undefined
        ? { reconnectDelayMs: options.reconnectDelayMs }
        : {}),
      onEvent: (event: RunEvent) => {
        console.log(formatEvent(event));
        const tag = event.payload._tag;
        if (tag === "RunFinished") exitCode = 0;
        else if (tag === "RunFailed") exitCode = 1;
        else if (tag === "RunCancelled") exitCode = 130;
      },
      onMalformedFrame: () => {
        console.error(`factory start: skipping malformed frame for ${runId}`);
      },
      onReconnect: (attempt, max) => {
        console.error(`factory start: connection lost, reconnecting (${attempt}/${max})...`);
      },
    });
  } catch (err) {
    console.error(`factory start: connection lost tailing ${runId}: ${String(err)}`);
    return 1;
  }

  if (exitCode === undefined) {
    console.error(`factory start: stream for ${runId} ended without a terminal event`);
    return 1;
  }
  return exitCode;
}

export { watchSse };

export async function startCli(options: StartCliOptions): Promise<number> {
  let res: Response;
  try {
    res = await fetch(`${options.baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflowId: options.workflowId, input: options.input }),
    });
  } catch (err) {
    console.error(
      `factory start: cannot reach daemon at ${options.baseUrl} (${String(err)}) — is 'factory serve' running? (set --url or FACTORY_URL)`,
    );
    return 1;
  }

  const body = (await res.json().catch(() => ({}))) as { runId?: string; error?: string };

  if (res.status !== 201 || body.runId === undefined) {
    const hint =
      res.status === 404
        ? `no workflow with id "${options.workflowId}" — see GET /api/workflows on ${options.baseUrl}`
        : res.status === 409
          ? `the daemon is at its concurrency limit: ${body.error}`
          : (body.error ?? res.statusText);
    console.error(`factory start: failed (${res.status}): ${hint}`);
    return 1;
  }

  console.log(body.runId);
  if (!options.watch) return 0;
  return watchSse(options.baseUrl, body.runId);
}

// `effect@4.0.0-rc.115` ships no real platform layer for Stdio/Terminal/
// FileSystem/ChildProcessSpawner — no `@effect/platform-node` or
// `@effect/platform-bun` equivalent is installed, and this rc only exports
// test/noop constructors (`Stdio.layerTest`, `FileSystem.layerNoop`,
// `Terminal.make`, `ChildProcessSpawner.make`). This "environment" is
// therefore assembled from those constructors even for the real binary, with
// `args`/`columns`/`rows` wired to the real process so `effect/unstable/cli`
// sees real argv and terminal size. `readInput`/`readLine` (used by
// `Prompt`/`--wizard`) and `display` are stubbed and would die or no-op if
// exercised, and `ChildProcessSpawner` dies on use — none of the commands
// below hit those paths today: help/error text renders via `Console`
// (real stdout/stderr) rather than the injected `Stdio` sink or
// `Terminal.display`, and opencode is spawned elsewhere via `@tanstack/ai`,
// not through `ChildProcessSpawner`. Revisit once a real platform adapter is
// available, or before `--wizard` ships.
const CliEnvLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({ args: Effect.succeed(process.argv.slice(2)) }),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(process.stdout.columns || 80),
      rows: Effect.succeed(process.stdout.rows || 24),
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      display: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unused")),
  ),
);

if (import.meta.main) {
  const program = Command.run(factoryCommand, { version: "0.0.0" }).pipe(
    Effect.provide(CliEnvLayer),
  );
  // `Command.run` fails with `CliError.ShowHelp` both for genuine parse errors
  // and for "no subcommand given" / explicit `--help` (help is rendered by the
  // command definition either way). `ShowHelp.errors` distinguishes them: a
  // non-empty array is a real parse/validation failure (exit 1), an empty
  // array means help was all that happened (exit 0) — matching this error's
  // own documented exit-code mapping.
  //
  // We check that by hand instead of delegating to `Runtime.defaultTeardown`
  // (the library's usual `makeRunMain`-style teardown): that helper calls
  // `process.exit(0)` on *any* successful `Effect` completion, but `factory
  // serve`'s handler effect resolves right after starting the long-lived
  // HTTP server — forcing an exit there would kill the daemon immediately
  // after startup. Only failures get an explicit exit call here; a
  // successful run falls through to whatever keeps (or doesn't keep) the
  // process alive on its own, same as before this file started handling
  // `ShowHelp` specially.
  Effect.runPromise(program).catch((error: unknown) => {
    const isHelpOnly =
      CliError.isCliError(error) && error._tag === "ShowHelp" && error.errors.length === 0;
    if (!isHelpOnly) process.exit(1);
  });
}
