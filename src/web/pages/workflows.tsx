export function WorkflowsPage() {
  return (
    <section data-testid="workflows-page" className="mx-auto max-w-3xl px-6 py-6">
      <h1 className="text-lg font-semibold">Workflows</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        The workflow registry page arrives in S5, once{" "}
        <code className="font-mono text-xs">GET /api/workflows</code> exists.
      </p>
    </section>
  );
}
