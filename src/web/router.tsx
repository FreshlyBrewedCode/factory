import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AppShell } from "@/web/app-shell";
import { DispatchPage } from "@/web/pages/dispatch";
import { RunDetailPage } from "@/web/pages/run-detail";
import { RunsPage } from "@/web/pages/runs";
import { WorkflowsPage } from "@/web/pages/workflows";

/**
 * Code-based routing (not file-based) so the scaffold carries no generator
 * step yet. Each nav category is its own URL, matching the refined prototype:
 * `/` is the runs list, `/runs/:runId` the run detail, with Workflows and
 * Dispatch as their own pages.
 */
const rootRoute = createRootRoute({ component: AppShell });

const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: RunsPage,
});

const runDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  component: RunDetailPage,
});

const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows",
  component: WorkflowsPage,
});

const dispatchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dispatch",
  component: DispatchPage,
});

const routeTree = rootRoute.addChildren([runsRoute, runDetailRoute, workflowsRoute, dispatchRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
