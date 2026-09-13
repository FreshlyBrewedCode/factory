/**
 * File-content snapshotting for tree-survival assertions (ADR 0001 §5: proven
 * against reality in 0a-2, harvested verbatim). Workflow-importable, plain
 * utilities over `ctx.dir` — D13's middle piece.
 *
 * - `assertHostSideStability` — the weak comparison: both snapshots taken
 *   before a step's sandbox exists. Proves nothing mutated the tree on the
 *   host between two points; does not exercise sandbox reuse.
 * - `assertFixStepSurvived` — the strong comparison: one snapshot right
 *   after an earlier step, one right after a later step's sandbox has
 *   re-bootstrapped, distinguishing "reverted to the origin/main seed" (a
 *   real bug) from "the agent legitimately edited it further".
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { hostExec } from "./exec";

export interface FileSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly content: string | null;
}

export async function snapshotFiles(
  dir: string,
  relPaths: ReadonlyArray<string>,
): Promise<ReadonlyArray<FileSnapshot>> {
  return Promise.all(
    relPaths.map(async (path): Promise<FileSnapshot> => {
      const abs = join(dir, path);
      const exists = existsSync(abs);
      const content = exists ? await Bun.file(abs).text() : null;
      return { path, exists, content };
    }),
  );
}

/**
 * Read each path's content as it exists at `ref` (default `origin/main`), via
 * `git show`, without touching the working tree. A path that does not exist
 * at `ref` yields `{ exists: false, content: null }`.
 */
export async function seedFileSnapshot(
  dir: string,
  relPaths: ReadonlyArray<string>,
  ref = "origin/main",
): Promise<ReadonlyArray<FileSnapshot>> {
  return Promise.all(
    relPaths.map(async (path): Promise<FileSnapshot> => {
      const result = await hostExec(["git", "show", `${ref}:${path}`], { cwd: dir });
      if (result.exitCode !== 0) {
        return { path, exists: false, content: null };
      }
      return { path, exists: true, content: result.stdout };
    }),
  );
}

function find(snapshot: ReadonlyArray<FileSnapshot>, path: string): FileSnapshot | undefined {
  return snapshot.find((s) => s.path === path);
}

export interface HostSideStabilityAssertion {
  readonly intact: boolean;
  readonly report: string;
  readonly before: ReadonlyArray<FileSnapshot>;
  readonly after: ReadonlyArray<FileSnapshot>;
}

/**
 * Compare two snapshots of the same paths taken at different times, both
 * *before* the boundary step's sandbox runs. `intact` is true only if every
 * path exists in both snapshots with byte-identical content. Does NOT span a
 * sandbox re-bootstrap — see `assertFixStepSurvived` for that.
 */
export function assertHostSideStability(
  before: ReadonlyArray<FileSnapshot>,
  after: ReadonlyArray<FileSnapshot>,
): HostSideStabilityAssertion {
  const lines: Array<string> = [];
  let intact = true;

  for (const b of before) {
    const a = find(after, b.path);
    if (!a) {
      intact = false;
      lines.push(`  ${b.path}: MISSING from "after" snapshot entirely`);
      continue;
    }
    if (b.exists !== a.exists) {
      intact = false;
      lines.push(`  ${b.path}: existence changed (before=${b.exists} after=${a.exists})`);
      continue;
    }
    if (!b.exists && !a.exists) {
      lines.push(`  ${b.path}: absent in both snapshots (never existed)`);
      continue;
    }
    if (b.content !== a.content) {
      intact = false;
      lines.push(
        `  ${b.path}: CONTENT CHANGED (before=${b.content?.length ?? 0} bytes, after=${a.content?.length ?? 0} bytes)`,
      );
      continue;
    }
    lines.push(`  ${b.path}: intact (${b.content?.length ?? 0} bytes, byte-identical)`);
  }

  const header = intact
    ? "HOST-SIDE STABILITY (weak, does NOT span a sandbox re-bootstrap): PASS — tracked files byte-identical."
    : "HOST-SIDE STABILITY (weak, does NOT span a sandbox re-bootstrap): FAIL — the tree changed.";

  return { intact, report: [header, ...lines].join("\n"), before, after };
}

