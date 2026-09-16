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
import { findFactoryConfig, loadFactoryConfig } from "./config";
import { initCli } from "./init";
import type { RunRepo } from "./runtime/run";
import { resetClone, type GitIdentity } from "./lib/clone";
import { loadWorkflow } from "./lib/load-workflow";
import { streamSse } from "./lib/sse-client";
import { appendEvent, getRunEvents, listRuns, openStore } from "./persistence/store";
import type { AgentAdapter } from "./runtime/agent-adapter";
import { opencodeAdapter } from "./runtime/opencode-adapter";
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
  readonly adapter: AgentAdapter;
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
  try {
    const config = await loadFactoryConfig();
    repo = { slug: config.repo.slug, baseBranch: config.repo.baseBranch };
  } catch {
    repo = undefined;
  }
  const handle = startRun(workflow, {
    runId,
    dir: options.dir,
    input: options.input,
    adapter: options.adapter,
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

const USAGE = [
  "factory — imperative TypeScript workflows over coding agents.",
  "",
  "usage:",
  "  factory init [--dir <path>] [--force]",
  "      Scaffold .factory/ with a config and a starter workflow. Never",
  "      overwrites an existing file unless --force is given.",
  "",
  "  factory serve [--port <n>] [--db <path>] [--config <path>]",
  "      Run the daemon: HTTP API, live event stream, and the web UI.",
  "      Finds .factory/factory.config.ts on its own when --config is omitted.",
  "",
  "  factory start <workflowId> --input <json> [--url <base-url>] [--watch]",
  "      Start a run on a running daemon. --watch streams it and exits 0",
  "      completed / 1 failed / 130 cancelled. Honours $FACTORY_URL.",
  "",
  "  factory runs [--db <path>]",
  "      List every run this project has recorded.",
  "",
  "  factory log <runId> [--db <path>]",
  "      Replay one run's full event history.",
  "",
  "  factory run <workflow.ts> --input <json> --dir <path>",
  "        [--clone <sshUrl> --git-name <name> --git-email <email>]",
  "        [--out <path>] [--db <path>]",
  "      Run one workflow file directly — no daemon, no UI.",
  "",
  "  factory serve, with automatic dispatch from a GitHub Project (all required",
  "  together):",
  "    --dispatch-workflow <path> --dispatch-owner <login>",
  "    --dispatch-project-number <n> --dispatch-project-id <id>",
  "    --dispatch-status-field-id <id> --dispatch-in-progress-option-id <id>",
  "    --dispatch-repo <owner/repo> --dispatch-base-branch <branch>",
  "    --dispatch-clone <sshUrl> --dispatch-git-name <name>",
  "    --dispatch-git-email <email> --dispatch-work-dir <path>",
  "    [--dispatch-interval-ms <n>]",
].join("\n");

function usageError(message: string): never {
  console.error(`error: ${message}`);
  console.error("");
  console.error(USAGE);
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

function parseStartArgs(argv: ReadonlyArray<string>): StartCliOptions {
  const workflowId = argv[1];
  if (workflowId === undefined) usageError("expected: factory start <workflowId> ...");

  let inputRaw: string | undefined;
  let url: string | undefined;
  let watch = false;
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--input") {
      inputRaw = argv[++i];
      if (inputRaw === undefined) usageError("--input needs a JSON value");
    } else if (flag === "--url") {
      url = argv[++i];
      if (url === undefined) usageError("--url needs a base URL");
    } else if (flag === "--watch") {
      watch = true;
    } else {
      usageError(`unknown flag: ${flag ?? "<missing>"}`);
    }
  }

  if (inputRaw === undefined) usageError("--input <json> is required");

  let input: unknown;
  try {
    input = JSON.parse(inputRaw);
  } catch (err) {
    usageError(`--input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    workflowId,
    input,
    watch,
    baseUrl: url ?? process.env.FACTORY_URL ?? DEFAULT_DAEMON_URL,
  };
}

const DISPATCH_FLAG_NAMES = [
  "dispatch-workflow",
  "dispatch-owner",
  "dispatch-project-number",
  "dispatch-project-id",
  "dispatch-status-field-id",
  "dispatch-in-progress-option-id",
  "dispatch-repo",
  "dispatch-base-branch",
  "dispatch-clone",
  "dispatch-git-name",
  "dispatch-git-email",
  "dispatch-work-dir",
] as const;

async function parseServeArgs(argv: ReadonlyArray<string>): Promise<DaemonOptions> {
  const flags = parseFlags(argv, 1);
  const dbPath = flags.get("db") ?? DEFAULT_DB_PATH;
  const portRaw = flags.get("port");
  const port = portRaw !== undefined ? Number(portRaw) : undefined;
  // No `--config` means "find the project I am standing in" — the `factory
  // init` layout first, then the pre-init root config. Finding neither is not
  // an error: the daemon still serves the UI and the phase 3 path-based API,
  // just with an empty workflow registry.
  const configPath = flags.get("config") ?? (await findFactoryConfig());
  const configLoaded =
    configPath !== undefined ? loadFactoryConfig(configPath) : Promise.resolve(undefined);

  const build = async (): Promise<DaemonOptions> => ({
    dbPath,
    port,
    ...(configPath !== undefined ? { config: await configLoaded } : {}),
  });

  const present = DISPATCH_FLAG_NAMES.filter((name) => flags.has(name));
  if (present.length === 0) return build();

  const missing = DISPATCH_FLAG_NAMES.filter((name) => !flags.has(name));
  if (missing.length > 0) {
    usageError(`--dispatch-* flags given but missing: ${missing.map((m) => `--${m}`).join(", ")}`);
  }

  const get = (name: (typeof DISPATCH_FLAG_NAMES)[number]): string => flags.get(name) as string;

  const config = await configLoaded;

  return {
    dbPath,
    port,
    ...(config !== undefined ? { config } : {}),
    dispatch: {
      workflowPath: get("dispatch-workflow"),
      repoSlug: get("dispatch-repo"),
      baseBranch: get("dispatch-base-branch"),
      workDirRoot: get("dispatch-work-dir"),
      cloneSshUrl: get("dispatch-clone"),
      gitIdentity: { name: get("dispatch-git-name"), email: get("dispatch-git-email") },
      intervalMs: Number(flags.get("dispatch-interval-ms") ?? "60000"),
      github: {
        owner: get("dispatch-owner"),
        projectNumber: Number(get("dispatch-project-number")),
        projectId: get("dispatch-project-id"),
        statusFieldId: get("dispatch-status-field-id"),
        inProgressOptionId: get("dispatch-in-progress-option-id"),
      },
    },
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    console.log(USAGE);
    process.exit(0);
  } else if (argv[0] === "init") {
    const flags = new Map<string, boolean | string>();
    for (let i = 1; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--force") flags.set("force", true);
      else if (flag === "--dir") {
        const dir = argv[++i];
        if (dir === undefined) usageError("--dir needs a path");
        flags.set("dir", dir);
      } else usageError(`unknown flag: ${flag ?? "<missing>"}`);
    }
    const dir = flags.get("dir");
    const exitCode = await initCli({
      cwd: typeof dir === "string" ? resolve(dir) : process.cwd(),
      force: flags.get("force") === true,
    });
    process.exit(exitCode);
  } else if (argv[0] === "runs") {
    listRunsCli(parseFlags(argv, 1).get("db") ?? DEFAULT_DB_PATH);
  } else if (argv[0] === "log") {
    const runId = argv[1];
    if (runId === undefined) usageError("expected: factory log <runId> ...");
    logRunCli(parseFlags(argv, 2).get("db") ?? DEFAULT_DB_PATH, runId);
  } else if (argv[0] === "start") {
    const exitCode = await startCli(parseStartArgs(argv));
    process.exit(exitCode);
  } else if (argv[0] === "serve") {
    const daemonOptions = await parseServeArgs(argv);
    const { server, dispatchFiber } = await startDaemon(daemonOptions);
    console.log(`factory serve: listening on http://localhost:${server.port}`);
    console.log(
      dispatchFiber !== undefined
        ? "dispatch loop: running"
        : "dispatch loop: disabled (no --dispatch-* flags)",
    );
  } else {
    const options = parseArgs(argv);
    const exitCode = await runCli(options);
    process.exit(exitCode);
  }
}
