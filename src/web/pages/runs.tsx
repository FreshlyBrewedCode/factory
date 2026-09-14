import { useQuery } from "@tanstack/react-query";
import { fetchRuns } from "@/web/api";

/**
 * S2 renders only enough to prove the shell, the router and the query client
 * are wired to the real API. S3 replaces this body with finding 7's
 * chronological runs table.
 */
export function RunsPage() {
  const { data, isPending, error } = useQuery({
    queryKey: ["runs"],
    queryFn: fetchRuns,
    refetchInterval: 5_000,
  });

  const count = isPending ? "loading…" : error ? "unavailable" : `${data?.length ?? 0} recorded`;

  return (
    <section data-testid="runs-page" className="mx-auto max-w-3xl px-6 py-6">
      <header className="mb-6 flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold">Runs</h1>
        <span className="font-mono text-[11px] text-muted-foreground">{count}</span>
      </header>
      <p className="text-sm text-muted-foreground">
        The chronological runs table arrives in S3. Until then the API answers same-origin at{" "}
        <code className="font-mono text-xs">/api/runs</code>.
      </p>
    </section>
  );
}
