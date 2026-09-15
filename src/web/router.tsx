import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AppShell } from "@/web/app-shell";
import { DispatchPage } from "@/web/pages/dispatch";
import { RunDetailPage } from "@/web/pages/run-detail";
import { RunsPage } from "@/web/pages/runs";

/**
 * Code-based routing (not file-based) so the scaffold carries no generator
 * step yet. `/` is the runs list, `/runs/:runId` the run detail; the
 * Workflows page was dropped in the rescope — starting runs lives in the
 * top bar's New-run dialog (phase 5 P4).
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

const dispatchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dispatch",
  component: DispatchPage,
});

const routeTree = rootRoute.addChildren([runsRoute, runDetailRoute, dispatchRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
