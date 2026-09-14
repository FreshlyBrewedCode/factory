/**
 * Dynamic-import a workflow module and validate its `default` export.
 * Shared by `factory run` (`src/cli.ts`) and the phase 3 HTTP API
 * (`src/server/http.ts`) — one workflow-loading contract, not two.
 */

import { resolve } from "node:path";
import type { WorkflowDefinition } from "../workflow";

export async function loadWorkflow(path: string): Promise<WorkflowDefinition> {
  const imported: unknown = await import(resolve(path));
  const workflow = (imported as { default?: WorkflowDefinition }).default;
  if (workflow === undefined || typeof workflow.run !== "function") {
    throw new Error(`${path} has no default defineWorkflow(...) export`);
  }
  return workflow;
}
