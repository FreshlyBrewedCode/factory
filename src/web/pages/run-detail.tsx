import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import type { RunEvent } from "@/web/api";
import { useRun, useRunEvents, useTickingNow } from "@/web/hooks";
import { formatAgo, formatClock, formatDuration } from "@/web/lib/format";
import { deriveRunMeta, deriveSteps, summarizeEvent, type StepView } from "@/web/lib/run-events";
import { runDisplayStatus } from "@/web/lib/status";
import { StatusCell } from "@/web/components/status-cell";
import { cn } from "@/web/lib/utils";

function metaRow(label: string, value: React.ReactNode, mono = false) {
  return (
    <tr key={label}>
      <th className="w-24 px-0 py-1 pr-4 text-left align-top font-mono text-[11px] font-normal whitespace-nowrap text-muted-foreground">
        {label}
      </th>
      <td className={cn("py-1 text-xs break-words", mono && "font-mono text-[11px]")}>{value}</td>
    </tr>
  );
}

function inputSummary(input: unknown): string {
  if (input === undefined || input === null) return "—";
  if (typeof input !== "object") return String(input);
  return Object.entries(input as Record<string, unknown>)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("   ");
}

function outputSummary(output: unknown): React.ReactNode {
  if (output === undefined || output === null) return "—";
  if (typeof output === "object" && output !== null && "prUrl" in output) {
    const prUrl = (output as { prUrl?: unknown }).prUrl;
    if (typeof prUrl === "string") {
      const number = prUrl.split("/").pop() ?? "";
      return (
        <a className="underline" href={prUrl} target="_blank" rel="noreferrer">
          pr #{number}
        </a>
      );
    }
  }
  return <span className="font-mono text-[11px]">{JSON.stringify(output)}</span>;
}

function MetaTable({
  runId,
  workflowId,
  status,
  startedAt,
  finishedAt,
  duration,
  dir,
  input,
  output,
  note,
}: {
  readonly runId: string;
  readonly workflowId: string | undefined;
  readonly status: ReturnType<typeof runDisplayStatus>;
  readonly startedAt: number;
  readonly finishedAt: number | undefined;
  readonly duration: string;
  readonly dir: string | undefined;
  readonly input: unknown;
  readonly output: unknown;
  readonly note: string | undefined;
}) {
  return (
    <table data-testid="run-meta" className="w-full border-collapse">
      <tbody>
        {metaRow("runId", <span className="font-mono text-[11px]">{runId}</span>)}
        {metaRow("workflow", workflowId ?? "—", true)}
        {metaRow("status", <StatusCell status={status} />)}
        {metaRow(
          "started",
          <>
            {formatClock(startedAt)}{" "}
            <span className="text-muted-foreground">· {formatAgo(startedAt)}</span>
          </>,
          true,
        )}
        {finishedAt !== undefined ? metaRow("finished", formatClock(finishedAt), true) : null}
        {metaRow("duration", duration, true)}
        {metaRow("origin", <span className="text-muted-foreground">—</span>)}
        {metaRow("dir", dir ?? "—", true)}
        {metaRow("input", inputSummary(input), true)}
        {metaRow("output", outputSummary(output))}
        {note !== undefined
          ? metaRow("note", <span className="text-muted-foreground">{note}</span>)
          : null}
      </tbody>
    </table>
  );
}

function stepDuration(step: StepView, now: number): string {
  if (step.status === "running" && (step.kind === "agent" || step.kind === "exec")) {
    return formatDuration(now - step.startedTs);
  }
  return formatDuration(step.durationMs);
}

function stepKindLabel(step: StepView): string {
  if (step.kind === "writeback") return "write-back";
  return step.kind;
}

