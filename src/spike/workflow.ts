/**
 * The workflow script — the imperative, author-facing piece (D13). Plain
 * `async` control flow over a `ctx` handle, no framework surface: this is
 * the shape phase 1's `defineWorkflow` will eventually wrap, but nothing
 * here depends on that happening.
 *
 * Scope for 0a-1 is deliberately narrower than the phase-0 plan's full
 * eight-step round trip (that's 0a-2): one agent step, then verify with
 * `bun test`. No write-back.
 */

import type { AgentStepResult } from "./lib/agent-step";
import type { ExecResult } from "./lib/exec";

export const ISSUE_1_PROMPT = `You are working in a git checkout of a small bun/TypeScript package.

Implement GitHub issue #1: add a \`slugify(input: string): string\` export from src/index.ts, alongside the existing \`greet\` export. It should lowercase the input, trim it, replace runs of non-alphanumeric characters with a single hyphen, and strip leading/trailing hyphens (e.g. "Hello, World!" -> "hello-world").

Add a passing test for it in src/index.test.ts, in the same style as the existing test for \`greet\`. Do not remove or break the existing \`greet\` export or its test.

When you are done, stop — do not run git commands, do not commit, do not open a PR.`;

export interface WorkflowContext {
  readonly clonePath: string;
  agentStep(prompt: string): Promise<AgentStepResult>;
  exec(command: ReadonlyArray<string>): Promise<ExecResult>;
}

export interface WorkflowResult {
  readonly agent: AgentStepResult;
  readonly test: ExecResult;
}

/**
 * Ask the agent to implement issue #1, then verify with `bun test`.
 * `ctx.exec`'s exit code is returned, not thrown — the caller decides what a
 * failing test run means (sandcastle's branching primitive, ported per D9).
 */
export async function implementSlugify(ctx: WorkflowContext): Promise<WorkflowResult> {
  const agent = await ctx.agentStep(ISSUE_1_PROMPT);
  const test = await ctx.exec(["bun", "test"]);
  return { agent, test };
}
