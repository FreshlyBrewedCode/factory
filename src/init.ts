/**
 * `factory init` — the one command a new project runs before anything else.
 *
 * It writes `.factory/`: a `factory.config.ts` (D27's entry point) and one
 * deliberately small workflow, plus the `.gitignore` lines that keep the
 * authored half of `.factory/` committed and the regenerable half
 * (`factory.db`, `workspaces/`, run dumps) out of git.
 *
 * Two properties it holds on purpose:
 *
 * - **It never overwrites.** An existing file is reported as skipped, so
 *   running `init` twice is safe and running it in a live project cannot
 *   destroy a config. `--force` is the explicit opt-out.
 * - **It guesses from the repo it is standing in.** `origin`'s URL and the
 *   local git identity become the config's `repo` block, so the generated
 *   config is usually runnable rather than a form to fill in. Every guess has
 *   a visible placeholder fallback, and the template says which is which.
 */

import { mkdir } from "node:fs/promises";
import { hostExec } from "./lib/exec";

export interface InitOptions {
  readonly cwd: string;
  /** Overwrite files that already exist. Off by default — `init` is additive. */
  readonly force?: boolean;
}

export interface InitResult {
  readonly created: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
  readonly gitignoreUpdated: boolean;
  readonly repo: DetectedRepo;
}

export interface DetectedRepo {
  readonly sshUrl: string;
  readonly slug: string;
  readonly baseBranch: string;
  readonly name: string;
  readonly email: string;
  /** Which fields are real findings rather than placeholders the user must edit. */
  readonly detected: ReadonlyArray<"remote" | "identity" | "baseBranch">;
}

const PLACEHOLDER_SSH_URL = "git@github.com:OWNER/REPO.git";
const PLACEHOLDER_SLUG = "OWNER/REPO";

/**
 * The gitignore lines `.factory/` needs once it holds committed source. Written
 * as one block with a header comment so a second `init` can recognise its own
 * previous work by the header alone.
 */
const GITIGNORE_HEADER = "# factory: regenerable state (the config and workflows above it stay)";
const GITIGNORE_BLOCK = [
  GITIGNORE_HEADER,
  ".factory/factory.db",
  ".factory/factory.db-shm",
  ".factory/factory.db-wal",
  ".factory/workspaces/",
  ".factory/runs/",
].join("\n");

/** Turn any git remote URL into an `owner/repo` slug. Returns undefined if it is not recognisable. */
export function slugFromRemote(url: string): string | undefined {
  const trimmed = url.trim().replace(/\.git$/, "");
  // git@host:owner/repo · ssh://git@host/owner/repo · https://host/owner/repo
  const match = /(?:[:/])([^/:]+)\/([^/]+)$/.exec(trimmed);
  if (match === null) return undefined;
  return `${match[1]}/${match[2]}`;
}

async function gitValue(cwd: string, args: ReadonlyArray<string>): Promise<string | undefined> {
  const result = await hostExec(["git", ...args], { cwd });
  const value = result.stdout.trim();
  return result.exitCode === 0 && value !== "" ? value : undefined;
}

/**
 * Read what the surrounding git checkout already knows. Never throws: a
 * directory that is not a git repo simply yields placeholders, because `init`
 * has to work before `git init` as well as after it.
 */
