#!/usr/bin/env bun
/**
 * `factory run <workflow.ts>` (STATUS.md phase 1: "CLI-driven, in-memory; no
 * server, no sqlite"). Dynamic-imports a workflow module's `default` export,
 * optionally clones a fresh working tree, runs it against real opencode,
 * and streams `RunEvent`s to stdout and an NDJSON file. `SIGINT` cancels the
 * in-flight run rather than killing the process outright, so the runtime's
 * own cancellation path (`RunCancelledSignal`, `AgentStepFinished{outcome:
 * "cancelled"}`) gets exercised instead of an unclean process kill.
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RunEvent } from "./events";
import { resetClone, type GitIdentity } from "./lib/clone";
import type { AgentAdapter } from "./runtime/agent-adapter";
import { opencodeAdapter } from "./runtime/opencode-adapter";
import { startRun } from "./runtime/run";
import type { WorkflowDefinition } from "./workflow";

export interface CliOptions {
  readonly workflowPath: string;
  readonly input: unknown;
  readonly dir: string;
  readonly clone?: { readonly sshUrl: string; readonly identity: GitIdentity };
  readonly outPath: string;
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

  const runId = `run-${Date.now()}`;
  const handle = startRun(workflow, {
    runId,
    dir: options.dir,
    input: options.input,
    adapter: options.adapter,
    onEvent: (event) => {
      console.log(formatEvent(event));
      void sink.write(`${JSON.stringify(event)}\n`);
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

  console.log(`\nrun ${runId}: ${outcome.outcome}`);
  if (outcome.outcome === "failed") {
    console.error(outcome.error);
    return 1;
  }
  if (outcome.outcome === "cancelled") return 130;
  return 0;
}

function usageError(message: string): never {
  console.error(`error: ${message}`);
  console.error(
    "usage: factory run <workflow.ts> --input <json> --dir <path> [--clone <sshUrl> --git-name <name> --git-email <email>] [--out <path>]",
  );
  process.exit(1);
}

function parseArgs(argv: ReadonlyArray<string>): CliOptions {
  if (argv[0] !== "run" || argv[1] === undefined) {
    usageError("expected: factory run <workflow.ts> ...");
  }

  const workflowPath = argv[1] as string;
  const flags = new Map<string, string>();
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      usageError(`malformed flag at position ${i}: ${key ?? "<missing>"}`);
    }
    flags.set(key.slice(2), value);
  }

  const inputRaw = flags.get("input");
  const dir = flags.get("dir");
  const out = flags.get("out") ?? `.factory/runs/run-${Date.now()}/events.ndjson`;
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

  return { workflowPath, input, dir, clone, outPath: out, adapter: opencodeAdapter };
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const exitCode = await runCli(options);
  process.exit(exitCode);
}
