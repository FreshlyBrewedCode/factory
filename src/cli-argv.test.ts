import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { Command } from "effect/unstable/cli";
import { CliEnvLayer, normalizeArgv } from "./cli";
import {
  factoryCommand,
  initConfig,
  logConfig,
  runConfig,
  runsConfig,
  serveConfig,
  startConfig,
} from "./cli-commands";

const CLI = `${import.meta.dir}/cli.ts`;

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

// Each subcommand is rebuilt from the real flag/argument spec exported by
// cli-commands.ts, with a handler that only captures the parsed config — so
// these tests parse exactly what the binary parses without running opencode,
// the daemon, or sqlite.
function runFactory(argv: ReadonlyArray<string>) {
  let captured: unknown;
  const capture = (config: unknown) =>
    Effect.sync(() => {
      captured = config;
    });
  const testCmd = Command.make("factory").pipe(
    Command.withSubcommands([
      Command.make("init", initConfig, capture),
      Command.make("serve", serveConfig, capture),
      Command.make("start", startConfig, capture),
      Command.make("runs", runsConfig, capture),
      Command.make("log", logConfig, capture),
      Command.make("run", runConfig, capture),
    ]),
  );

  return Effect.gen(function* () {
    yield* Command.runWith(testCmd, { version: "0.0.0", renderErrors: false })(argv);
    return captured;
  }).pipe(Effect.provide(CliEnvLayer));
}