export async function detectRepo(cwd: string): Promise<DetectedRepo> {
  const detected: Array<"remote" | "identity" | "baseBranch"> = [];

  const remote = await gitValue(cwd, ["remote", "get-url", "origin"]);
  const slug = remote !== undefined ? slugFromRemote(remote) : undefined;
  if (remote !== undefined && slug !== undefined) detected.push("remote");

  const name = await gitValue(cwd, ["config", "user.name"]);
  const email = await gitValue(cwd, ["config", "user.email"]);
  if (name !== undefined && email !== undefined) detected.push("identity");

  // The remote's default branch, falling back to the branch checked out here.
  const remoteHead = await gitValue(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  const baseBranch =
    remoteHead?.split("/").pop() ?? (await gitValue(cwd, ["branch", "--show-current"]));
  if (baseBranch !== undefined) detected.push("baseBranch");

  return {
    // An unrecognisable remote is worse than none: it would generate a config
    // that looks filled in but pushes nowhere sensible.
    sshUrl: slug !== undefined ? (remote as string) : PLACEHOLDER_SSH_URL,
    slug: slug ?? PLACEHOLDER_SLUG,
    baseBranch: baseBranch ?? "main",
    name: name ?? "Factory",
    email: email ?? "factory@example.com",
    detected,
  };
}

function configTemplate(repo: DetectedRepo): string {
  const needsEditing = !repo.detected.includes("remote");
  const banner = needsEditing
    ? `//\n// ⚠ No git remote was detected, so \`repo\` below is a placeholder.\n//   Point sshUrl/slug at the repository factory should open PRs against.\n`
    : "";

  return `/**
 * This project's factory config — the entry point \`factory serve\` loads.
 *
 * The \`workflows\` array *is* the registry: a workflow is available to the UI
 * and to \`factory start\` because it is imported here, and for no other reason.
 */
${banner}
import { defineConfig } from "@frebreco/factory";

import hello from "./workflows/hello";

export default defineConfig({
  // The repository runs are cloned from, and where write-back opens its PRs.
  repo: {
    sshUrl: ${JSON.stringify(repo.sshUrl)},
    slug: ${JSON.stringify(repo.slug)},
    baseBranch: ${JSON.stringify(repo.baseBranch)},
    // The author on the commits factory creates.
    identity: {
      name: ${JSON.stringify(repo.name)},
      email: ${JSON.stringify(repo.email)},
    },
  },

  // Add a workflow by importing it and listing it here.
  workflows: [hello],

  // How many runs may be in flight at once. A run over the limit is refused,
  // not queued.
  maxConcurrentRuns: 2,

  // Finished working trees kept on disk for inspection, oldest evicted first.
  // Must be >= maxConcurrentRuns.
  retainedWorkspaces: 10,
});
`;
}

const WORKFLOW_TEMPLATE = `/**
 * Your first workflow. A workflow is a plain async function over \`ctx\` —
 * \`await\`, \`if\`, \`try\`/\`catch\` and early returns all work, because there is
 * no step graph and no DSL to translate them into.
 *
 * This one is the whole round trip in four steps: ask the agent to do
 * something, look at what it did, and open a pull request.
 *
 * Run it:
 *   factory start hello --input '{"task": "add a CONTRIBUTING.md"}' --watch
 */

import { defineWorkflow, Schema } from "@frebreco/factory";

export default defineWorkflow("hello", {
  // The input schema drives the "New run" form in the UI and validates what
  // \`factory start --input\` sends, before the run is allowed to start.
  input: Schema.Struct({
    task: Schema.String,
  }),

  // What this workflow resolves to. Recorded in the run's event log.
  output: Schema.Struct({
    changedFiles: Schema.Int,
    prUrl: Schema.NullOr(Schema.String),
  }),

  run: async (ctx, input) => {
    // 1. One agent step. \`ctx.dir\` is a working tree the runtime cloned for
    //    this run alone — the agent is already in it.
    await ctx.agent(
      "implement",
      \`You are working in a git checkout of this project.

Task: \${input.task}

Make the change, keeping the existing code style. When you are done, stop —
do not run git commands, do not commit, and do not open a pull request.\`,
    );

    // 2. Look at what changed. \`ctx.exec\` returns a non-zero exit code rather
    //    than throwing, so checking it is ordinary control flow.
    const status = await ctx.exec(["git", "status", "--short"]);
    const changedFiles = status.stdout.split("\\n").filter((line) => line.trim() !== "").length;

    // 3. Nothing to ship is a perfectly good outcome — just return early.
    if (changedFiles === 0) {
      await ctx.log("no-changes", { task: input.task });
      return { changedFiles: 0, prUrl: null };
    }

    // 4. Write back: branch, commit, push and open a PR. This is deterministic
    //    git and gh run by factory itself, never an instruction to the agent.
    //    If the branch name is already taken, factory retries once with a
    //    unique suffix.
    const writeBack = await ctx.writeBack({
      branch: "factory/hello",
      commitMessage: \`\${input.task}\\n\\nAutomated by the factory 'hello' workflow.\`,
      prTitle: input.task,
      prBody: \`Opened by factory.\\n\\nTask: \${input.task}\`,
    });

    return { changedFiles, prUrl: writeBack.prUrl };
  },
});
`;

async function writeIfAbsent(
  path: string,
  contents: string,
  force: boolean,
  created: Array<string>,
  skipped: Array<string>,
): Promise<void> {
  if (!force && (await Bun.file(path).exists())) {
    skipped.push(path);
    return;
  }
  await Bun.write(path, contents);
  created.push(path);
}

/**
 * Append factory's ignore block to `.gitignore`, unless a block is already
 * there. Returns whether the file was touched.
 */
async function updateGitignore(cwd: string): Promise<boolean> {
  const path = `${cwd}/.gitignore`;
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : "";

  if (existing.includes(GITIGNORE_HEADER)) return false;
  // A project that already ignores all of `.factory/` would silently drop the
  // config `init` just wrote, so that line has to go before we add ours.
  const lines = existing.split("\n");
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed !== ".factory" && trimmed !== ".factory/";
  });
  const body = kept.join("\n").replace(/\n+$/, "");
  const next = body === "" ? `${GITIGNORE_BLOCK}\n` : `${body}\n\n${GITIGNORE_BLOCK}\n`;

  await Bun.write(path, next);
  return true;
}

