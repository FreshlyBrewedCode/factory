/**
 * File-content snapshotting for the step-4 tree-survival assertion (STATUS.md
 * 0a step 4: "asserts step 2's files are still present" — "the single most
 * important thing phase 0 can learn").
 *
 * 0a-2 correction: the first cut of this assertion (see git history / 0a-2
 * task notes) took both of its snapshots *before* `ctx.agentStep({step:
 * 'fix'})` ran, so all it ever proved was that the tree survived a host-side
 * `bun test`. That is not what STATUS.md is asking — the risk it names is
 * `localProcess`'s fresh-session re-bootstrap wiping the tree, which only
 * happens when the *fix step itself* stands up its sandbox again. This file
 * now provides two, clearly distinguished things:
 *
 * - `assertHostSideStability` — the weak, original comparison. Both
 *   snapshots are taken before the fix step's sandbox exists. Useful as a
 *   sanity check that nothing on the host mutated the tree between steps,
 *   but it does **not** exercise sandbox reuse at all.
 * - `assertFixStepSurvived` — the strengthened comparison this task asked
 *   for. One snapshot right after the implement step, one right after the
 *   fix step *completes*, so the comparison spans the fix step's own
 *   sandbox re-bootstrap. It further distinguishes "the agent deliberately
 *   edited a tracked file" (legitimate) from "the file reverted to the
 *   `origin/main` seed content" (the failure mode we actually care about —
 *   bootstrap wiping/reverting the tree) by diffing against a third
 *   snapshot taken from `origin/main` via `git show`, and checks that
 *   specific markers left by the implement step (e.g. the `slugify` export)
 *   are still textually present regardless of which outcome fired.
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
  clonePath: string,
  relPaths: ReadonlyArray<string>,
): Promise<ReadonlyArray<FileSnapshot>> {
  return Promise.all(
    relPaths.map(async (path): Promise<FileSnapshot> => {
      const abs = join(clonePath, path);
      const exists = existsSync(abs);
      const content = exists ? await Bun.file(abs).text() : null;
      return { path, exists, content };
    }),
  );
}

/**
 * Read each path's content as it exists at `ref` (default `origin/main`),
 * via `git show`, without touching the working tree. Used as the "seed"
 * baseline so a revert-to-seed is distinguishable from a deliberate edit.
 * A path that does not exist at `ref` (e.g. it was created by the implement
 * step) yields `{ exists: false, content: null }`.
 */
