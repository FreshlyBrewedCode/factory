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

import { chmod, cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
 * Stage-time checks that would otherwise only surface for a user: the Node
 * path must refuse with the actionable message, the staged TypeScript must
 * actually run under Bun, and — since the package is now a library as well as
 * a CLI — `import ... from "@frebreco/factory"` must resolve against the
 * staged `exports` from a directory that only has it in `node_modules`.
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
    await mkdir(join(work, "node_modules", "@frebreco"), { recursive: true });
    await symlink(PKG, join(work, "node_modules", "@frebreco", "factory"), "dir");

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
  files: ["bin", "src", "README.md", "LICENSE"],
  dependencies: rootManifest.dependencies ?? {},
};

await Bun.write(join(PKG, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (SMOKE_TEST) await smokeTest();

console.log(`factory: staged @frebreco/factory@${VERSION} in ${PKG}`);
