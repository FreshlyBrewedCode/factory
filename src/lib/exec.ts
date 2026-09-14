/**
 * Host-side process execution. Factory owns the clone (D8), so anything that
 * needs to touch it — cloning, git identity, `bun test` — runs as a plain
 * host process via `Bun.spawn`, never through the sandbox handle (D7/F1: the
 * sandbox has no host-reachable exec API on non-local providers anyway, and
 * even on localProcess we want a seam that will still work once the tree
 * moves into a container).
 *
 * Harvested from `src/spike/lib/exec.ts` (ADR 0001 §5) with one addition: an
 * optional `signal` so the runtime can kill an in-flight command on run
 * cancellation (Bun.spawn accepts an AbortSignal directly).
 */

export interface ExecResult {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a command on the host. Returns the result — including a non-zero exit
 * code — rather than throwing. Non-zero is the caller's branching primitive
 * (sandcastle's `exec` returns rather than throws; ported here per D9).
 */
export async function hostExec(
  command: ReadonlyArray<string>,
  options: { cwd?: string; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  const proc = Bun.spawn([...command], {
    cwd: options.cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    signal: options.signal,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { command: command.join(" "), exitCode, stdout, stderr };
}
