---
title: Markdown kitchen sink
description: Every element this site styles, on one page — useful when changing the theme.
order: 2
---

This page exists to be looked at. If a token or a prose rule changes, check it here first in both
colour schemes before shipping.

## Text

Body copy runs at a comfortable measure. It supports **bold**, _italic_, **_both at once_**,
~~strikethrough~~, `inline code`, [links](/docs/introduction), and
[external links](https://github.com/FreshlyBrewedCode/factory). Footnotes work too.[^1]

[^1]: Footnotes render at the bottom of the article with a backlink.

Line breaks inside a paragraph are collapsed, so this sentence
continues on the same line. A blank line starts a new paragraph.

### Third-level heading

Headings go down to `h3` in the table of contents; `h4` and below still render but stay out of the
right-hand rail.

#### Fourth-level heading

Small print lives down here.

## Lists

Unordered, with nesting:

- A run is admitted, then dispatched.
- Each step appends to the event log.
  - Raw agent chunks ride inside events opaquely.
  - The UI never parses them; it renders them.
- Write-back is the only step that touches the source repo.

Ordered:

1. Write a workflow as `async (ctx, input) => {...}`.
2. Register it in `factory.config.ts`.
3. Dispatch it from the UI or the API.

Task list:

- [x] Event log as the shared spine
- [x] sqlite persistence
- [ ] Docs site

Definition-style, via nested lists:

- `ctx.agent`
  - Runs a coding agent in the run's sandbox and returns its structured output.
- `ctx.exec`
  - Runs a shell command in the workspace. Non-zero exit fails the run.

## Quotes

> We build in iterations: spike → prototype → validate → harden. The stack still applies while
> prototyping, unless there is a good reason it should not.
>
> — `AGENTS.md`

## Code

A plain fenced block:

```json
{
  "maxConcurrentRuns": 3,
  "workspaceRoot": ".factory/workspaces"
}
```

With a filename frame:

```ts title="workflows/review.ts"
import { defineWorkflow } from "@frebreco/factory";
import { Schema } from "effect";

const Input = Schema.Struct({ pr: Schema.Number });

export default defineWorkflow({ input: Input }, async (ctx, input) => {
  const review = await ctx.agent({ prompt: `Review PR #${input.pr}` });
  return ctx.output({ verdict: review.verdict });
});
```

With highlighted lines and line numbers:

```ts title="src/runtime/dispatch.ts" showLineNumbers {4-6}
export const dispatch = Effect.gen(function* () {
  const ready = yield* admitted;

  for (const run of ready) {
    yield* fork(execute(run));
  }
});
```

As a diff:

```diff lang="ts"
 const run = await start(workflow, input);
-await run.waitForExit();
+const exit = await run.waitForExit();
+if (exit.failed) yield* logFailure(exit);
```

With inline insert and delete markers:

```ts ins={3} del={2}
const events = await store.all(runId);
const usage = events.map((e) => e.tokens);
const usage = events.flatMap((e) => (e.type === "step" ? [e.usage] : []));
```

A terminal session, unframed:

```bash frame="none"
bun run check
bun run test:e2e
```

Long lines wrap rather than scroll off:

```bash
bun src/cli.ts serve --port 3005 --workspace-root /tmp/factory-workspaces --log-level debug --no-open
```

## Table

| Column     | What it owns                                | Entry point       |
| ---------- | ------------------------------------------- | ----------------- |
| Workflows  | Imperative TypeScript over the run context  | `workflows/*.ts`  |
| Server     | Admission, lifecycle, persistence, dispatch | `factory serve`   |
| Web UI     | Monitoring, observability, manual dispatch  | `/` on that port  |

## Media

![A run detail view, light scheme](https://placehold.co/1200x600/f4f4f4/212121/png?text=screenshot)

## Rules and raw HTML

A horizontal rule separates sections:

---

Raw HTML passes through, so disclosures work:

<details>
<summary>Why no step graph?</summary>

ADR 0002 records the decision: a graph DSL buys scheduling we do not need and costs authoring
clarity we do. Plain control flow reads better and debugs like ordinary TypeScript.

</details>