function StepRow({
  step,
  index,
  now,
  selected,
  onSelect,
}: {
  readonly step: StepView;
  readonly index: number;
  readonly now: number;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <div className="step-item">
      <div className="step-index">
        <span className="num" data-status={step.status}>
          {index}
        </span>
      </div>
      <button
        type="button"
        data-testid="step-row"
        data-kind={step.kind}
        data-status={step.status}
        aria-current={selected}
        onClick={onSelect}
        className="step-row"
      >
        <StatusCell status={step.status} />
        <span className="step-kind">{stepKindLabel(step)}</span>
        <span className="step-time" data-testid="step-duration">
          {stepDuration(step, now)}
        </span>
        <span className="step-name">{step.name}</span>
        <span className="step-meta">{step.descriptor}</span>
        <span className="text-right text-muted-foreground">›</span>
      </button>
    </div>
  );
}

function TerminalRow({
  status,
  kind,
  time,
  name,
  meta,
}: {
  readonly status: ReturnType<typeof runDisplayStatus>;
  readonly kind: string;
  readonly time: string;
  readonly name: string;
  readonly meta: string;
}) {
  return (
    <div className="step-item">
      <div className="step-index">
        <span className="num dot" aria-hidden="true" />
      </div>
      <div className="step-row" data-testid="step-row" data-kind={kind} data-status={status}>
        <StatusCell status={status} />
        <span className="step-kind">{kind}</span>
        <span className="step-time" data-testid="step-duration">
          {time}
        </span>
        <span className="step-name">{name}</span>
        <span className="step-meta">{meta}</span>
        <span />
      </div>
    </div>
  );
}

function StepsList({
  steps,
  now,
  selectedKey,
  onSelect,
  terminal,
}: {
  readonly steps: ReadonlyArray<StepView>;
  readonly now: number;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string) => void;
  readonly terminal: React.ReactNode;
}) {
  return (
    <div data-testid="steps-list" className="grid gap-1.5">
      {steps.map((step, index) => (
        <StepRow
          key={step.key}
          step={step}
          index={index + 1}
          now={now}
          selected={selectedKey === step.key}
          onSelect={() => onSelect(step.key)}
        />
      ))}
      {terminal}
    </div>
  );
}

function Disclosure({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <details className="border border-border bg-muted/40">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 font-mono text-[11px]">
        <span>{label}</span>
        {hint !== undefined ? <span className="ml-auto text-muted-foreground">{hint}</span> : null}
      </summary>
      <div className="border-t border-border px-3 py-2 font-mono text-[11px] break-words whitespace-pre-wrap text-muted-foreground">
        {children}
      </div>
    </details>
  );
}

