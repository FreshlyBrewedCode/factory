/**
 * This project's factory config — the entry point `factory serve` loads.
 *
 * The `workflows` array *is* the registry: a workflow is available to the UI
 * and to `factory start` because it is imported here, and for no other reason.
 */

import { defineConfig } from "@frebreco/factory";

import hello from "./workflows/hello";
import implementParentIssue from "./workflows/implement-parent-issue";

export default defineConfig({
  // The repository runs are cloned from, and where write-back opens its PRs.
  repo: {
    sshUrl: "git@github.com:FreshlyBrewedCode/factory.git",
    slug: "FreshlyBrewedCode/factory",
    baseBranch: "main",
    // The author on the commits factory creates.
    identity: {
      name: "FreshlyBrewedCode",
      email: "karl@git.frebreco.de",
    },
  },

  // Add a workflow by importing it and listing it here.
  workflows: [hello, implementParentIssue],

  // How many runs may be in flight at once. A run over the limit is refused,
  // not queued.
  maxConcurrentRuns: 2,

  // Finished working trees kept on disk for inspection, oldest evicted first.
  // Must be >= maxConcurrentRuns.
  retainedWorkspaces: 10,
});
