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
import { dirname, resolve } from "node:path";
import type { RunEvent } from "./events";
import { resetClone, type GitIdentity } from "./lib/clone";
import { appendEvent, getRunEvents, listRuns, openStore } from "./persistence/store";
import type { AgentAdapter } from "./runtime/agent-adapter";
import { opencodeAdapter } from "./runtime/opencode-adapter";
import { startRun } from "./runtime/run";
import type { WorkflowDefinition } from "./workflow";

const DEFAULT_DB_PATH = ".factory/factory.db";

export interface CliOptions {
  readonly workflowPath: string;
  readonly input: unknown;
  readonly dir: string;
  readonly clone?: { readonly sshUrl: string; readonly identity: GitIdentity };
  readonly outPath: string;
  readonly dbPath: string;
  readonly adapter: AgentAdapter;
}

function formatEvent(event: RunEvent): string {
  const { _tag, ...rest } = event.payload as { _tag: string } & Record<string, unknown>;
  return `[${event.seq}] ${_tag} ${JSON.stringify(rest)}`;
}

export async function runCli(options: CliOptions): Promise<number> {
  const imported: unknown = await import(resolve(options.workflowPath));
  const workflow = (imported as { default?: WorkflowDefinition }).default;
  if (workflow === undefined || typeof workflow.run !== "function") {
    throw new Error(`${options.workflowPath} has no default defineWorkflow(...) export`);
  }

  if (options.clone !== undefined) {
    await resetClone(options.dir, options.clone.sshUrl, options.clone.identity);
  }

  await mkdir(dirname(options.outPath), { recursive: true });
  const sink = Bun.file(options.outPath).writer();

  await mkdir(dirname(options.dbPath), { recursive: true });
  const db = openStore(options.dbPath);

  const runId = `run-${Date.now()}`;
  const handle = startRun(workflow, {
    runId,
    dir: options.dir,
    input: options.input,
    adapter: options.adapter,
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

function usageError(message: string): never {
  console.error(`error: ${message}`);
  console.error(
    [
      "usage:",
      "  factory run <workflow.ts> --input <json> --dir <path> [--clone <sshUrl> --git-name <name> --git-email <email>] [--out <path>] [--db <path>]",
      "  factory runs [--db <path>]",
      "  factory log <runId> [--db <path>]",
    ].join("\n"),
  );
  process.exit(1);
}

function parseFlags(argv: ReadonlyArray<string>, startAt: number): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = startAt; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      usageError(`malformed flag at position ${i}: ${key ?? "<missing>"}`);
    }
    flags.set(key.slice(2), value);
  }
  return flags;
}

function parseArgs(argv: ReadonlyArray<string>): CliOptions {
  if (argv[0] !== "run" || argv[1] === undefined) {
    usageError("expected: factory run <workflow.ts> ...");
  }

  const workflowPath = argv[1] as string;
  const flags = parseFlags(argv, 2);

  const inputRaw = flags.get("input");
  const dir = flags.get("dir");
  const out = flags.get("out") ?? `.factory/runs/run-${Date.now()}/events.ndjson`;
  const dbPath = flags.get("db") ?? DEFAULT_DB_PATH;
  if (inputRaw === undefined) usageError("--input <json> is required");
  if (dir === undefined) usageError("--dir <path> is required");

  let input: unknown;
  try {
    input = JSON.parse(inputRaw);
  } catch (err) {
    usageError(`--input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const sshUrl = flags.get("clone");
  let clone: CliOptions["clone"];
  if (sshUrl !== undefined) {
    const name = flags.get("git-name");
    const email = flags.get("git-email");
    if (name === undefined || email === undefined) {
      usageError("--clone requires --git-name and --git-email");
    }
    clone = { sshUrl, identity: { name, email } };
  }

  return { workflowPath, input, dir, clone, outPath: out, dbPath, adapter: opencodeAdapter };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "runs") {
    listRunsCli(parseFlags(argv, 1).get("db") ?? DEFAULT_DB_PATH);
  } else if (argv[0] === "log") {
    const runId = argv[1];
    if (runId === undefined) usageError("expected: factory log <runId> ...");
    logRunCli(parseFlags(argv, 2).get("db") ?? DEFAULT_DB_PATH, runId);
  } else {
    const options = parseArgs(argv);
    const exitCode = await runCli(options);
    process.exit(exitCode);
  }
}
