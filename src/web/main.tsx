import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "@/web/router";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

const container = document.getElementById("root");
if (container === null) throw new Error("factory: #root container is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

/**
 * Agentation's click-to-annotate overlay, dev-only. Dynamically imported so
 * it never lands in the initial bundle — `factory serve`'s Bun-bundled
 * production build has no `FACTORY_AGENTATION` set and never fetches it.
 */
if (["1", "true"].includes(import.meta.env.FACTORY_AGENTATION ?? "")) {
  void import("agentation").then(({ Agentation }) => {
    const mount = document.body.appendChild(document.createElement("div"));
    createRoot(mount).render(<Agentation />);
  });
}
