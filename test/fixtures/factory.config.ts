import { defineConfig } from "../../src/config";
import registryWorkflow from "./registry-workflow.ts";

export default defineConfig({
  repo: {
    sshUrl: "git@github.com:acme/widgets.git",
    identity: { name: "Factory", email: "factory@acme.test" },
    baseBranch: "main",
    slug: "acme/widgets",
  },
  workflows: [registryWorkflow],
});
