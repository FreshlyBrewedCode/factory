/**
 * `factory init` is the first command a new user runs, so its failure modes
 * matter more than most: it must not clobber an existing project, and the
 * config it writes must not be silently gitignored.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostExec } from "./lib/exec";
import { loadFactoryConfig } from "./config";
import { detectRepo, initProject, slugFromRemote } from "./init";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "factory-init-"));
});

afterEach(async () => {
  await rm(cwd, { force: true, recursive: true });
});

async function makeGitRepo(dir: string, remote?: string): Promise<void> {
  await hostExec(["git", "init", "-q", "."], { cwd: dir });
  await hostExec(["git", "config", "user.name", "Ada Lovelace"], { cwd: dir });
  await hostExec(["git", "config", "user.email", "ada@example.test"], { cwd: dir });
  if (remote !== undefined) {
    await hostExec(["git", "remote", "add", "origin", remote], { cwd: dir });
  }
}

const read = (path: string) => Bun.file(path).text();

describe("slugFromRemote", () => {
  test("parses the remote URL forms git actually produces", () => {
    expect(slugFromRemote("git@github.com:acme/widgets.git")).toBe("acme/widgets");
    expect(slugFromRemote("https://github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(slugFromRemote("https://github.com/acme/widgets")).toBe("acme/widgets");
    expect(slugFromRemote("ssh://git@github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(slugFromRemote("  git@github.com:acme/widgets.git\n")).toBe("acme/widgets");
  });

  test("returns undefined for something that is not a repo URL", () => {
    expect(slugFromRemote("not-a-url")).toBeUndefined();
  });
});

describe("detectRepo", () => {
  test("reads the remote and identity from the surrounding checkout", async () => {
    await makeGitRepo(cwd, "git@github.com:acme/widgets.git");

    const repo = await detectRepo(cwd);

    expect(repo.slug).toBe("acme/widgets");
    expect(repo.sshUrl).toBe("git@github.com:acme/widgets.git");
    expect(repo.name).toBe("Ada Lovelace");
    expect(repo.email).toBe("ada@example.test");
    expect(repo.detected).toContain("remote");
    expect(repo.detected).toContain("identity");
  });

  test("falls back to placeholders outside a git repo instead of throwing", async () => {
    const repo = await detectRepo(cwd);

    expect(repo.slug).toBe("OWNER/REPO");
    expect(repo.detected).not.toContain("remote");
    expect(repo.baseBranch).toBe("main");
  });
});

describe("initProject", () => {
  test("writes a config and a workflow that import the public package", async () => {
    await makeGitRepo(cwd, "git@github.com:acme/widgets.git");

    const result = await initProject({ cwd });

    expect(result.created).toHaveLength(2);
    const config = await read(join(cwd, ".factory/factory.config.ts"));
    const workflow = await read(join(cwd, ".factory/workflows/hello.ts"));

    // The generated project must import the way the README tells users to —
    // a relative path into `src/` would work in this repo and nowhere else.
    expect(config).toContain(`from "@frebreco/factory"`);
    expect(workflow).toContain(`from "@frebreco/factory"`);
    expect(config).toContain(`import hello from "./workflows/hello"`);
    expect(config).toContain(`slug: "acme/widgets"`);
    expect(workflow).toContain(`defineWorkflow("hello"`);
  });

  test("writes the default agent and a model for each agent (ADR 0013 §2)", async () => {
    await makeGitRepo(cwd, "git@github.com:acme/widgets.git");
    await initProject({ cwd });

    const config = await read(join(cwd, ".factory/factory.config.ts"));
    expect(config).toContain(`default: "claude"`);
    expect(config).toContain(`claude: "sonnet"`);
    expect(config).toContain(`opencode: "opencode/big-pickle"`);
    // The generated config loads, and the agent block validates. The temp
    // project has no node_modules, so point the package import at this source.
    const index = join(import.meta.dir, "index.ts");
    for (const file of [".factory/factory.config.ts", ".factory/workflows/hello.ts"]) {
      const path = join(cwd, file);
      await Bun.write(
        path,
        (await read(path)).replaceAll(`"@frebreco/factory"`, JSON.stringify(index)),
      );
    }
    const loaded = await loadFactoryConfig(join(cwd, ".factory/factory.config.ts"));
    expect(loaded.agent.default).toBe("claude");
    expect(loaded.agent.models).toEqual({ claude: "sonnet", opencode: "opencode/big-pickle" });
    expect(loaded.agent.hostSettings).toEqual({ claude: "ignore", opencode: "ignore" });
  });

  test("marks the repo block as needing edits when there is no remote", async () => {
    const result = await initProject({ cwd });

    const config = await read(join(cwd, ".factory/factory.config.ts"));
    expect(config).toContain("No git remote was detected");
    expect(config).toContain("OWNER/REPO");
    expect(result.repo.detected).not.toContain("remote");
  });

  test("never overwrites an existing project unless forced", async () => {
    await initProject({ cwd });
    await Bun.write(join(cwd, ".factory/factory.config.ts"), "// hand-written\n");

    const second = await initProject({ cwd });

    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(2);
    expect(await read(join(cwd, ".factory/factory.config.ts"))).toBe("// hand-written\n");

    const forced = await initProject({ cwd, force: true });
    expect(forced.created).toHaveLength(2);
    expect(await read(join(cwd, ".factory/factory.config.ts"))).toContain("defineConfig");
  });

  test("drops a blanket .factory/ ignore that would swallow the config it just wrote", async () => {
    await Bun.write(join(cwd, ".gitignore"), "node_modules\n.factory/\ndist\n");

    const result = await initProject({ cwd });

    const gitignore = await read(join(cwd, ".gitignore"));
    expect(result.gitignoreUpdated).toBe(true);
    expect(gitignore).not.toMatch(/^\.factory\/?$/m);
    expect(gitignore).toContain(".factory/workspaces/");
    expect(gitignore).toContain(".factory/factory.db");
    // Unrelated entries survive.
    expect(gitignore).toContain("node_modules");
    expect(gitignore).toContain("dist");
  });

  test("creates a .gitignore when the project has none, and does not duplicate its block", async () => {
    const first = await initProject({ cwd });
    expect(first.gitignoreUpdated).toBe(true);

    const second = await initProject({ cwd, force: true });
    expect(second.gitignoreUpdated).toBe(false);

    const gitignore = await read(join(cwd, ".gitignore"));
    expect(gitignore.match(/factory\.db-wal/g)).toHaveLength(1);
  });
});
