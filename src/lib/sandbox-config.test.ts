import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { resetClone } from "./clone";

const IDENTITY = { name: "Test Bot", email: "test@factory.local" };

describe("resetClone (#24 headless permission policy)", () => {
  test("the legacy clone path writes the same opencode.json policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-clone-sandbox-config-test-"));
    const seed = join(root, "seed-repo");
    await Bun.$`git init -b main -q ${seed}`.quiet();
    await Bun.$`echo one > ${join(seed, "seed.txt")}`.quiet();
    await Bun.$`git -C ${seed} add seed.txt`.quiet();
    await Bun.$`git -C ${seed} -c user.name=seed -c user.email=seed@seed.local commit -q -m seed`.quiet();

    const dir = join(root, "run-a");
    await resetClone(dir, seed, IDENTITY);

    expect(existsSync(join(dir, "opencode.json"))).toBe(true);
    const config = JSON.parse(await Bun.$`cat ${join(dir, "opencode.json")}`.text()) as {
      permission: Record<string, string>;
    };
    expect(config.permission).toEqual({ "*": "allow" });

    const untracked = (
      await Bun.$`git -C ${dir} status --porcelain --untracked-files=all`.text()
    ).trim();
    expect(untracked).toBe("");

    rmSync(root, { recursive: true, force: true });
  });
});
