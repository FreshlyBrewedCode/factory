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

import { chmod, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
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
 * path must refuse with the actionable message, and the staged TypeScript must
 * actually run under Bun with the copied assets next to it.
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
await cp(join(REPO_ROOT, "workflows"), join(PKG, "workflows"), { recursive: true });
await cp(join(REPO_ROOT, "README.md"), join(PKG, "README.md"));
await cp(join(REPO_ROOT, "LICENSE"), join(PKG, "LICENSE"));
await chmod(join(PKG, "bin", "factory.js"), 0o755);

// Tests are development-only; they import `test/fixtures` and `test/corpus`,
// which are not shipped, so carrying them would just be dead weight.
const testFiles = new Bun.Glob("**/*.test.ts");
for (const dir of ["src", "workflows"]) {
  for await (const file of testFiles.scan({ cwd: join(PKG, dir) })) {
    await rm(join(PKG, dir, file), { force: true });
  }
}

const manifest = {
  name: "@frebreco/factory",
  version: VERSION,
  description: DESCRIPTION,
  license: "MIT",
  type: "module",
  bin: { factory: "bin/factory.js" },
  engines: { bun: ">=1.4.1" },
  repository: { type: "git", url: REPOSITORY_URL },
  files: ["bin", "src", "workflows", "README.md", "LICENSE"],
  dependencies: rootManifest.dependencies ?? {},
};

await Bun.write(join(PKG, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (SMOKE_TEST) await smokeTest();

console.log(`factory: staged @frebreco/factory@${VERSION} in ${PKG}`);