export async function initProject(options: InitOptions): Promise<InitResult> {
  const { cwd, force = false } = options;
  const repo = await detectRepo(cwd);

  await mkdir(`${cwd}/.factory/workflows`, { recursive: true });

  const created: Array<string> = [];
  const skipped: Array<string> = [];

  await writeIfAbsent(
    `${cwd}/.factory/factory.config.ts`,
    configTemplate(repo),
    force,
    created,
    skipped,
  );
  await writeIfAbsent(
    `${cwd}/.factory/workflows/hello.ts`,
    WORKFLOW_TEMPLATE,
    force,
    created,
    skipped,
  );

  const gitignoreUpdated = await updateGitignore(cwd);

  return { created, skipped, gitignoreUpdated, repo };
}

/** `factory init` — the CLI's presentation of `initProject`. */
export async function initCli(options: InitOptions): Promise<number> {
  const result = await initProject(options);
  const relative = (path: string) => path.slice(options.cwd.length + 1);

  for (const path of result.created) console.log(`  created  ${relative(path)}`);
  for (const path of result.skipped) console.log(`  exists   ${relative(path)} (left alone)`);
  if (result.gitignoreUpdated) console.log("  updated  .gitignore");

  if (result.created.length === 0) {
    console.log("\nNothing to do — this project is already initialised.");
    console.log("Re-run with --force to overwrite the config and the sample workflow.");
    return 0;
  }

  console.log("");
  if (!result.repo.detected.includes("remote")) {
    console.log("Next: open .factory/factory.config.ts and set repo.sshUrl and repo.slug —");
    console.log("      no git remote was detected, so they are placeholders.");
  } else {
    console.log(`Targeting ${result.repo.slug} (from this repo's origin).`);
    console.log("Check .factory/factory.config.ts if that is not the repo you meant.");
  }
  console.log("");
  console.log("Then:");
  console.log(
    "  factory serve                              # daemon + UI on http://localhost:3000",
  );
  console.log('  factory start hello --input \'{"task": "…"}\' --watch');

  return 0;
}
