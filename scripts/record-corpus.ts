/**
 * Record a replay corpus (`test/corpus/*.ndjson`) from a live agent, through
 * the production ACP adapter and the real runtime (ADR 0013 "the replay
 * corpus must be re-recorded").
 *
 *   bun scripts/record-corpus.ts <claude|opencode> <model> <out.ndjson>
 *
 * Runs `e2e/implement-issue.ts` (implement → fix → structured pr-metadata →
 * write-back) for issue #1, "add slugify", against a throwaway clone of a
 * local bare origin. A fake `gh` on `PATH` answers `gh issue view` with the
 * issue and `gh pr create` with a URL, so nothing touches GitHub. Each line
 * is `{step, chunk, signal?}` (`recordingAdapter`); the run's own events are
 * printed as a one-line summary per step.
 *
 * The corpora in `test/corpus/acp-*.ndjson` were recorded with
 * `claude haiku` and `opencode opencode/big-pickle`.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import implementIssue from "../e2e/implement-issue";
import { hostExec } from "../src/lib/exec";
import { recordingAdapter, type CorpusLine } from "../src/replay/adapter";
import { ACP_AGENT_KINDS, type AcpAgentKind } from "../src/runtime/acp-agents";
import { acpAgentsAdapter, makeAgentRuntime } from "../src/runtime/agent-runtime";
import { startRun } from "../src/runtime/run";

const [agentArg, model, outArg] = process.argv.slice(2);
const agent = agentArg as AcpAgentKind;
if (!ACP_AGENT_KINDS.includes(agent) || model === undefined || outArg === undefined) {
  console.error("usage: bun scripts/record-corpus.ts <claude|opencode> <model> <out.ndjson>");
  process.exit(2);
}
const out = resolve(outArg);

const INDEX = `/** Returns a friendly greeting for the given name. */
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`;

const INDEX_TEST = `import { expect, test } from "bun:test";
import { greet } from "./index";

test("greet returns a greeting with the given name", () => {
  expect(greet("World")).toBe("Hello, World!");
});
`;

const ISSUE = `title:\tAdd slugify(input: string): string
state:\tOPEN
number:\t1
--
Add an exported \`slugify(input: string): string\` to \`src/index.ts\` that turns a
string into a URL-friendly slug: lowercase, trimmed, every run of characters other
than a-z and 0-9 becomes one hyphen, and no leading or trailing hyphens.
\`slugify("Hello, World!")\` is \`"hello-world"\`. Cover it in \`src/index.test.ts\`.
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "issue view") cat <<'ISSUE'
${ISSUE}ISSUE
  ;;
  "pr create") echo "https://github.com/local/fixture/pull/1" ;;
  *) echo "fake gh: $*" >&2 ;;
esac
`;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await hostExec(["git", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

const root = mkdtempSync(join(tmpdir(), `factory-corpus-${agent}-`));
try {
  const seed = join(root, "seed");
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const bin = join(root, "bin");
  mkdirSync(join(seed, "src"), { recursive: true });
  writeFileSync(join(seed, "src/index.ts"), INDEX);
  writeFileSync(join(seed, "src/index.test.ts"), INDEX_TEST);
  await git(root, "init", "-q", "-b", "main", seed);
  await git(seed, "add", "-A");
  await git(seed, "-c", "user.name=seed", "-c", "user.email=seed@local", "commit", "-qm", "seed");
  await git(root, "clone", "-q", "--bare", seed, origin);
  await git(root, "clone", "-q", origin, work);
  await git(work, "config", "user.name", "Factory Corpus");
  await git(work, "config", "user.email", "corpus@factory.local");

  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  // The agent's shell inherits this through `agentEnv`.
  process.env.PATH = `${bin}:${process.env.PATH}`;

  const lines: string[] = [];
  let step = "unknown";
  const adapter = recordingAdapter(
    acpAgentsAdapter(),
    () => step,
    (line: CorpusLine) => lines.push(JSON.stringify(line)),
  );
  const runtime = makeAgentRuntime({ adapter, default: agent, models: { [agent]: model } });
  const outcome = await startRun(implementIssue, runtime, {
    runId: `corpus-${agent}-${Date.now()}`,
    dir: work,
    input: { issueNumber: 1 },
    repo: { slug: "local/fixture", baseBranch: "main" },
    onEvent: (event) => {
      const p = event.payload;
      if (p._tag === "AgentStepStarted") step = p.name;
      if (p._tag === "AgentStepFinished")
        console.log(
          `${p.name}: ${p.outcome}, ${p.chunkCount} chunks, ${p.durationMs} ms` +
            (p.error !== undefined ? `, error: ${p.error}` : ""),
        );
      if (p._tag === "ExecFinished") console.log(`  exec exit ${p.exitCode}`);
    },
  }).result;
  await runtime.dispose();

  console.log(JSON.stringify(outcome));
  if (outcome.outcome !== "completed") process.exit(1);
  writeFileSync(out, `${lines.join("\n")}\n`);
  console.log(`wrote ${lines.length} lines to ${out}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
