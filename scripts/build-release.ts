#!/usr/bin/env bun
// Stages the single npm package semantic-release publishes from, under
// `dist/npm/factory/`. The repo-root `package.json` stays `"private": true`
// permanently — only what this script generates ever reaches the registry, so
// publishing the workspace by accident is structurally impossible.
//
// Unlike wayful there is no per-platform compile step. Factory ships raw
// TypeScript and requires Bun at runtime; `bin/factory.js` is the guard and
// launcher, and the whole `src/` tree is copied in place so Bun resolves it
// exactly as it does in development.
//
// Usage: bun scripts/build-release.ts [version]
// `version` defaults to "0.0.0-dev", which is what CI's verification step
// passes — proving the package stages without needing a real version. The
// release workflow passes the version semantic-release computed, which is
// stamped into the generated manifest.

import { chmod, cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DIST = join(REPO_ROOT, "dist", "npm");
const PKG = join(DIST, "factory");

// Matches the GitHub remote character for character — npm rejects an OIDC
// publish with an opaque error when the manifest's `repository.url` disagrees
// with the trusted publisher's repository.
const REPOSITORY_URL = "git+https://github.com/FreshlyBrewedCode/factory.git";
const DESCRIPTION =
  "Imperative TypeScript workflows over coding-agent sandboxes, with a dispatch daemon and a monitoring UI.";

const VERSION = process.argv[2] ?? "0.0.0-dev";
const SMOKE_TEST = process.argv.includes("--smoke-test");

function fail(message: string): never {
  console.error(`factory: ${message}`);
  process.exit(1);
}

function run(cmd: string[], cwd: string = REPO_ROOT): void {
  const result = Bun.spawnSync({ cmd, cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) fail(`\`${cmd.join(" ")}\` failed.`);
}

/**
 * Installs the staged package into `work` the way a registry install lays it
 * out: factory itself as a *real directory* under `node_modules`, its
 * dependencies beside it.
 *
 * The real directory is the point. Symlinking the staged package back into
 * this repo makes every upward filesystem search — `tsconfig.json`,
 * `bunfig.toml`, `node_modules` — succeed by walking out of `dist/` and into
 * the repo, so a package missing those files still passes. That false positive
 * is what let a package whose UI could not build at all ship twice.
 */
async function install(work: string): Promise<void> {
  const modules = join(work, "node_modules");
  await mkdir(join(modules, "@frebreco"), { recursive: true });

  // Dependencies are linked (fast, offline); only factory is copied.
  for (const entry of await readdir(join(REPO_ROOT, "node_modules"))) {
    if (entry === "@frebreco") continue;
    await symlink(join(REPO_ROOT, "node_modules", entry), join(modules, entry), "dir");
  }
  await cp(PKG, join(modules, "@frebreco", "factory"), { recursive: true });
}

/**
 * Boots `factory serve` from the installed copy and asks it for the SPA.
 *
 * `serve` hands `src/web/index.html` to Bun's fullstack bundler, which resolves
 * the UI's `@/web/*` imports through `tsconfig.json` and compiles
 * `@import "tailwindcss"` through the `bun-plugin-tailwind` registered in
 * `bunfig.toml`. Neither file used to be staged, and neither failure says so:
 * without the tsconfig `GET /` answers `200` with an empty body, and without
 * the bunfig it answers with Tailwind's *source* — an unstyled page. So the
 * assertions here are on what actually reaches the browser.
 */
async function smokeTestUi(work: string): Promise<void> {
  const factory = join(work, "node_modules", "@frebreco", "factory");
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      join(factory, "bin", "factory.js"),
      "serve",
      "--port",
      "0",
      "--db",
      join(work, "ui-smoke.db"),
    ],
    cwd: work,
    stdout: "pipe",
    stderr: "inherit",
  });

  /** Returns what is wrong with the served UI, or `undefined` if it is fine. */
  async function inspect(): Promise<string | undefined> {
    let stdout = "";
    let port: string | undefined;
    for await (const bytes of child.stdout as ReadableStream<Uint8Array>) {
      stdout += new TextDecoder().decode(bytes);
      port = /listening on http:\/\/localhost:(\d+)/.exec(stdout)?.[1];
      if (port !== undefined) break;
    }
    if (port === undefined) return `\`factory serve\` never reported a port.\n${stdout}`;

    const base = `http://localhost:${port}`;
    const html = await (await fetch(base)).text();

    const script = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1];
    const stylesheet = /<link[^>]+href="([^"]+\.css)"/.exec(html)?.[1];
    if (script === undefined || stylesheet === undefined) {
      return `the installed package served no SPA bundle. \`GET /\` returned:\n${html}`;
    }

    const js = await (await fetch(`${base}${script}`)).text();
    if (!js.includes("factory")) return "the served SPA bundle looks empty.";

    const css = await (await fetch(`${base}${stylesheet}`)).text();
    // Directives the Tailwind plugin consumes. Either one reaching the browser
    // means the stylesheet was inlined rather than compiled.
    if (css.includes("@theme") || css.includes("@tailwind")) {
      return "the served stylesheet is Tailwind's source, not its output — the plugin did not run.";
    }
    if (!css.includes("animate-status-pulse")) {
      return "the served stylesheet carries no utilities from the UI's own sources.";
    }
    return undefined;
  }

  // `fail` exits the process, so calling it while the daemon is up would skip
  // the kill below and leave a server holding this script's stdout open — the
  // pipe never closes and whatever is reading it hangs instead of reporting.
  // The verdict is therefore carried out of the try and acted on afterwards.
  let problem: string | undefined;
  try {
    problem = await inspect();
  } finally {
    // `bin/factory.js` forwards the signal to the daemon it spawned.
    child.kill();
    await child.exited;
  }
  if (problem !== undefined) fail(problem);
}

