/**
 * SPIKE (finding 13), kept as the live check of the production ACP adapter
 * (#63): run a hello-shaped workflow through factory's real runtime
 * (`startRun`, `AgentRuntime`, `agent-step.ts`) on opencode or Claude Code,
 * and measure model selection, usage, structured output, permission asks,
 * cancel, and what the agent can see of the host's settings.
 *
 *   bun spikes/13-acp-agents.ts run <claude|opencode> <model>
 *   bun spikes/13-acp-agents.ts cancel <claude|opencode> <model> [afterMs]
 *   bun spikes/13-acp-agents.ts bad-model <claude|opencode>
 *   bun spikes/13-acp-agents.ts isolation <claude|opencode> <model> [ignore|include]
 *
 * `isolation` asks the agent which skills and instructions it has and runs
 * `gh auth status`, git's global config and `env` through its shell, with the
 * host's agent settings ignored (default) or included.
 *
 * Writes `spikes/out/<mode>-<agent>-<ts>/{events,diagnostics}.ndjson`.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "../src/events";
import { acpAdapter, type AcpDiagnostic } from "../src/runtime/acp-adapter";
import {
  ACP_AGENT_KINDS,
  acpAgent,
  agentEnv,
  type AcpAgentKind,
  type HostSettings,
} from "../src/runtime/acp-agents";
import { makeAgentRuntime } from "../src/runtime/agent-runtime";
import { startRun } from "../src/runtime/run";
import { defineWorkflow, Schema } from "../src/workflow";

const [mode = "run", agentArg = "opencode", modelArg, afterArg] = process.argv.slice(2);
const agent = agentArg as AcpAgentKind;
if (!ACP_AGENT_KINDS.includes(agent)) throw new Error(`unknown agent ${agentArg}`);
const hostSettings: HostSettings = afterArg === "include" ? "include" : "ignore";
const model = mode === "bad-model" ? "no-such-model" : modelArg;
if (model === undefined) throw new Error("model required");

const sh = async (cwd: string, ...cmd: string[]) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
  return out;
};

/** A throwaway git repo with one small file to change. */
async function scratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `factory-acp-${agent}-`));
  await writeFile(
    join(dir, "math.ts"),
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  );
  await writeFile(join(dir, "README.md"), "# math\n\nTiny arithmetic helpers.\n");
  if (mode === "isolation") {
    // Project-level settings, which a run must keep seeing.
    await writeFile(join(dir, "CLAUDE.md"), "Project codeword: PROJ-CLAUDE-7731\n");
    await writeFile(join(dir, "AGENTS.md"), "Project codeword: PROJ-AGENTS-4410\n");
    for (const [root, name] of [
      [".claude", "project-claude-probe"],
      [".agents", "project-agents-probe"],
    ] as const) {
      await mkdir(join(dir, root, "skills", name), { recursive: true });
      await writeFile(
        join(dir, root, "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Probe skill; use when asked about probes.\n---\n\nProbe.\n`,
      );
    }
  }
  await sh(dir, "git", "init", "-q", "-b", "main");
  await sh(dir, "git", "add", ".");
  await sh(
    dir,
    "git",
    "-c",
    "user.name=spike",
    "-c",
    "user.email=spike@local",
    "commit",
    "-qm",
    "init",
  );
  return dir;
}

const Report = Schema.Struct({
  summary: Schema.String,
  changedFiles: Schema.Array(Schema.String),
});