describe("CLI argv parsing with effect/unstable/cli", () => {
  describe("init", () => {
    test("defaults: --dir defaults to '.', --force defaults to false", async () => {
      const result = await Effect.runPromise(runFactory(["init"]));
      const r = result as { dir: string; force: boolean };
      expect(r.dir).toBe(".");
      expect(r.force).toBe(false);
    });

    test("--dir and --force flags", async () => {
      const result = await Effect.runPromise(runFactory(["init", "--dir", "/tmp/test", "--force"]));
      const r = result as { dir: string; force: boolean };
      expect(r.dir).toBe("/tmp/test");
      expect(r.force).toBe(true);
    });
  });

  describe("serve", () => {
    test("defaults: --db defaults, --port and --config are optional", async () => {
      const result = await Effect.runPromise(runFactory(["serve"]));
      const r = result as {
        port: Option.Option<number>;
        db: string;
        config: Option.Option<string>;
      };
      expect(r.db).toBe(".factory/factory.db");
      expect(Option.isNone(r.port)).toBe(true);
      expect(Option.isNone(r.config)).toBe(true);
    });

    test("--port accepts an integer", async () => {
      const result = await Effect.runPromise(runFactory(["serve", "--port", "8080"]));
      const r = result as { port: Option.Option<number> };
      expect(Option.getOrNull(r.port)).toBe(8080);
    });

    test("--port rejects a non-numeric value", async () => {
      let failed = false;
      try {
        await Effect.runPromise(runFactory(["serve", "--port", "abc"]));
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    });

    test("--db and --config flags", async () => {
      const result = await Effect.runPromise(
        runFactory(["serve", "--db", "/tmp/factory.db", "--config", "/tmp/factory.config.ts"]),
      );
      const r = result as { db: string; config: Option.Option<string> };
      expect(r.db).toBe("/tmp/factory.db");
      expect(Option.getOrNull(r.config)).toBe("/tmp/factory.config.ts");
    });
  });

  describe("start", () => {
    test("required positional workflowId and --input", async () => {
      const result = await Effect.runPromise(
        runFactory(["start", "my-workflow", "--input", '{"x":1}']),
      );
      const r = result as {
        workflowId: string;
        input: string;
        watch: boolean;
        url: Option.Option<string>;
      };
      expect(r.workflowId).toBe("my-workflow");
      expect(r.input).toBe('{"x":1}');
      expect(r.watch).toBe(false);
      expect(Option.isNone(r.url)).toBe(true);
    });

    test("--watch flag is boolean", async () => {
      const result = await Effect.runPromise(
        runFactory(["start", "wf", "--input", "{}", "--watch"]),
      );
      const r = result as { watch: boolean };
      expect(r.watch).toBe(true);
    });

    test("--url flag", async () => {
      const result = await Effect.runPromise(
        runFactory(["start", "wf", "--input", "{}", "--url", "http://localhost:3000"]),
      );
      const r = result as { url: Option.Option<string> };
      expect(Option.getOrNull(r.url)).toBe("http://localhost:3000");
    });

    test("--agent and --model (ADR 0013 §2)", async () => {
      const result = await Effect.runPromise(
        runFactory(["start", "wf", "--input", "{}", "--agent", "claude", "--model", "haiku"]),
      );
      const r = result as { agent: Option.Option<string>; model: Option.Option<string> };
      expect(Option.getOrNull(r.agent)).toBe("claude");
      expect(Option.getOrNull(r.model)).toBe("haiku");
    });

    test("--agent and --model are optional", async () => {
      const result = await Effect.runPromise(runFactory(["start", "wf", "--input", "{}"]));
      const r = result as { agent: Option.Option<string>; model: Option.Option<string> };
      expect(Option.isNone(r.agent)).toBe(true);
      expect(Option.isNone(r.model)).toBe(true);
    });

    test("an unknown --agent fails", async () => {
      let failed = false;
      try {
        await Effect.runPromise(runFactory(["start", "wf", "--input", "{}", "--agent", "codex"]));
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    });

    test("missing --input fails", async () => {
      let failed = false;
      try {
        await Effect.runPromise(runFactory(["start", "wf"]));
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    });

    test("missing workflowId fails", async () => {
      let failed = false;
      try {
        await Effect.runPromise(runFactory(["start", "--input", "{}"]));
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    });
  });

  describe("runs", () => {
    test("defaults", async () => {
      const result = await Effect.runPromise(runFactory(["runs"]));
      const r = result as { db: string };
      expect(r.db).toBe(".factory/factory.db");
    });

    test("--db flag", async () => {
      const result = await Effect.runPromise(runFactory(["runs", "--db", "/tmp/factory.db"]));
      const r = result as { db: string };
      expect(r.db).toBe("/tmp/factory.db");
    });
  });

  describe("log", () => {
    test("required positional runId and --db default", async () => {
      const result = await Effect.runPromise(runFactory(["log", "run-123"]));
      const r = result as { runId: string; db: string };
      expect(r.runId).toBe("run-123");
      expect(r.db).toBe(".factory/factory.db");
    });

    test("missing runId fails", async () => {
      let failed = false;
      try {
        await Effect.runPromise(runFactory(["log"]));
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    });
  });

  describe("run", () => {
    test("required flags: --input and --dir", async () => {
      const result = await Effect.runPromise(
        runFactory(["run", "workflow.ts", "--input", '{"a":1}', "--dir", "/tmp/work"]),
      );
      const r = result as {
        workflowPath: string;
        input: string;
        dir: string;
        db: string;
        clone: Option.Option<string>;
        out: Option.Option<string>;
      };
      expect(r.workflowPath).toBe("workflow.ts");
      expect(r.input).toBe('{"a":1}');
      expect(r.dir).toBe("/tmp/work");
      expect(r.db).toBe(".factory/factory.db");
      expect(Option.isNone(r.clone)).toBe(true);
      expect(Option.isNone(r.out)).toBe(true);
    });

    test("--clone group with --git-name and --git-email", async () => {
      const result = await Effect.runPromise(
        runFactory([
          "run",
          "wf.ts",
          "--input",
          "{}",
          "--dir",
          "/tmp",
          "--clone",
          "git@github.com:a/b.git",
          "--git-name",
          "Factory",
          "--git-email",
          "factory@test.com",
        ]),
      );
      const r = result as {
        clone: Option.Option<string>;
        "git-name": Option.Option<string>;
        "git-email": Option.Option<string>;
      };
      expect(Option.getOrNull(r.clone)).toBe("git@github.com:a/b.git");
      expect(Option.getOrNull(r["git-name"])).toBe("Factory");
      expect(Option.getOrNull(r["git-email"])).toBe("factory@test.com");
    });

    test("--out and --db flags", async () => {
      const result = await Effect.runPromise(
        runFactory([
          "run",
          "wf.ts",
          "--input",
          "{}",
          "--dir",
          "/tmp",
          "--out",
          "/tmp/events.ndjson",
          "--db",
          "/tmp/factory.db",
        ]),
      );
      const r = result as { out: Option.Option<string>; db: string };
      expect(Option.getOrNull(r.out)).toBe("/tmp/events.ndjson");
      expect(r.db).toBe("/tmp/factory.db");
    });

    test("missing --dir fails", async () => {
      let failed = false;
      try {
        await Effect.runPromise(runFactory(["run", "wf.ts", "--input", "{}"]));
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    });
  });

  describe("help", () => {
    test("--help completes (help is generated by the CLI definition)", async () => {
      await Effect.runPromise(runFactory(["--help"]));
    });

    test("subcommand --help completes (help is generated per subcommand)", async () => {
      await Effect.runPromise(runFactory(["serve", "--help"]));
    });
  });

  describe("unknown flags", () => {
    test("unknown flag is rejected", async () => {
      let failed = false;
      try {
        await Effect.runPromise(runFactory(["serve", "--nope"]));
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    });
  });
});

describe("factoryCommand exports", () => {
  test("the root command has exactly the subcommands exercised above", () => {
    const names = factoryCommand.subcommands.flatMap((g) => g.commands.map((c) => c.name));
    expect(names.toSorted()).toEqual(["init", "log", "run", "runs", "serve", "start"]);
  });
});

describe("normalizeArgv", () => {
  test("`help` is an alias for --help, on the root and on a subcommand", () => {
    expect(normalizeArgv(["help"])).toEqual(["--help"]);
    expect(normalizeArgv(["help", "serve"])).toEqual(["serve", "--help"]);
  });

  test("anything else passes through untouched", () => {
    expect(normalizeArgv(["serve", "--port", "1"])).toEqual(["serve", "--port", "1"]);
    expect(normalizeArgv([])).toEqual([]);
  });
});

// The exit-code mapping for `Command.run`'s ShowHelp failure lives in the
// `import.meta.main` block at the bottom of cli.ts, not in `runWith` (which
// the `runFactory` helper above exercises in-process). It's only observable
// by actually running the binary as a subprocess, matching the style of
// cli.start.test.ts / cli.crash.test.ts.
describe("factory binary: process exit codes", () => {
  test("bare `factory` with no args prints root help to stdout and exits 0", async () => {
    const proc = Bun.spawn(["bun", CLI], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    const stdout = await readAll(proc.stdout);
    const stderr = await readAll(proc.stderr);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
    expect(stderr).toBe("");
  });

  test("`factory --help` prints help and exits 0", async () => {
    const proc = Bun.spawn(["bun", CLI, "--help"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    const stdout = await readAll(proc.stdout);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
  });

  test("`factory -h` prints help and exits 0", async () => {
    const proc = Bun.spawn(["bun", CLI, "-h"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
  });

  test("`factory help` prints help and exits 0", async () => {
    const proc = Bun.spawn(["bun", CLI, "help"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    const stdout = await readAll(proc.stdout);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
  });

  test("`factory help serve` prints the subcommand's help and exits 0", async () => {
    const proc = Bun.spawn(["bun", CLI, "help", "serve"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    const stdout = await readAll(proc.stdout);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("factory serve");
  });

  test("a genuine parse error (--port abc) still exits non-zero", async () => {
    const proc = Bun.spawn(["bun", CLI, "serve", "--port", "abc"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;

    expect(exitCode).not.toBe(0);
  });

  test("an unknown flag still exits non-zero", async () => {
    const proc = Bun.spawn(["bun", CLI, "serve", "--nope"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;

    expect(exitCode).not.toBe(0);
  });

  // A handler's runtime failure (a rejected promise or a throw inside
  // `Effect.promise`/`Effect.sync`) is a defect, not a `CliError`, so
  // `Command.run` renders nothing for it — the binary must print it itself.
  describe("runtime errors are printed, not swallowed", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "factory-cli-argv-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    test("an unopenable --db prints the sqlite error and exits 1", async () => {
      const proc = Bun.spawn(["bun", CLI, "runs", "--db", join(dir, "missing", "x.db")], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stderr = await readAll(proc.stderr);

      expect(exitCode).toBe(1);
      expect(stderr).toContain("unable to open database file");
    });

    test("a --config that fails to load prints the error and exits 1", async () => {
      const configPath = join(dir, "factory.config.ts");
      writeFileSync(configPath, 'throw new Error("boom from config");\n');
      const proc = Bun.spawn(
        ["bun", CLI, "serve", "--config", configPath, "--db", join(dir, "f.db"), "--port", "0"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await proc.exited;
      const stderr = await readAll(proc.stderr);

      expect(exitCode).toBe(1);
      expect(stderr).toContain("boom from config");
    });
  });
});

/**
 * PR #56 merged this branch onto `33-parse-cli-with-effect-cli` with a bad
 * conflict resolution: `src/cli.ts`'s `import.meta.main` block regressed to
 * the pre-#52 hand-rolled `USAGE`/`parseFlags`/`usageError` parser while
 * `factoryCommand` above kept passing — the tests here only ever drove
 * `factoryCommand` directly, never the actual binary entrypoint, so CI stayed
 * green while the shipped CLI silently lost `effect/unstable/cli` (generated
 * help, typed flag validation, `--wizard`/`--completions`, …). These tests
 * exercise `src/cli.ts` itself — via `import.meta.main`, the same path
 * `bin/factory.js` runs in production — so that regression can't recur
 * unnoticed.
 */
describe("cli.ts entrypoint wiring", () => {
  test("cli.ts contains no hand-rolled argv parser", async () => {
    const source = await Bun.file(CLI).text();
    expect(source).toContain('import { factoryCommand } from "./cli-commands"');
    expect(source).toMatch(/Command\.run\(factoryCommand/);
    expect(source).not.toMatch(/\bconst USAGE\b/);
    expect(source).not.toMatch(/\bfunction usageError\b/);
    expect(source).not.toMatch(/\bfunction parseFlags\b/);
    expect(source).not.toMatch(/\bfunction parseArgs\b/);
    expect(source).not.toMatch(/\bfunction parseStartArgs\b/);
    expect(source).not.toMatch(/\bfunction parseServeArgs\b/);
  });

  test("--help at the real entrypoint is generated by effect/unstable/cli, not a hand-rolled banner", async () => {
    const proc = Bun.spawn(["bun", CLI, "--help"], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(exitCode).toBe(0);
    // effect/unstable/cli's generated help renders these section headings;
    // the hand-rolled USAGE banner (a lowercase "usage:" line) never did.
    expect(stdout).toContain("SUBCOMMANDS");
    expect(stdout).toContain("GLOBAL FLAGS");
    expect(stdout).not.toContain("usage:\n");
  });

  test("factory serve --port at the real entrypoint rejects a non-numeric value before starting the daemon", async () => {
    // The hand-rolled parser did `Number(portRaw)` with no validation at all —
    // a bad --port silently became NaN. effect/unstable/cli's typed Int flag
    // rejects it up front.
    const proc = Bun.spawn(["bun", CLI, "serve", "--port", "abc"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stdout + stderr).toContain("Invalid value for flag --port");
  });
});