function JsonBlock({ value }: { readonly value: unknown }) {
  return (
    <pre className="max-h-60 overflow-auto border border-border bg-muted/40 p-3 font-mono text-[11px] break-words whitespace-pre-wrap">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function fieldRow(label: string, value: React.ReactNode) {
  return (
    <div key={label} className="flex gap-3 text-xs">
      <span className="w-24 flex-none font-mono text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 font-mono text-[11px] break-all">{value}</span>
    </div>
  );
}

/** Progressive step detail: summary fields, then collapsed disclosures. The transcript is S4. */
function StepDetails({ step }: { readonly step: StepView }) {
  const fields: Array<React.ReactNode> = [];
  switch (step.kind) {
    case "agent":
      fields.push(
        fieldRow("stepId", step.stepId),
        fieldRow("model", step.model),
        fieldRow("structured", String(step.structured)),
        fieldRow("outcome", <StatusCell status={step.status} />),
        fieldRow("chunks", String(step.chunkCount)),
        fieldRow("duration", formatDuration(step.durationMs)),
        fieldRow("sessionId", step.sessionId ?? "—"),
      );
      break;
    case "exec":
      fields.push(
        fieldRow("execId", step.execId),
        fieldRow("command", step.command.join(" ")),
        fieldRow("cwd", step.cwd),
        fieldRow("exit", step.exitCode === undefined ? "—" : String(step.exitCode)),
        fieldRow("duration", formatDuration(step.durationMs)),
      );
      break;
    case "assert":
      fields.push(
        fieldRow("name", step.name),
        fieldRow("result", <StatusCell status={step.status} />),
      );
      break;
    case "writeback":
      fields.push(
        fieldRow("branch", step.branch),
        fieldRow("outcome", <StatusCell status={step.status} />),
        fieldRow("staged", step.stagedPaths.join(", ") || "—"),
        fieldRow("cleaned", step.cleanedArtifacts.join(", ") || "none"),
        ...(step.error !== undefined ? [fieldRow("error", step.error)] : []),
      );
      break;
    case "log":
      fields.push(fieldRow("name", step.name));
      break;
  }

  const disclosures: Array<React.ReactNode> = [];
  if (step.kind === "agent") {
    if (step.output !== undefined) {
      disclosures.push(
        <Disclosure key="output" label="Structured output">
          <JsonBlock value={step.output} />
        </Disclosure>,
      );
    }
    if (step.finalText !== undefined && step.finalText !== "") {
      disclosures.push(
        <Disclosure key="final" label="Final text">
          {step.finalText}
        </Disclosure>,
      );
    }
    if (step.error !== undefined) {
      disclosures.push(
        <Disclosure key="error" label="Error">
          {step.error}
        </Disclosure>,
      );
    }
  } else if (step.kind === "exec") {
    disclosures.push(
      <Disclosure key="output" label="Output">
        {step.stdout ?? ""}
        {step.stderr ? `\n${step.stderr}` : ""}
      </Disclosure>,
    );
  } else if (step.kind === "assert" && step.details !== undefined) {
    disclosures.push(
      <Disclosure key="details" label="Details">
        <JsonBlock value={step.details} />
      </Disclosure>,
    );
  } else if (step.kind === "writeback") {
    if (step.prUrl !== undefined) {
      disclosures.push(
        <Disclosure key="pr" label="Pull request">
          <a className="underline" href={step.prUrl} target="_blank" rel="noreferrer">
            {step.prUrl}
          </a>
        </Disclosure>,
      );
    }
  } else if (step.kind === "log") {
    disclosures.push(
      <Disclosure key="data" label="Data">
        <JsonBlock value={step.data} />
      </Disclosure>,
    );
  }

  return (
    <div data-testid="step-detail" className="grid gap-4">
      <section className="grid gap-2">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Fields
        </span>
        <div className="grid gap-1.5">{fields}</div>
      </section>
      <section className="grid gap-2">
        {disclosures}
        <Disclosure label="Raw payload" hint="step view">
          <JsonBlock value={step} />
        </Disclosure>
      </section>
    </div>
  );
}

function EventsTable({ events }: { readonly events: ReadonlyArray<RunEvent> }) {
  return (
    <table data-testid="events-table" className="w-full border-collapse text-xs">
      <thead>
        <tr className="border-b border-border text-left">
          {["seq", "ts", "tag", "summary"].map((heading) => (
            <th
              key={heading}
              className="sticky top-0 bg-background px-3 py-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
            >
              {heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {events.map((event) => (
          <tr
            key={event.seq}
            data-testid="event-row"
            data-tag={event.payload._tag}
            className="border-b border-border align-top"
          >
            <td className="px-3 py-1.5 font-mono text-[11px]">{event.seq}</td>
            <td className="px-3 py-1.5 font-mono text-[11px]">{formatClock(event.ts)}</td>
            <td className="px-3 py-1.5 font-mono text-[11px] font-medium">{event.payload._tag}</td>
            <td className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
              {summarizeEvent(event)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Keyed by `runId` so the SSE subscription's accumulated state resets per run. */
export function RunDetailPage() {
  const { runId } = useParams({ from: "/runs/$runId" });
  return <RunDetailView key={runId} runId={runId} />;
}

function RunDetailView({ runId }: { readonly runId: string }) {
  const runQuery = useRun(runId);
  const { events, streaming } = useRunEvents(runId);
  const [tab, setTab] = useState<"steps" | "events">("steps");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const run = runQuery.data;
  const meta = deriveRunMeta(events);
  // `streaming` is the live truth: the SSE stream closes on the terminal event
  // (or when the process no longer holds the run). The summary fetched on mount
  // can be stale once a run finishes under the page, so events win.
  const active = streaming;
  const now = useTickingNow(active);
  const steps = deriveSteps(events, { active });
  const selected = steps.find((step) => step.key === selectedKey) ?? null;

  const status: ReturnType<typeof runDisplayStatus> =
    meta.terminalTag === "RunFinished"
      ? "finished"
      : meta.terminalTag === "RunFailed"
        ? "failed"
        : meta.terminalTag === "RunCancelled"
          ? "cancelled"
          : active
            ? "running"
            : run !== undefined
              ? runDisplayStatus({ active: false, status: run.status })
              : "interrupted";

  const startedAt = run?.startedAt ?? events[0]?.ts ?? 0;
  const finishedAt = meta.finishedAt ?? run?.finishedAt;
  const duration = active
    ? formatDuration(now - startedAt)
    : meta.durationMs !== undefined
      ? formatDuration(meta.durationMs)
      : finishedAt !== undefined
        ? formatDuration(finishedAt - startedAt)
        : "—";

  const terminal =
    meta.terminalTag === "RunFailed" ? (
      <TerminalRow status="failed" kind="run" time="—" name={meta.error ?? "RunFailed"} meta="" />
    ) : meta.terminalTag === "RunCancelled" ? (
      <TerminalRow status="cancelled" kind="run" time="—" name="run cancelled" meta="" />
    ) : meta.terminalTag === "RunFinished" ? (
      <TerminalRow status="finished" kind="run" time={duration} name="RunFinished" meta="" />
    ) : status === "interrupted" ? (
      <TerminalRow
        status="interrupted"
        kind="run"
        time="—"
        name="process died mid-run"
        meta="no terminal event"
      />
    ) : null;

  return (
    <section data-testid="run-detail" className="flex min-h-full flex-col">
      <header className="border-b border-border px-5 pt-4 pb-3">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Link
            to="/"
            className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            ‹ runs
          </Link>
          <span className="font-mono text-base font-semibold">{runId}</span>
          <StatusCell status={status} />
          {active ? (
            <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              <i className="status-dot status-pulse" data-status="running" aria-hidden="true" />
              replay-then-tail · connected
            </span>
          ) : (
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
              stream closed · {events.length} events replayed
            </span>
          )}
        </div>
        <MetaTable
          runId={runId}
          workflowId={run?.workflowId ?? meta.workflowId}
          status={status}
          startedAt={startedAt}
          finishedAt={finishedAt}
          duration={duration}
          dir={meta.dir ?? run?.dir}
          input={meta.input}
          output={meta.output}
          note={status === "interrupted" ? "no terminal event — process died mid-run" : undefined}
        />
      </header>

      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/90 px-5 py-2 backdrop-blur">
        <div role="tablist" className="inline-flex gap-0.5 rounded-xl bg-muted p-1">
          {(["steps", "events"] as const).map((value) => (
            <button
              key={value}
              role="tab"
              type="button"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={cn(
                "rounded-lg px-3 py-1 text-xs capitalize",
                tab === value
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {value}
            </button>
          ))}
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">
          GET /api/runs/{runId}/events
        </span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 p-4">
          {tab === "steps" ? (
            steps.length === 0 && !active ? (
              <p className="py-12 text-center text-sm text-muted-foreground">No steps recorded.</p>
            ) : (
              <StepsList
                steps={steps}
                now={now}
                selectedKey={selectedKey}
                onSelect={setSelectedKey}
                terminal={terminal}
              />
            )
          ) : (
            <EventsTable events={events} />
          )}
        </div>

        <aside className="min-w-0 border-t border-border p-4 xl:border-t-0 xl:border-l">
          {selected !== null ? (
            <StepDetails step={selected} />
          ) : (
            <div className="grid gap-2">
              <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Run overview
              </span>
              <p className="font-mono text-[11px] text-muted-foreground">
                Select a step for its fields and payload disclosures. The transcript arrives in S4.
              </p>
              {meta.sessions.length > 0 ? (
                <div className="mt-2 grid gap-1">
                  <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    Sessions · fresh per step (D10)
                  </span>
                  {meta.sessions.map((session) => (
                    <div
                      key={`${session.name}:${session.sessionId}`}
                      className="flex gap-2 font-mono text-[11px]"
                    >
                      <span className="w-20 text-muted-foreground">{session.name}</span>
                      <span>{session.sessionId}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
