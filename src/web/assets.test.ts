/**
 * The UI's stylesheet has to survive leaving this repository.
 *
 * `factory serve` hands `src/web/index.html` to Bun's fullstack bundler, and
 * `src/web/styles.css` starts with `@import "tailwindcss"`. Turning that import
 * into real CSS is `bun-plugin-tailwind`'s job, and the plugin can only be
 * registered through `[serve.static] plugins` in a bunfig — which Bun reads
 * from the *current working directory*. `factory serve` runs in the user's
 * project, not here, so without `bin/factory.js` pinning `--config` the plugin
 * never loads: Bun's own CSS bundler inlines `node_modules/tailwindcss/*.css`
 * verbatim, `@theme`/`@tailwind` pass through as dead text, and the SPA renders
 * with no theme variables and not one utility class.
 *
 * That failure is silent — the server starts, the API answers, the HTML and the
 * CSS chunk are both served with a 200 — so nothing else in the suite sees it.
 * It is also a live regression: while the layout still had hand-written CSS
 * rules alongside the utilities, an unprocessed stylesheet merely looked wrong;
 * once those rules became utilities the page stopped rendering as a page at all.
 *
 * So this test boots the daemon the way a user does — through the launcher,
 * from a directory that is not this repo — and asserts the served CSS is
 * Tailwind's *output* rather than its source.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";

const LAUNCHER = join(import.meta.dir, "../../bin/factory.js");

let workDir: string;
let child: Bun.Subprocess;
let base: string;

/**
 * `--port 0` lets the OS pick, so the suite never collides with a port someone
 * else is on; the daemon reports what it got on stdout, which is the only way
 * back to it from here.
 */
async function readServedPort(stdout: ReadableStream<Uint8Array>): Promise<number> {
  let seen = "";
  for await (const bytes of stdout) {
    seen += new TextDecoder().decode(bytes);
    const port = /listening on http:\/\/localhost:(\d+)/.exec(seen)?.[1];
    if (port !== undefined) return Number(port);
  }
  throw new Error(`the daemon exited before it reported a port. stdout:\n${seen}`);
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "factory-web-assets-"));

  // `cwd: workDir` is the whole point: a bunfig lookup from here finds nothing.
  child = Bun.spawn({
    cmd: [process.execPath, LAUNCHER, "serve", "--port", "0", "--db", join(workDir, "factory.db")],
    cwd: workDir,
    stdout: "pipe",
    stderr: "inherit",
  });

  base = `http://localhost:${await readServedPort(child.stdout as ReadableStream<Uint8Array>)}`;
}, 40_000);

afterAll(() => {
  child?.kill();
  rmSync(workDir, { force: true, recursive: true });
});

test("the SPA's stylesheet is Tailwind's compiled output, not its unprocessed source", async () => {
  const html = await (await fetch(base)).text();
  const href = /<link[^>]+href="([^"]+\.css)"/.exec(html)?.[1];
  expect(href).toBeDefined();

  const css = await (await fetch(`${base}${href}`)).text();

  // `@theme` and `@tailwind` are directives the plugin consumes. If either
  // reaches the browser, the stylesheet was inlined instead of compiled.
  expect(css).not.toInclude("@theme");
  expect(css).not.toInclude("@tailwind");

  // And the compiled sheet must actually carry the design tokens and the
  // utilities the pages are built from — a stylesheet can be free of
  // directives and still be empty.
  expect(css).toInclude("--color-status-complete");
  expect(css).toInclude("animate-status-pulse");
}, 20_000);