export type FixSurvivalOutcome =
  | "unchanged"
  | "edited"
  | "reverted-to-seed"
  | "vanished"
  | "truncated";

export interface FixSurvivalFileResult {
  readonly path: string;
  readonly outcome: FixSurvivalOutcome;
  readonly ok: boolean;
  readonly markersPresent: ReadonlyArray<string>;
  readonly markersMissing: ReadonlyArray<string>;
  readonly detail: string;
}

export interface FixStepSurvivalAssertion {
  readonly intact: boolean;
  readonly report: string;
  readonly files: ReadonlyArray<FixSurvivalFileResult>;
}

/**
 * The strong assertion. Compares `before` (snapshot taken right after an
 * earlier step) against `after` (snapshot taken right after a later step's
 * sandbox has re-bootstrapped). For each tracked path, classifies what
 * happened — `vanished`/`truncated`/`reverted-to-seed` are failures,
 * `unchanged`/`edited` are passes, gated further on `requiredMarkers` still
 * being textually present in `after`.
 */
export function assertFixStepSurvived(params: {
  readonly before: ReadonlyArray<FileSnapshot>;
  readonly after: ReadonlyArray<FileSnapshot>;
  readonly seed: ReadonlyArray<FileSnapshot>;
  readonly requiredMarkers: Readonly<Record<string, ReadonlyArray<string>>>;
}): FixStepSurvivalAssertion {
  const { before, after, seed, requiredMarkers } = params;
  const files: Array<FixSurvivalFileResult> = [];

  for (const prior of before) {
    const later = find(after, prior.path);
    const seedSnap = find(seed, prior.path);
    const markers = requiredMarkers[prior.path] ?? [];

    let outcome: FixSurvivalOutcome;
    let detail: string;

    if (!later || !later.exists) {
      outcome = "vanished";
      detail = `existed before (${prior.content?.length ?? 0} bytes), missing after`;
    } else if (prior.exists && prior.content !== "" && later.content === "") {
      outcome = "truncated";
      detail = `had ${prior.content?.length ?? 0} bytes before, 0 bytes after`;
    } else if (
      seedSnap?.exists === true &&
      later.content === seedSnap.content &&
      prior.content !== seedSnap.content
    ) {
      outcome = "reverted-to-seed";
      detail = `content after matches origin/main seed exactly, but content before did not`;
    } else if (later.content === prior.content) {
      outcome = "unchanged";
      detail = `byte-identical to the earlier snapshot (${later.content?.length ?? 0} bytes)`;
    } else {
      outcome = "edited";
      detail = `content differs from both the earlier snapshot and the origin/main seed (${prior.content?.length ?? 0} -> ${later.content?.length ?? 0} bytes)`;
    }

    const laterContent = later?.content ?? "";
    const markersPresent = markers.filter((m) => laterContent.includes(m));
    const markersMissing = markers.filter((m) => !laterContent.includes(m));

    const outcomeOk = outcome === "unchanged" || outcome === "edited";
    const ok = outcomeOk && markersMissing.length === 0;

    files.push({ path: prior.path, outcome, ok, markersPresent, markersMissing, detail });
  }

  const intact = files.every((f) => f.ok);

  const lines = files.map((f) => {
    const markerNote =
      f.markersPresent.length + f.markersMissing.length > 0
        ? ` | markers present=${JSON.stringify(f.markersPresent)} missing=${JSON.stringify(f.markersMissing)}`
        : "";
    return `  ${f.path}: outcome=${f.outcome} ok=${f.ok} — ${f.detail}${markerNote}`;
  });

  const header = intact
    ? "FIX-STEP SURVIVAL (strong, spans a sandbox re-bootstrap): PASS."
    : "FIX-STEP SURVIVAL (strong, spans a sandbox re-bootstrap): FAIL — see per-file detail below.";

  return { intact, report: [header, ...lines].join("\n"), files };
}
