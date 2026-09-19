import { useNavigate } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { WorkflowSummary } from "@/web/api";
import { Button } from "@/web/components/ui/button";
import { useStartRun, useWorkflows } from "@/web/hooks";
import { buildStartInput, toStartFormSpec, type StartFormField } from "@/web/lib/start-form";
import { useEscapeKey } from "@/web/lib/use-escape-key";

const inputClass =
  "w-full border border-border bg-background px-2 py-1.5 text-sm font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The start surface the rescope kept: one dialog in the top bar, no separate
 * Workflows page (D33's form spec comes from the chosen workflow's input
 * schema; anything not renderable falls back to the raw-JSON textarea).
 * 400/404/409 from `POST /api/runs` surface inline, verbatim from the server.
 */
export function NewRunDialog({
  open,
  onClose,
  initial,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Pre-seeds the dialog on a workflow with its raw JSON input, e.g. for "run again". */
  readonly initial?: { readonly workflowId: string; readonly input: unknown };
}) {
  if (!open) return null;
  return <NewRunDialogBody onClose={onClose} initial={initial} />;
}

function NewRunDialogBody({
  onClose,
  initial,
}: {
  readonly onClose: () => void;
  readonly initial?: { readonly workflowId: string; readonly input: unknown };
}) {
  const navigate = useNavigate();
  const startRunMutation = useStartRun();
  const workflows = useWorkflows();
  const [workflowId, setWorkflowId] = useState<string | undefined>(initial?.workflowId);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [jsonMode, setJsonMode] = useState(initial !== undefined);
  const [jsonText, setJsonText] = useState(
    initial !== undefined ? JSON.stringify(initial.input, null, 2) : "{}",
  );
  const [error, setError] = useState<string | undefined>(undefined);

  useEscapeKey(true, onClose);

  const list = workflows.data ?? [];
  const selected: WorkflowSummary | undefined = list.find((w) => w.id === workflowId);
  const spec = useMemo(() => toStartFormSpec(selected?.inputSchema), [selected]);

  const chooseWorkflow = (id: string | undefined) => {
    setWorkflowId(id);
    setValues({});
    setJsonMode(false);
    setJsonText("{}");
    setError(undefined);
  };

  const adoptJsonMode = () => {
    if (spec.kind !== "fields" || selected === undefined) return;
    const built = buildStartInput(spec.fields, values);
    setJsonText("input" in built ? JSON.stringify(built.input, null, 2) : "{}");
    setJsonMode(true);
    setError(undefined);
  };

  const start = () => {
    if (workflowId === undefined) return;
    if (jsonMode || spec.kind === "json") {
      let input: unknown;
      try {
        input = JSON.parse(jsonText);
      } catch {
        setError("invalid JSON");
        return;
      }
      startRunMutation.mutate(
        { workflowId, input },
        {
          onSuccess: (runId) => {
            onClose();
            void navigate({ to: "/runs/$runId", params: { runId } });
          },
          onError: (err) => setError(err instanceof Error ? err.message : String(err)),
        },
      );
      return;
    }
    const built = buildStartInput(spec.fields, values);
    if ("error" in built) {
      setError(built.error);
      return;
    }
    startRunMutation.mutate(
      { workflowId, input: built.input },
      {
        onSuccess: (runId) => {
          onClose();
          void navigate({ to: "/runs/$runId", params: { runId } });
        },
        onError: (err) => setError(err instanceof Error ? err.message : String(err)),
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="absolute inset-0 grid place-items-center p-4">
        <dialog
          data-testid="new-run-dialog"
          open
          aria-labelledby="new-run-title"
          className="absolute top-1/2 left-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 border border-border bg-card p-0 shadow-lg"
        >
          <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <h2 id="new-run-title" className="text-sm font-semibold">
              New run
            </h2>
            <span className="font-mono text-[11px] text-muted-foreground">POST /api/runs</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close dialog"
              onClick={onClose}
              className="ml-auto"
            >
              <X />
            </Button>
          </header>

          <div className="grid gap-4 px-4 py-4">
            <label className="grid gap-1.5">
              <span className="font-mono text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Workflow
              </span>
              <select
                data-testid="new-run-workflow"
                aria-label="Workflow"
                value={workflowId ?? ""}
                onChange={(event) => chooseWorkflow(event.target.value || undefined)}
                className={inputClass}
              >
                <option value="">{workflows.isPending ? "loading…" : "choose a workflow"}</option>
                {list.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.id}
                  </option>
                ))}
              </select>
            </label>

            {!workflows.isPending && list.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No workflows registered. Add them to{" "}
                <code className="font-mono">factory.config.ts</code> and restart the daemon.
              </p>
            ) : null}

            {selected !== undefined && spec.kind === "fields" && !jsonMode ? (
              <StartFormFields
                fields={spec.fields}
                values={values}
                onValue={(name, value) => setValues((previous) => ({ ...previous, [name]: value }))}
              />
            ) : null}

            {selected !== undefined &&
            (spec.kind === "json" || (spec.kind === "fields" && jsonMode)) ? (
              <RawJsonField value={jsonText} onChange={setJsonText} />
            ) : null}

            {error !== undefined ? (
              <p
                data-testid="new-run-error"
                className="font-mono text-[11px] break-words text-status-blocked"
              >
                {error}
              </p>
            ) : null}
          </div>

          <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={jsonMode ? () => setJsonMode(false) : adoptJsonMode}
              disabled={selected === undefined || spec.kind !== "fields"}
              className="font-mono text-[11px]"
            >
              {jsonMode ? "‹ back to fields" : "edit as raw JSON"}
            </Button>
            <Button
              data-testid="new-run-submit"
              size="sm"
              disabled={workflowId === undefined || startRunMutation.isPending}
              onClick={start}
              className="ml-auto font-mono text-[11px]"
            >
              <Plus />
              {startRunMutation.isPending ? "starting…" : "start run"}
            </Button>
          </footer>
        </dialog>
      </div>
    </div>
  );
}

