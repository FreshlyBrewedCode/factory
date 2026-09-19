import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Option, Path, Stdio, Terminal } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";
import { factoryCommand } from "./cli-commands";

const CliTestLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
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

function runFactory(argv: ReadonlyArray<string>) {
  let captured: unknown;
  const testCmd = Command.make("factory").pipe(
    Command.withSubcommands([
      Command.make(
        "init",
        {
          dir: Flag.String("dir").pipe(Flag.withDefault(".")),
          force: Flag.Boolean("force").pipe(Flag.withDefault(false)),
        },
        (config) =>
          Effect.sync(() => {
            captured = config;
          }),
      ),
      Command.make(
        "serve",
        {
          port: Flag.Int("port").pipe(Flag.optional),
          db: Flag.String("db").pipe(Flag.withDefault(".factory/factory.db")),
          config: Flag.String("config").pipe(Flag.optional),
        },
        (config) =>
          Effect.sync(() => {
            captured = config;
          }),
      ),
      Command.make(
        "start",
        {
          workflowId: Argument.String("workflowId"),
          input: Flag.String("input"),
          url: Flag.String("url").pipe(Flag.optional),
          watch: Flag.Boolean("watch").pipe(Flag.withDefault(false)),
        },
        (config) =>
          Effect.sync(() => {
            captured = config;
          }),
      ),
      Command.make(
        "runs",
        {
          db: Flag.String("db").pipe(Flag.withDefault(".factory/factory.db")),
        },
        (config) =>
          Effect.sync(() => {
            captured = config;
          }),
      ),
      Command.make(
        "log",
        {
          runId: Argument.String("runId"),
          db: Flag.String("db").pipe(Flag.withDefault(".factory/factory.db")),
        },
        (config) =>
          Effect.sync(() => {
            captured = config;
          }),
      ),
      Command.make(
        "run",
        {
          workflowPath: Argument.String("workflowPath"),
          input: Flag.String("input"),
          dir: Flag.String("dir"),
          clone: Flag.String("clone").pipe(Flag.optional),
          "git-name": Flag.String("git-name").pipe(Flag.optional),
          "git-email": Flag.String("git-email").pipe(Flag.optional),
          out: Flag.String("out").pipe(Flag.optional),
          db: Flag.String("db").pipe(Flag.withDefault(".factory/factory.db")),
        },
        (config) =>
          Effect.sync(() => {
            captured = config;
          }),
      ),
    ]),
  );

  return Effect.gen(function* () {
    yield* Command.runWith(testCmd, { version: "0.0.0", renderErrors: false })(argv);
    return captured;
  }).pipe(Effect.provide(CliTestLayer));
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
  test("the root command has the expected subcommands", () => {
    const names = factoryCommand.subcommands.flatMap((g) => g.commands.map((c) => c.name));
    expect(names).toContain("init");
    expect(names).toContain("serve");
    expect(names).toContain("start");
    expect(names).toContain("runs");
    expect(names).toContain("log");
    expect(names).toContain("run");
  });
});
