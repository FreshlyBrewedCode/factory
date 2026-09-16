#!/usr/bin/env bun
/**
 * The published launcher for `factory`. The shebang asks for `bun` — and both
 * `bunx` and `npx` honor a bin's shebang — so this runs under Bun and then
 * spawns the real raw-TypeScript entrypoint with the same argv, stdio, exit
 * code and terminating signal.
 *
 * It is deliberately dependency-free: it runs before this package's own
 * dependencies are guaranteed to be installed. Its only other job is the guard
 * below. Node cannot execute raw TypeScript, so rather than let it fail with a
 * syntax error, the launcher says what is actually wrong.
 *
 * Do not give this file a `#!/usr/bin/env node` shebang: `bunx` honors the
 * shebang too, so that would route every `bunx @frebreco/factory` invocation
 * through Node and this package could never run.
 *
 * The launcher also pins Bun's config file to *this package's* `bunfig.toml`.
 * `factory serve` hands `src/web/index.html` to Bun's fullstack bundler, and
 * the only way to register `bun-plugin-tailwind` with that bundler is
 * `[serve.static] plugins` in a bunfig — which Bun reads from `$cwd`, not from
 * the code being run. Since `factory serve` runs in the *user's* project
 * directory, the repo-root bunfig is never found there and the UI ships with
 * no Tailwind output at all: no theme variables, no utilities, an unstyled
 * page. `--config` is the documented override, so the bundling behaviour now
 * travels with the package instead of with the working directory.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (typeof Bun === "undefined") {
  console.error(
    [
      "",
      "  factory requires Bun.",
      "",
      "  This package ships raw TypeScript and runs on the Bun runtime.",
      "  Install Bun:  https://bun.sh/docs/installation",
      "  Then run:     bunx @frebreco/factory",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const entry = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const bunfig = fileURLToPath(new URL("../bunfig.toml", import.meta.url));

const child = spawn(process.execPath, [`--config=${bunfig}`, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`factory: failed to start Bun: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