/**
 * Stage-time checks that would otherwise only surface for a user: the Node
 * path must refuse with the actionable message, the staged TypeScript must
 * actually run under Bun, `import ... from "@frebreco/factory"` must resolve
 * against the staged `exports` from a directory that only has it in
 * `node_modules`, and `factory serve` must serve a UI that built.
 */
async function smokeTest(): Promise<void> {
  const node = Bun.spawnSync(["node", join(PKG, "bin", "factory.js")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (node.exitCode === 0 || !node.stderr.toString().includes("requires Bun")) {
    fail("the launcher did not reject Node with the 'requires Bun' message.");
  }

  const work = await mkdtemp(join(tmpdir(), "factory-smoke-"));
  try {
    run([process.execPath, join(PKG, "src", "cli.ts"), "runs", "--db", join(work, "factory.db")]);

    // Install the staged package the way a consumer would see it, then use it
    // the way the README tells them to.
    await install(work);

    run([process.execPath, join(PKG, "src", "cli.ts"), "init"], work);

    const configPath = join(work, ".factory", "factory.config.ts");
    if (!(await Bun.file(configPath).exists())) {
      fail("`factory init` did not write .factory/factory.config.ts.");
    }

    // Importing the generated config exercises the whole chain at once: the
    // package's `exports`, `defineConfig`, `defineWorkflow`, and the relative
    // import from the config to the workflow beside it.
    await Bun.write(
      join(work, "probe.ts"),
      [
        `import config from "./.factory/factory.config.ts";`,
        `if (config.workflows[0]?.id !== "hello") throw new Error("registry is empty");`,
        `console.log("factory: staged package imports cleanly.");`,
      ].join("\n"),
    );
    run([process.execPath, join(work, "probe.ts")], work);

    await smokeTestUi(work);
    console.log("factory: installed package serves a compiled UI.");
  } finally {
    await rm(work, { force: true, recursive: true });
  }

  console.log("factory: smoke test passed.");
}

const rootManifest = (await Bun.file(join(REPO_ROOT, "package.json")).json()) as {
  dependencies?: Record<string, string>;
};

console.log(`factory: staging release ${VERSION}`);

await rm(DIST, { force: true, recursive: true });
await mkdir(join(PKG, "bin"), { recursive: true });

await cp(join(REPO_ROOT, "bin", "factory.js"), join(PKG, "bin", "factory.js"));
await cp(join(REPO_ROOT, "src"), join(PKG, "src"), { recursive: true });
await cp(join(REPO_ROOT, "README.md"), join(PKG, "README.md"));
await cp(join(REPO_ROOT, "LICENSE"), join(PKG, "LICENSE"));
// `bunfig.toml` and `tsconfig.json` are part of the runtime, not of
// development: both are read by the fullstack bundler that builds the UI when
// `factory serve` runs. The bunfig registers `bun-plugin-tailwind` (and
// `bin/factory.js` points Bun at this copy with `--config`); the tsconfig
// carries the `@/*` -> `./src/*` paths the SPA imports through. Bun finds the
// tsconfig by walking up from the source file, so it has to sit at the package
// root — which also means the user's own `@/*` alias does not shadow ours.
// They are copied verbatim rather than trimmed so the published build cannot
// drift from the one the repo tests.
await cp(join(REPO_ROOT, "bunfig.toml"), join(PKG, "bunfig.toml"));
await cp(join(REPO_ROOT, "tsconfig.json"), join(PKG, "tsconfig.json"));
await chmod(join(PKG, "bin", "factory.js"), 0o755);

// `workflows/` is deliberately *not* staged. The repo's `implement-issue` is a
// development artifact — it imports `src/lib/tree-snapshot`, an internal the
// public barrel does not export — so shipping it would advertise an import
// path users must not depend on. `factory init` gives them a workflow instead.

// Tests are development-only; they import `test/fixtures` and `test/corpus`,
// which are not shipped, so carrying them would just be dead weight.
const testFiles = new Bun.Glob("**/*.test.ts");
for await (const file of testFiles.scan({ cwd: join(PKG, "src") })) {
  await rm(join(PKG, "src", file), { force: true });
}

const manifest = {
  name: "@frebreco/factory",
  version: VERSION,
  description: DESCRIPTION,
  license: "MIT",
  type: "module",
  bin: { factory: "bin/factory.js" },
  // The library half of the package: `import { defineWorkflow } from
  // "@frebreco/factory"`. Raw TypeScript, resolved by Bun — the same file the
  // repo's own tests import through this same specifier, so the published
  // surface cannot drift from the tested one.
  exports: {
    ".": "./src/index.ts",
    "./package.json": "./package.json",
  },
  engines: { bun: ">=1.4.1" },
  repository: { type: "git", url: REPOSITORY_URL },
  files: ["bin", "src", "bunfig.toml", "tsconfig.json", "README.md", "LICENSE"],
  dependencies: rootManifest.dependencies ?? {},
};

await Bun.write(join(PKG, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (SMOKE_TEST) await smokeTest();

console.log(`factory: staged @frebreco/factory@${VERSION} in ${PKG}`);
