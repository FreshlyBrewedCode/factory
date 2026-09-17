# Raw-TypeScript npm packaging: the launcher shim spike

**Subtask:** validate how to publish a Bun-only CLI (`@frebreco/factory`) to npm
when it ships raw TypeScript instead of compiled binaries. Specifically: can a
dependency-free JavaScript launcher make `bunx` run the TypeScript while
`npx`/`node` fail with a useful message, and how should it hand off to the
entrypoint? Run 2026-09-14, before the pipeline was built.

**Headline finding:** `bunx` and `npx` both honor a bin's shebang. The original
design — a `#!/usr/bin/env node` launcher that detects Node and errors — cannot
work: `bunx @frebreco/factory` would also run Node, so the Bun branch is
unreachable whenever Node is installed. The shebang must be
`#!/usr/bin/env bun`.

## Environment

`bun` 1.4.2, `node` v24.19.0, `npm` 11.17.0 on Linux. `bunx` resolved to a
separate Nix symlink (1.3.13) but behaved identically to the 1.4.2 binary. All
work in a throwaway package (`package.json` + `bin/*.js` + `src/*.ts`), packed
with `npm pack`/`bun pm pack` and installed into fresh consumer projects.

## Runtime detection

| Probe | under `bun` | under `node` |
| --- | --- | --- |
| `typeof Bun` | `"object"` | `"undefined"` |
| `process.versions.bun` | `"1.4.2"` | `undefined` |
| `process.versions.node` | `"26.3.0"` (Bun emulates it) | `"24.19.0"` |
| `navigator.userAgent` | `"Bun/1.4.2"` | `"Node.js/24"` |

`process.versions.node` is not safe for detection — Bun reports one too.
`typeof Bun !== "undefined"` (or `process.versions.bun`) is reliable.

## Shebang matrix

This is the finding that changed the design. All cells are the observed
interpreter/exit code. "node present" is the normal case.

| Shebang | `bunx factory` | `npx factory` | `bun x --bun` | `./bin` | `node bin` | Bun absent |
| --- | --- | --- | --- | --- | --- | --- |
| `env node` | **Node, 1** ❌ | Node, 1 | Bun, 0 | Node, 1 | error, 1 | friendly error, 1 |
| `env bun` | **Bun, 0** ✅ | **Bun, 0** ✅ | Bun, 0 | Bun, 0 | error, 1 | `env: 'bun': No such file or directory`, 127 |
| `/bin/sh` polyglot | Bun, 0 ✅ | Bun, 0 ✅ | Bun, 0 | Bun, 0 | error, 1 | friendly error, 1 |

Reproduced both from a local `node_modules/.bin` symlink and from Bun's global
package cache. The `env node` row only "works" under `bunx` when Node is absent
— a non-deterministic outcome, which is the whole reason it was rejected.

The `/bin/sh` polyglot gives the best UX (friendly missing-Bun message, all run
paths green) but npm's Windows `cmd-shim` maps its shebang to `sh.exe`, which
usually does not exist, so it breaks Windows. `env bun` maps to `bun.exe` and
is the choice.

## Loading the TypeScript from the launcher

Two candidates, both requiring `"type": "module"` in the published manifest
(without it, an older Node hits a syntax error before the guard can print):

| Property | A: `await import("../src/cli.ts")` | B: async `spawn(process.execPath, [entry, ...argv])` |
| --- | --- | --- |
| Bun resolves `.ts` from `.js` ESM | ✅ | ✅ |
| `import.meta.main` inside `cli.ts` | ❌ `false` | ✅ `true` |
| `process.argv[1]` | launcher path | real `cli.ts` path |
| argv passthrough | ✅ | ✅ |
| exit code | direct | propagated |
| direct `SIGTERM` to launcher | ✅ (single process) | ✅ after forwarding (see below) |
| signal forwarding | n/a | explicit `SIGINT`/`SIGTERM`/`SIGHUP`, re-raised on self |

**Option B chosen.** Factory's `cli.ts` gates on `import.meta.main`, so A would
require restructuring the entrypoint. A caveat found while testing: the
wayful-style `spawnSync` launcher **orphans the child** when the launcher
receives a direct `SIGTERM` (child reparented to PID 1). The async-spawn
version with explicit signal forwarding and a re-raise after removing the
listener does not (verified 143/130, no orphans).

## Packaging observations

- `bin` scripts are always included by npm even when not listed in `files`;
  `files: ["src"]` was sufficient for a source-only package.
- `engines.bun` is informational — npm and Bun accept it but do not enforce it.
- Both installers create `node_modules/.bin/factory` as a POSIX symlink to the
  bin file, so execution goes through the shebang, exactly as the matrix assumes.
- `npm pack`/`bun pm pack` preserve the `0755` mode on the bin.

## What this means for the pipeline

`bin/factory.js` uses `#!/usr/bin/env bun`, the `typeof Bun` guard, and Option
B's async spawn. `scripts/build-release.ts` stamps `"type": "module"`,
`engines: { bun: ">=1.4.1" }` and the launcher's shebang into the staged
manifest. See [`adr/0006-raw-typescript-distribution.md`](../adr/0006-raw-typescript-distribution.md)
for the decision and its consequences.
