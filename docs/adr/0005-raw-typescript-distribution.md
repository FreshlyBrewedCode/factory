# 0005. Distribution: raw TypeScript on Bun, behind a shebang-guarded launcher

## Status

Accepted, 2026-09-14. Validated by a packaging spike
(`docs/findings/8-raw-ts-npm-shim-spike.md`), which overturned the original
plan's assumption about shebangs before any of it was built.

## Context

Preparing the repo for a public GitHub release and an npm publish as
`@frebreco/factory`. The sibling project Wayful publishes five packages — one
pure-Node launcher plus four `os`/`cpu`-gated binaries cross-compiled on a
single runner — and the CI/CD here is copied from it. Factory is Bun-only at
the source level (`Bun.serve`, `Bun.file`, `bun:sqlite`, Effect's Bun
platform), so it cannot be bundled for Node. The question is whether to pay for
per-platform binaries, or require Bun at runtime.

The initial plan was a dependency-free JavaScript launcher with a
`#!/usr/bin/env node` shebang that detects Node and exits with an actionable
error, so `npx`/`node` fail loudly while `bunx`/`bun` run the raw TypeScript.
The spike tested that premise rather than assuming it.

## Decision

**Ship raw TypeScript in a single npm package, `@frebreco/factory`, requiring
Bun ≥ 1.4.1.** No compiled binaries, no `os`/`cpu`-gated optional dependencies,
one trusted publisher.

- `bin/factory.js` is the launcher: dependency-free, ESM, shebang
  `#!/usr/bin/env bun`. It guards with `typeof Bun === "undefined"` (printing
  the "factory requires Bun" message and exiting 1), then spawns
  `process.execPath` on `../src/cli.ts`, forwarding argv and stdio and
  propagating exit codes and terminating signals.
- `scripts/build-release.ts` stages the publishable package under
  `dist/npm/factory/` with a generated manifest (version, dependencies copied
  from the root, `files` allowlist). The repo-root manifest stays
  `"private": true` permanently, so the workspace can never be published by
  accident.
- `.releaserc.json` publishes from that one `pkgRoot`; CI verifies staging with
  a placeholder version.

**Sub-decision — the shebang must be `bun`, not `node`.** The original plan is
not realizable: `bunx` honors a bin's shebang, so a `node` shebang routes
*every* invocation — including `bunx @frebreco/factory` — through Node, and the
Bun branch is never reached. With `#!/usr/bin/env bun`, `bunx` and `npx` both
run Bun, and only an explicit `node bin/factory.js` reaches the friendly "Bun
required" guard ([evidence](./findings/8-raw-ts-npm-shim-spike.md)).

## Consequences

- **No compile matrix and a tiny publish surface.** CI stages the package
  instead of cross-compiling four binaries, and there is exactly one npm
  package and one trusted-publisher configuration to maintain.
- **Users must have Bun.** `npx` works, but only because the shebang asks for
  Bun; if Bun is absent, POSIX `env` fails with a terse "No such file or
  directory" rather than our message. This is accepted: the alternative
  (a POSIX `sh` polyglot shebang that prints the friendly message) breaks npm's
  Windows shims, which `env bun` supports.
- **Windows is untested**, same posture as wayful; the launcher's `env bun`
  shebang maps cleanly through npm's Windows `cmd-shim`, so it is at least
  intended to work there.
- **The published package carries the runtime dependency tree** (`effect` at a
  release candidate, `@tanstack/ai` at `0.x`). The README states this and the
  `0.x` version floor is the escape hatch.
- **Phase 4's SPA is still in flight.** The whole `src/` tree (including
  `src/web/`, whose `index.html` `src/server/http.ts` imports through Bun's
  fullstack bundler) is copied into the package, which is what the staging
  smoke test exercises. Phase 4's remaining steps must re-verify that the SPA
  bundles and serves correctly from an installed copy before the first real
  publish.
- **`.github/workflows/release.yml` is load-bearing and cannot be renamed** —
  npm pins the trusted publisher to the exact org/repo/workflow-filename triple.
