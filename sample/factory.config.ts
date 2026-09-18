/**
 * The sample project's entry point (D27): `factory serve --config sample/factory.config.ts`
 * from the factory repo root. The import below *is* the workflow registry (D30).
 *
 * This config points at https://github.com/FreshlyBrewedCode/factory-spike — clone the
 * directory and swap the repo/identity for your own target repo.
 */

import { defineConfig } from "@frebreco/factory";

import implementIssue from "./workflows/implement-issue.ts";
import readySweep from "./workflows/ready-sweep.ts";

export default defineConfig({
  repo: {
    sshUrl: "git@github.com:FreshlyBrewedCode/factory-spike.git",
    identity: { name: "FreshlyBrewedCode", email: "karl@git.frebreco.de" },
    baseBranch: "main",
    slug: "FreshlyBrewedCode/factory-spike",
  },
  workflows: [readySweep, implementIssue],
  maxConcurrentRuns: 2,
  schedules: [
    // The Ready sweep (issue #18): a cron on a *wrapper workflow* (which runs
    // on a scratch workspace, reads the GitHub Project board and dispatches
    // child runs) replaces the retired hardcoded dispatcher. `owner` /
    // `projectNumber` name the project board the sweep sweeps; edit them for
    // your own repo, then `factory serve`.
    {
      id: "ready-sweep",
      workflow: "ready-sweep",
      input: { owner: "FreshlyBrewedCode", projectNumber: 4 },
      cron: "0 * * * * *",
      timezone: "UTC",
    },
  ],
});
