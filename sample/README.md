# sample — a minimal live project for `factory`

A walked-through example of the three things an operator supplies: a
project config (`factory.config.ts`), one minimal workflow
(`workflows/implement-issue.ts`), and nothing else — the runtime, server
and UI are the factory repo's.

The config targets <https://github.com/FreshlyBrewedCode/factory-spike>
(private). Clone this directory, swap the `repo` block for your own
target repo, and it is yours.

## The workflow

`implement-issue` is the smallest honest round trip on the factory
authoring surface (D1: plain async control flow over `ctx`):

1. `ctx.agent("implement", ...)` — the agent reads the issue with
   `gh issue view` and implements it with tests (all steps run on
   `opencode-go/glm-5.3-flash`, set as the workflow's `agent.model`).
2. `ctx.exec(["bun", "test"])` — non-zero exit is a branch, not a throw.
3. one conditional fix step if the tests failed; the tests run again.
4. `ctx.agent("pr-metadata", ...)` — structured output supplies
   branch, PR title and body (D32).
5. `ctx.writeBack(...)` — deterministic host git + gh (D9); a branch
   collision is retried once with the runId suffix by the runtime.

`issueNumber` (the run input) is the only thing the caller supplies;
`repoSlug`/`baseBranch` come from the config through the run
environment (D27/D32), the working tree is allocated per run from the
local mirror (D28), and up to 2 runs are admitted at once (D29).

## Run it

From the factory repo root:

```bash
# serve the sample project (workspaces + event db live under .factory/, gitignored)
bun src/cli.ts serve --config sample/factory.config.ts --db sample/.factory/factory.db --port 3030
# in a second terminal: start a run by registry id and watch it stream
bun src/cli.ts start implement-issue --input '{"issueNumber": 2}' --watch
```

The UI is on `http://localhost:3030` — the runs list and the run's
transcript stream live from the same event log. `GET /api/workflows`
serves the registry, `GET /api/runs` the history.

## Verify (what the daemon's state actually is)

```bash
curl http://localhost:3030/api/workflows
bun src/cli.ts runs --db sample/.factory/factory.db
gh pr list -R FreshlyBrewedCode/factory-spike
```
