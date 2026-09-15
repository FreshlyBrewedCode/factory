/**
 * The sample project's entry point (D27): `factory serve --config sample/factory.config.ts`
 * from the factory repo root. The import below *is* the workflow registry (D30).
 *
 * This config points at https://github.com/FreshlyBrewedCode/factory-spike — clone the
 * directory and swap the repo/identity for your own target repo.
 */

import { defineConfig } from "@frebreco/factory";

import implementIssue from "./workflows/implement-issue.ts";

export default defineConfig({
  repo: {
    sshUrl: "git@github.com:FreshlyBrewedCode/factory-spike.git",
    identity: { name: "FreshlyBrewedCode", email: "karl@git.frebreco.de" },
    baseBranch: "main",
    slug: "FreshlyBrewedCode/factory-spike",
  },
  workflows: [implementIssue],
  maxConcurrentRuns: 2,
});
