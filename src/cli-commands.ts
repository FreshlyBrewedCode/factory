import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { findFactoryConfig, loadFactoryConfig } from "./config";
import { initCli } from "./init";
import { resolve } from "node:path";
import {
  runCli,
  listRunsCli,
  logRunCli,
  startCli,
  type CliOptions,
  type StartCliOptions,
} from "./cli";
import { ACP_AGENT_KINDS, type AcpAgentKind } from "./runtime/acp-agents";
import { startDaemon, type DaemonOptions } from "./server/daemon";

const DEFAULT_DB_PATH = ".factory/factory.db";
const DEFAULT_DAEMON_URL = "http://localhost:3000";

/** `--agent` / `--model` as the run's agent choice, absent when neither is given. */
function agentChoiceOf(
  agent: AcpAgentKind | undefined,
  model: string | undefined,
): Pick<StartCliOptions, "agent"> {
  if (agent === undefined && model === undefined) return {};
  return {
    agent: {
      ...(agent !== undefined ? { agent } : {}),
      ...(model !== undefined ? { model } : {}),
    },
  };
}

// Each command's flag/argument spec is exported on its own so the argv tests
// parse against these exact specs with a capturing handler, instead of a
// hand-copied tree that could drift from the real one.
export const initConfig = {
  dir: Flag.String("dir").pipe(
    Flag.withDefault("."),
    Flag.withDescription("Directory to scaffold .factory/ in"),
  ),
  force: Flag.Boolean("force").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Overwrite existing files"),
  ),
};

export const initCommand = Command.make("init", initConfig, (config) =>
  Effect.gen(function* () {
    const exitCode = yield* Effect.promise(() =>
      initCli({
        cwd: resolve(config.dir),
        force: config.force,
      }),
    );
    return yield* Effect.sync(() => process.exit(exitCode));
  }),
).pipe(Command.withDescription("Scaffold .factory/ with a config and a starter workflow"));

export const serveConfig = {
  port: Flag.Int("port").pipe(
    Flag.optional,
    Flag.withDescription("Port to listen on (default: 3000)"),
  ),
  db: Flag.String("db").pipe(
    Flag.withDefault(DEFAULT_DB_PATH),
    Flag.withDescription("Path to the sqlite event store"),
  ),
  config: Flag.String("config").pipe(
    Flag.optional,
    Flag.withDescription("Path to factory.config.ts (auto-detected when omitted)"),
  ),
};