const hello = defineWorkflow("acp-hello", {
  input: Schema.Struct({ long: Schema.Boolean }),
  output: Schema.Struct({
    changedFiles: Schema.Int,
    report: Schema.NullOr(Report),
    outputTier: Schema.String,
  }),
  agent: { model },
  run: async (ctx, input) => {
    await ctx.agent(
      "implement",
      input.long
        ? `Write a file primes.ts with a function that returns the first 2000 primes, then a file primes.test.ts with 50 separate bun tests for it, one per prime index, each written out by hand. Then run the tests with bun test. Then explain every prime below 500 in prose.`
        : `You are working in a git checkout of this project.

Task: add a function \`multiply(a, b)\` to math.ts next to \`add\`, in the same style.

Make the change. When you are done, stop — do not run git commands and do not commit.`,
    );
    const status = await ctx.exec(["git", "status", "--short"]);
    const changedFiles = status.stdout.split("\n").filter((l) => l.trim() !== "").length;

    const report = await ctx.agent(
      "report",
      `Summarise the change you can see in this repository (run \`git status\` and \`git diff\` to look). List the paths of the changed files.`,
      { output: Report },
    );
    const outputTier =
      report.output === undefined
        ? "none"
        : report.finalText.trim().startsWith("{")
          ? "1-or-2"
          : "1";
    return { changedFiles, report: report.output ?? null, outputTier };
  },
});

const Visible = Schema.Struct({
  skills: Schema.Array(Schema.String),
  codewords: Schema.Array(Schema.String),
  xdgConfigHome: Schema.String,
  ghAuth: Schema.String,
  gitUser: Schema.String,
  claudeVars: Schema.String,
  parentSentinels: Schema.String,
});

const isolation = defineWorkflow("acp-isolation", {
  input: Schema.Struct({ long: Schema.Boolean }),
  output: Visible,
  agent: { model },
  run: async (ctx) => {
    const seen = await ctx.agent(
      "visible",
      `Report what you can see. Do not guess and do not invent anything.

1. skills: the name of every skill available to you, exactly as your skill tool or skill listing names them (all of them).
2. codewords: every "codeword" value that appears in instructions you were given (CLAUDE.md, AGENTS.md or similar), verbatim. Do not search files for them; only what is already in your context.
3. Run these shell commands, each separately, and report their output trimmed:
   - xdgConfigHome: \`echo "XDG=$XDG_CONFIG_HOME"\`
   - ghAuth: \`gh auth status 2>&1 | head -2\`
   - gitUser: \`git config --global --list --show-origin | head -1\`
   - claudeVars: \`env | grep -o '^CLAUDE[A-Z_]*' | sort | tr '\\n' ' '\`
   - parentSentinels: \`env | grep -c factory-parent-sentinel || true\``,
      { output: Visible },
    );
    if (seen.output === undefined) throw new Error("no structured output");
    return seen.output;
  },
});

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(import.meta.dir, "out", `${mode}-${agent}-${stamp}`);
await mkdir(out, { recursive: true });
const events: RunEvent[] = [];
const diagnostics: Array<AcpDiagnostic & { step: number }> = [];
const pids: number[] = [];
let step = -1;

const definition = acpAgent(agent, { hostSettings });
const leaked = Object.keys(agentEnv(definition)).filter(
  (k) => k === "CLAUDECODE" || k.startsWith("CLAUDE_"),
);
console.log(
  `parent CLAUDE* vars: ${Object.keys(process.env).filter((k) => k.startsWith("CLAUDE")).length}, passed to the agent: [${leaked.join(", ")}]`,
);
const adapter = acpAdapter(definition, {
  onDiagnostic: (event) => {
    if (event.kind === "spawned") {
      step += 1;
      pids.push(event.pid);
    }
    diagnostics.push({ ...event, step });
  },
});

const dir = await scratchRepo();
console.log(`${mode} ${agent} model=${model} dir=${dir}`);
const runtime = makeAgentRuntime(adapter);
const t0 = Date.now();
const handle = startRun(mode === "isolation" ? isolation : hello, runtime, {
  runId: `spike-${stamp}`,
  dir,
  input: { long: mode === "cancel" },
  onEvent: (event) => {
    events.push(event);
    const p = event.payload;
    if (p._tag !== "AgentChunk") console.log(`+${Date.now() - t0}ms ${p._tag}`);
  },
});