function StartFormFields({
  fields,
  values,
  onValue,
}: {
  readonly fields: ReadonlyArray<StartFormField>;
  readonly values: Readonly<Record<string, string | boolean>>;
  readonly onValue: (name: string, value: string | boolean) => void;
}) {
  return (
    <fieldset className="grid gap-3 border-0 p-0">
      {fields.map((field) => (
        <label key={field.name} className="block">
          <span className="mb-1.5 flex items-baseline gap-2">
            <span className="font-mono text-xs font-medium">{field.name}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{field.type}</span>
            {field.required ? (
              <span className="font-mono text-[10px] text-muted-foreground">required</span>
            ) : (
              <span className="font-mono text-[10px] text-muted-foreground">optional</span>
            )}
          </span>
          {field.type === "boolean" ? (
            <input
              data-testid={`new-run-field-${field.name}`}
              type="checkbox"
              checked={values[field.name] === true}
              onChange={(event) => onValue(field.name, event.target.checked)}
              className="size-4 accent-[var(--primary)]"
            />
          ) : (
            <input
              data-testid={`new-run-field-${field.name}`}
              type={field.type === "number" ? "number" : "text"}
              step="any"
              value={typeof values[field.name] === "string" ? (values[field.name] as string) : ""}
              onChange={(event) => onValue(field.name, event.target.value)}
              className={`${inputClass} w-full`}
            />
          )}
        </label>
      ))}
      {fields.length === 0 ? (
        <p className="text-xs text-muted-foreground">This workflow takes no input.</p>
      ) : null}
    </fieldset>
  );
}

function RawJsonField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (text: string) => void;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="font-mono text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        Input (JSON)
      </span>
      <textarea
        data-testid="new-run-json"
        rows={6}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${inputClass} min-h-32 resize-y`}
        spellCheck={false}
      />
    </label>
  );
}
