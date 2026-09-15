import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { allocateWorkspace } from "./workspace";
import type { GitIdentity } from "./clone";

const IDENTITY: GitIdentity = { name: "Test Bot", email: "test@factory.local" };

async function seedRepo(dir: string, marker: string): Promise<void> {
  await Bun.$`git init -b main -q ${dir}`.quiet();
  await Bun.$`echo ${marker} > ${join(dir, "seed.txt")}`.quiet();
  await Bun.$`git -C ${dir} add seed.txt`.quiet();
  await Bun.$`git -C ${dir} -c user.name=seed -c user.email=seed@seed.local commit -q -m seed`.quiet();
}

function listRuns(root: string): Array<string> {
  return readdirSync(root).filter((entry) => entry !== ".mirror.git");
}

describe("allocateWorkspace (D28)", () => {
  test("allocates <workspaceRoot>/<runId> from a refreshed bare mirror, with identity set", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-workspace-test-"));
    const workspaceRoot = join(root, "workspaces");
    const seed = join(root, "seed-repo");
    await seedRepo(seed, "one");

    const dir = await allocateWorkspace({
      runId: "run-a",
      workspaceRoot,
      sshUrl: seed,
      identity: IDENTITY,
      retainedWorkspaces: 10,
    });

    expect(dir).toBe(join(workspaceRoot, "run-a"));
    expect(existsSync(join(dir, "seed.txt"))).toBe(true);
    expect(existsSync(join(workspaceRoot, ".mirror.git"))).toBe(true);
    const name = (await Bun.$`git -C ${dir} config user.name`.text()).trim();
    expect(name).toBe(IDENTITY.name);
    const email = (await Bun.$`git -C ${dir} config user.email`.text()).trim();
    expect(email).toBe(IDENTITY.email);
    rmSync(root, { recursive: true, force: true });
  });

  test("the mirror is refreshed from the sshUrl before each allocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-workspace-refresh-test-"));
    const workspaceRoot = join(root, "workspaces");
    const seed = join(root, "seed-repo");
    await seedRepo(seed, "one");

    await allocateWorkspace({
      runId: "run-one",
      workspaceRoot,
      sshUrl: seed,
      identity: IDENTITY,
      retainedWorkspaces: 10,
    });

    await Bun.$`echo two > ${join(seed, "second.txt")}`.quiet();
    await Bun.$`git -C ${seed} add second.txt`.quiet();
    await Bun.$`git -C ${seed} -c user.name=seed -c user.email=seed@seed.local commit -q -m second`.quiet();

    const dir = await allocateWorkspace({
      runId: "run-two",
      workspaceRoot,
      sshUrl: seed,
      identity: IDENTITY,
      retainedWorkspaces: 10,
    });
    expect(existsSync(join(dir, "second.txt"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("evicts oldest trees first, retaining the last N", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-workspace-evict-test-"));
    const workspaceRoot = join(root, "workspaces");
    const seed = join(root, "seed-repo");
    await seedRepo(seed, "one");

    for (const runId of ["run-1", "run-2", "run-3"]) {
      await allocateWorkspace({
        runId,
        workspaceRoot,
        sshUrl: seed,
        identity: IDENTITY,
        retainedWorkspaces: 2,
      });
    }

    const dirs = listRuns(workspaceRoot).sort();
    expect(dirs).toEqual(["run-2", "run-3"]);
    expect(existsSync(join(workspaceRoot, ".mirror.git"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("allocation is safe under concurrency: two runs get two independent trees", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-workspace-concurrent-test-"));
    const workspaceRoot = join(root, "workspaces");
    const seed = join(root, "seed-repo");
    await seedRepo(seed, "one");

    const [a, b] = await Promise.all([
      allocateWorkspace({
        runId: "run-x",
        workspaceRoot,
        sshUrl: seed,
        identity: IDENTITY,
        retainedWorkspaces: 10,
      }),
      allocateWorkspace({
        runId: "run-y",
        workspaceRoot,
        sshUrl: seed,
        identity: IDENTITY,
        retainedWorkspaces: 10,
      }),
    ]);
    expect(existsSync(join(a, "seed.txt"))).toBe(true);
    expect(existsSync(join(b, "seed.txt"))).toBe(true);
    expect([...listRuns(workspaceRoot)].sort()).toEqual(["run-x", "run-y"]);
    rmSync(root, { recursive: true, force: true });
  });
});
