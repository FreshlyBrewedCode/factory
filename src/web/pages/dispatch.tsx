export function DispatchPage() {
  return (
    <section data-testid="dispatch-page" className="mx-auto max-w-3xl px-6 py-6">
      <h1 className="text-lg font-semibold">Dispatch</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        The Ready queue and WIP view arrives in S5, once{" "}
        <code className="font-mono text-xs">GET /api/dispatch</code> exists.
      </p>
    </section>
  );
}