export const serveCommand = Command.make("serve", serveConfig, (config) =>
  Effect.gen(function* () {
    const configPath = Option.getOrUndefined(config.config);
    const resolvedConfigPath = configPath ?? (yield* Effect.promise(() => findFactoryConfig()));
    const configLoaded =
      resolvedConfigPath !== undefined
        ? yield* Effect.promise(() => Promise.resolve(loadFactoryConfig(resolvedConfigPath)))
        : undefined;

    const daemonOptions: DaemonOptions = {
      dbPath: config.db,
      port: Option.getOrUndefined(config.port),
      ...(resolvedConfigPath !== undefined ? { config: configLoaded } : {}),
    };

    const handle = yield* Effect.promise(() => startDaemon(daemonOptions));
    yield* Effect.sync(() =>
      console.log(`factory serve: listening on http://localhost:${handle.server.port}`),
    );
    yield* Effect.sync(() =>
      console.log(
        handle.schedulerFiber !== undefined
          ? "scheduler: running (config schedules)"
          : "scheduler: none (no schedules in config)",
      ),
    );
    // The daemon's shutdown path: stop the scheduler, cancel every active run
    // and wait (bounded) for each to record `RunCancelled` and kill its
    // `ctx.exec` children, then stop the server and dispose the runtime —
    // instead of dying with them live and leaving orphaned processes and
    // "interrupted" runs behind. `once`: a second signal falls through to the
    // default handler and kills the process outright.
    yield* Effect.sync(() => {
      const shutdown = (signal: NodeJS.Signals) => {
        void handle.stop().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  }),
).pipe(Command.withDescription("Run the daemon: HTTP API, live event stream, and the web UI"));

export const startConfig = {
  workflowId: Argument.String("workflowId").pipe(
    Argument.withDescription("The workflow id to start"),
  ),
  input: Flag.String("input").pipe(Flag.withDescription("JSON input for the workflow")),
  url: Flag.String("url").pipe(
    Flag.optional,
    Flag.withDescription("Base URL of the daemon (or set $FACTORY_URL)"),
  ),
  watch: Flag.Boolean("watch").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Stream the run's events and exit with its exit code"),
  ),
  agent: Flag.Literals("agent", ACP_AGENT_KINDS).pipe(
    Flag.optional,
    Flag.withDescription("The agent this run's steps use, unless a step names one"),
  ),
  model: Flag.String("model").pipe(
    Flag.optional,
    Flag.withDescription("The model this run's steps use, unless a step names one"),
  ),
};

export const startCommand = Command.make("start", startConfig, (config) =>
  Effect.gen(function* () {
    let input: unknown;
    try {
      input = JSON.parse(config.input);
    } catch (err) {
      console.error(
        `error: --input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      return yield* Effect.sync(() => process.exit(1));
    }

    const options: StartCliOptions = {
      workflowId: config.workflowId,
      input,
      watch: config.watch,
      ...agentChoiceOf(Option.getOrUndefined(config.agent), Option.getOrUndefined(config.model)),
      baseUrl: Option.getOrElse(config.url, () => process.env.FACTORY_URL ?? DEFAULT_DAEMON_URL),
    };

    const exitCode = yield* Effect.promise(() => startCli(options));
    return yield* Effect.sync(() => process.exit(exitCode));
  }),
).pipe(
  Command.withDescription(
    "Start a run on a running daemon. --watch streams it and exits 0 completed / 1 failed / 130 cancelled.",
  ),
);

export const runsConfig = {
  db: Flag.String("db").pipe(
    Flag.withDefault(DEFAULT_DB_PATH),
    Flag.withDescription("Path to the sqlite event store"),
  ),
};

export const runsCommand = Command.make("runs", runsConfig, (config) =>
  Effect.sync(() => {
    listRunsCli(config.db);
  }),
).pipe(Command.withDescription("List every run this project has recorded"));

export const logConfig = {
  runId: Argument.String("runId").pipe(Argument.withDescription("The run id to replay")),
  db: Flag.String("db").pipe(
    Flag.withDefault(DEFAULT_DB_PATH),
    Flag.withDescription("Path to the sqlite event store"),
  ),
};

export const logCommand = Command.make("log", logConfig, (config) =>
  Effect.sync(() => {
    logRunCli(config.db, config.runId);
  }),
).pipe(Command.withDescription("Replay one run's full event history"));

export const runConfig = {
  workflowPath: Argument.String("workflowPath").pipe(
    Argument.withDescription("Path to the workflow .ts file"),
  ),
  input: Flag.String("input").pipe(Flag.withDescription("JSON input for the workflow")),
  dir: Flag.String("dir").pipe(Flag.withDescription("Working directory for the run")),
  clone: Flag.String("clone").pipe(
    Flag.optional,
    Flag.withDescription("SSH URL to clone before running"),
  ),
  "git-name": Flag.String("git-name").pipe(
    Flag.optional,
    Flag.withDescription("Git committer name (required with --clone)"),
  ),
  "git-email": Flag.String("git-email").pipe(
    Flag.optional,
    Flag.withDescription("Git committer email (required with --clone)"),
  ),
  out: Flag.String("out").pipe(
    Flag.optional,
    Flag.withDescription("Path for the NDJSON event log"),
  ),
  db: Flag.String("db").pipe(
    Flag.withDefault(DEFAULT_DB_PATH),
    Flag.withDescription("Path to the sqlite event store"),
  ),
};

export const runCommand = Command.make("run", runConfig, (config) =>
  Effect.gen(function* () {
    let input: unknown;
    try {
      input = JSON.parse(config.input);
    } catch (err) {
      console.error(
        `error: --input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      return yield* Effect.sync(() => process.exit(1));
    }

    const sshUrl = Option.getOrUndefined(config.clone);
    let clone: CliOptions["clone"];
    if (sshUrl !== undefined) {
      const name = Option.getOrUndefined(config["git-name"]);
      const email = Option.getOrUndefined(config["git-email"]);
      if (name === undefined || email === undefined) {
        console.error("error: --clone requires --git-name and --git-email");
        return yield* Effect.sync(() => process.exit(1));
      }
      clone = { sshUrl, identity: { name, email } };
    }

    const options: CliOptions = {
      workflowPath: config.workflowPath,
      input,
      dir: config.dir,
      clone,
      outPath: Option.getOrElse(config.out, () => `.factory/runs/run-${Date.now()}/events.ndjson`),
      dbPath: config.db,
    };

    const exitCode = yield* Effect.promise(() => runCli(options));
    return yield* Effect.sync(() => process.exit(exitCode));
  }),
).pipe(Command.withDescription("Run one workflow file directly — no daemon, no UI"));

export const factoryCommand = Command.make("factory").pipe(
  Command.withDescription("factory — imperative TypeScript workflows over coding agents."),
  Command.withSubcommands([
    initCommand,
    serveCommand,
    startCommand,
    runsCommand,
    logCommand,
    runCommand,
  ]),
);