export async function seedFileSnapshot(
  clonePath: string,
  relPaths: ReadonlyArray<string>,
  ref = "origin/main",
): Promise<ReadonlyArray<FileSnapshot>> {
  return Promise.all(
    relPaths.map(async (path): Promise<FileSnapshot> => {
      const result = await hostExec(["git", "show", `${ref}:${path}`], { cwd: clonePath });
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

// ---------------------------------------------------------------------------
// Weak assertion: host-side stability only (both snapshots pre-date the fix
// step's sandbox). Kept because it is still a real (if narrow) check, but
// clearly labelled so it is never mistaken for the strong one.
// ---------------------------------------------------------------------------

export interface HostSideStabilityAssertion {
  readonly intact: boolean;
  readonly report: string;
  readonly before: ReadonlyArray<FileSnapshot>;
  readonly after: ReadonlyArray<FileSnapshot>;
}

/**
 * Compare two snapshots of the same paths taken at different times, both
 * *before* the fix step's agent/sandbox runs (e.g. immediately after the
 * implement step vs. immediately before the fix step is invoked, spanning
 * only the host-side `bun test` exec in between). `intact` is true only if
 * every path exists in both snapshots with byte-identical content.
 *
 * BOUNDARY: this does NOT span the fix step's sandbox re-bootstrap. It only
 * proves the tree was stable across a host-side command. See
 * `assertFixStepSurvived` for the assertion that actually matters.
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
    ? "HOST-SIDE STABILITY (weak, pre-fix-step only, does NOT span the sandbox re-bootstrap): PASS — tracked files byte-identical across the host-side bun test exec."
    : "HOST-SIDE STABILITY (weak, pre-fix-step only, does NOT span the sandbox re-bootstrap): FAIL — the tree changed before the fix step even started.";

  return {
    intact,
    report: [header, ...lines].join("\n"),
    before,
    after,
  };
}

// ---------------------------------------------------------------------------
// Strong assertion: spans the fix step's sandbox re-bootstrap boundary.
// ---------------------------------------------------------------------------

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
 * The strengthened step-4 assertion. Compares `afterImplement` (snapshot
 * taken right after the implement step) against `afterFix` (snapshot taken
 * right after the fix step *completes*), so the comparison spans the fix
 * step's own sandbox setup/re-bootstrap — the actual thing STATUS.md's "does
 * `localProcess` re-bootstrap destroy anything between steps" question is
 * about.
 *
 * For each tracked path, classifies what happened:
 * - `vanished` — file existed after implement, does not exist after fix.
 *   FAIL — the boundary destroyed a tracked file.
 * - `truncated` — file existed with content after implement, exists but is
 *   empty after fix. FAIL — a wipe that didn't delete the file outright.
 * - `reverted-to-seed` — content after fix matches the `origin/main` seed
 *   content, but content after implement did NOT match the seed (i.e. the
 *   implement step's work existed, then disappeared back to seed). FAIL —
 *   this is the specific "bootstrap wiped/reverted the tree" failure mode.
 * - `unchanged` — content after fix is byte-identical to content after
 *   implement. PASS — the fix step made no edits to this file, and the
 *   implement step's work survived the boundary intact.
 * - `edited` — content differs from both the post-implement snapshot and
 *   the seed. PASS, conditionally — this is a legitimate agent edit, not a
 *   revert, but `ok` still requires the required markers below to still be
 *   present (an edit could theoretically remove the very thing the
 *   implement step added, which would not be a "revert to seed" but would
 *   still be a real regression worth flagging).
 *
 * Independent of the above classification, `requiredMarkers[path]` (plain
 * substrings, e.g. "function slugify") are checked against the `afterFix`
 * content: if any go missing, `ok` is false regardless of outcome, because
 * "step 2's contribution survived" is the thing being tested, not merely
 * "the outcome wasn't literally a revert".
 */
export function assertFixStepSurvived(params: {
  readonly afterImplement: ReadonlyArray<FileSnapshot>;
  readonly afterFix: ReadonlyArray<FileSnapshot>;
  readonly seed: ReadonlyArray<FileSnapshot>;
  readonly requiredMarkers: Readonly<Record<string, ReadonlyArray<string>>>;
}): FixStepSurvivalAssertion {
  const { afterImplement, afterFix, seed, requiredMarkers } = params;
  const files: Array<FixSurvivalFileResult> = [];

  for (const impl of afterImplement) {
    const fix = find(afterFix, impl.path);
    const seedSnap = find(seed, impl.path);
    const markers = requiredMarkers[impl.path] ?? [];

    let outcome: FixSurvivalOutcome;
    let detail: string;

    if (!fix || !fix.exists) {
      outcome = "vanished";
      detail = `existed after implement (${impl.content?.length ?? 0} bytes), missing after fix step`;
    } else if (impl.exists && impl.content !== "" && fix.content === "") {
      outcome = "truncated";
      detail = `had ${impl.content?.length ?? 0} bytes after implement, 0 bytes after fix step`;
    } else if (
      seedSnap?.exists === true &&
      fix.content === seedSnap.content &&
      impl.content !== seedSnap.content
    ) {
      outcome = "reverted-to-seed";
      detail = `content after fix step matches origin/main seed exactly, but content after implement did not — the implement step's work existed and then disappeared`;
    } else if (fix.content === impl.content) {
      outcome = "unchanged";
      detail = `byte-identical to the post-implement snapshot (${fix.content?.length ?? 0} bytes) — fix step made no edits to this file`;
    } else {
      outcome = "edited";
      detail = `content differs from both the post-implement snapshot and the origin/main seed — a legitimate agent edit (${impl.content?.length ?? 0} -> ${fix.content?.length ?? 0} bytes)`;
    }

    const fixContent = fix?.content ?? "";
    const markersPresent = markers.filter((m) => fixContent.includes(m));
    const markersMissing = markers.filter((m) => !fixContent.includes(m));

    const outcomeOk = outcome === "unchanged" || outcome === "edited";
    const ok = outcomeOk && markersMissing.length === 0;

    files.push({ path: impl.path, outcome, ok, markersPresent, markersMissing, detail });
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
    ? "FIX-STEP SURVIVAL (strong, spans the fix step's own sandbox re-bootstrap: post-implement snapshot vs. post-fix snapshot): PASS — step 2's contribution survived the fresh-session/sandbox-reuse boundary, no file reverted to the origin/main seed, no tracked file vanished or was truncated."
    : "FIX-STEP SURVIVAL (strong, spans the fix step's own sandbox re-bootstrap: post-implement snapshot vs. post-fix snapshot): FAIL — see per-file detail below.";

  return {
    intact,
    report: [header, ...lines].join("\n"),
    files,
  };
}