/** The agent process and every descendant of it. */
async function processTree(root: number): Promise<number[]> {
  const kids = (await sh("/", "sh", "-c", `pgrep -P ${root} || true`))
    .split("\n")
    .filter(Boolean)
    .map(Number);
  return [root, ...(await Promise.all(kids.map(processTree))).flat()];
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let cancelReport: unknown;
if (mode === "cancel") {
  await Bun.sleep(Number(afterArg ?? 15000));
  const tree = await processTree(pids.at(-1)!);
  const before = Date.now();
  await handle.cancel();
  const outcome = await handle.result;
  const cancelledMs = Date.now() - before;
  await handle.settled;
  const settledMs = Date.now() - before;
  await Bun.sleep(3000);
  cancelReport = {
    outcome: outcome.outcome,
    tree,
    cancelledMs,
    settledMs,
    aliveAfter3s: tree.filter(alive),
  };
  console.log("cancel:", cancelReport);
} else {
  const outcome = await handle.result;
  console.log("outcome:", JSON.stringify(outcome, null, 2));
}
await runtime.dispose();

await writeFile(join(out, "events.ndjson"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
await writeFile(
  join(out, "diagnostics.ndjson"),
  diagnostics.map((d) => JSON.stringify(d)).join("\n") + "\n",
);

// --- summary ---------------------------------------------------------------
for (let s = 0; s <= step; s++) {
  const d = diagnostics.filter((x) => x.step === s);
  const at = (kind: string) => d.find((x) => x.kind === kind)?.at;
  const spawned = at("spawned")!;
  const firstUpdate = at("update");
  const rel = (t?: number) => (t === undefined ? "-" : `${t - spawned}ms`);
  const session = d.find((x) => x.kind === "session");
  const model0 =
    session?.kind === "session"
      ? session.configOptions.find((o) => o.category === "model")?.currentValue
      : undefined;
  const configured = d.find((x) => x.kind === "configured");
  const modelAfter =
    configured?.kind === "configured"
      ? configured.configOptions.find((o) => o.category === "model")?.currentValue
      : model0;
  const done = d.find((x) => x.kind === "done");
  const usageUpdates = d.flatMap((x) =>
    x.kind === "update" && x.update.sessionUpdate === "usage_update" ? [x.update] : [],
  );
  const updateKinds: Record<string, number> = {};
  for (const x of d)
    if (x.kind === "update")
      updateKinds[x.update.sessionUpdate] = (updateKinds[x.update.sessionUpdate] ?? 0) + 1;
  console.log(`\n== step ${s}`);
  console.log(
    `  init ${rel(at("initialized"))} · session ${rel(at("session"))} · configured ${rel(at("configured"))} · first update ${rel(firstUpdate)} · done ${rel(at("done"))}`,
  );
  console.log(`  model: default=${String(model0)} → ${String(modelAfter)}`);
  console.log(
    `  config options: ${session?.kind === "session" ? session.configOptions.map((o) => `${o.id}(${o.category ?? "-"})`).join(", ") : "-"}`,
  );
  console.log(
    `  permission asks:`,
    d
      .filter((x) => x.kind === "permission")
      .map((x) => x.kind === "permission" && `${x.title} → ${x.chosen}`),
  );
  console.log(
    `  done:`,
    done?.kind === "done" ? { stopReason: done.stopReason, usage: done.usage } : "-",
  );
  console.log(
    `  usage_update (last):`,
    usageUpdates.at(-1) ?? "-",
    `(${usageUpdates.length} total)`,
  );
  console.log(`  update kinds:`, updateKinds);
}
const finished = events.flatMap((e) => (e.payload._tag === "AgentStepFinished" ? [e.payload] : []));
for (const f of finished)
  console.log(
    `\nAgentStepFinished ${f.name}: ${f.outcome} ${f.durationMs}ms chunks=${f.chunkCount} session=${f.sessionId} usage=${JSON.stringify(f.usage)} error=${f.error ?? "-"}`,
  );
const chunkTypes: Record<string, number> = {};
for (const e of events)
  if (e.payload._tag === "AgentChunk")
    chunkTypes[e.payload.chunkType] = (chunkTypes[e.payload.chunkType] ?? 0) + 1;
console.log("chunk types:", chunkTypes);
console.log(`\nwritten to ${out}`);
process.exit(0);
