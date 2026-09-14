# factory

> **Early, `0.x`, and pinned to release candidates.** Factory is a greenfield
> proof of concept. It depends on `effect@4.0.0-rc.*` and `@tanstack/ai@0.x`,
> so expect breaking changes without a major version bump — that is exactly
> what staying `0.x` is for.

Factory lets you write agent orchestration as plain, imperative TypeScript over
a sandbox handle — `await`, loops, `try`/`catch`, early returns — instead of a
declarative graph. A runtime bridges those workflows onto
[`@tanstack/ai`](https://tanstack.com/ai)'s coding-agent harnesses and
sandboxes, persists every run event, and a small server can automatically
dispatch ready issues and expose live run monitoring.

- **Workflows are plain async TypeScript.** No DSL, no builder. You `await` an
  agent step and get a typed result back.
- **Every run event is persisted** to sqlite as it is emitted, so an
  interrupted run's history stays intact and queryable.
- **A daemon dispatches for you.** `factory serve --dispatch-*` reconciles a
  GitHub Project for ready items, runs them under a WIP limit, and streams
  progress over SSE.
- **The UI is just another client** of the same HTTP/SSE API.

## Requirements

**Bun ≥ 1.4.1 is required.** Factory ships raw TypeScript and runs on Bun's
runtime; it is not compiled to a Node-compatible bundle. The published `bin` is
a tiny launcher that refuses to run under Node with an actionable error rather
than failing with a syntax error.

## Install

```sh
bunx @frebreco/factory runs
```

`npx @frebreco/factory …` also works — but only because the launcher's shebang
asks for `bun`, which both `bunx` and `npx` honor. If Bun is not installed,
there is no runtime that can execute this package, and the launcher says so.

## Usage

```sh
factory run <workflow.ts> --input '{"...": 1}' --dir <path>
factory runs [--db .factory/factory.db]
factory log <runId> [--db .factory/factory.db]
factory serve [--port <n>] [--db <path>]
factory serve --dispatch-workflow <path> --dispatch-owner <login> ...   # auto-dispatch
```

`run` optionally clones a fresh working tree (`--clone <sshUrl>` with
`--git-name`/`--git-email`) and writes back a branch/commit/PR through the
workflow's own `ctx`. See `workflows/implement-issue.ts` for a real example.

## Layout

| Path | Contents |
| --- | --- |
| `src/` | The runtime, persistence, HTTP/SSE server, dispatch loop, and CLI |
| `workflows/` | The real `implement-issue` workflow plus its corpus-replay test |
| `test/corpus/` | Recorded run corpora the replay adapter reads |
| `prototypes/` | Throwaway UI mockups — not part of the build or the stack |
| `docs/` | ADRs, findings, research notes, and the design reference |

## Development

The flake's dev shell pins Bun (≥ 1.4.1) and puts Playwright's browser libraries
on `LD_LIBRARY_PATH`:

```sh
nix develop
bun install

bun run check     # format:check + lint + typecheck + test
bun run build     # stage the release package under dist/npm/factory
```

## Releasing

Releases are driven by [semantic-release](https://semantic-release.gitbook.io/)
on Conventional Commits:

- **Every push to `main`** cuts a pre-release (`X.Y.Z-next.N`) on npm's `next`
  dist-tag and a GitHub pre-release.
- **A manual `release` workflow dispatch** cuts a stable `X.Y.Z` on npm's
  `latest` dist-tag.

Publishing uses npm **trusted publishing (OIDC)** — there is no stored
`NPM_TOKEN`. The one-time GitHub/npm setup is scripted and idempotent:

```sh
scripts/bootstrap-release.sh
```

Squash-merge is the only allowed merge strategy, so the PR title *is* the commit
message semantic-release parses; `pr-title.yml` enforces Conventional Commits
there. Note that `.github/workflows/release.yml` can never be renamed — npm pins
the trusted publisher to that exact filename.

## License

MIT — see [`LICENSE`](LICENSE).
