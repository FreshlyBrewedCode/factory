import { useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { PanelRight, X } from "lucide-react";
import type { RunEvent } from "@/web/api";
import { CancelRunButton } from "@/web/components/cancel-run-button";
import { Button } from "@/web/components/ui/button";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/web/components/ui/message-scroller";
import { useRun, useRunEvents, useTickingNow } from "@/web/hooks";
import { formatAgo, formatClock, formatDuration } from "@/web/lib/format";
import {
  deriveRunMeta,
  deriveSteps,
  summarizeEvent,
  type AgentStepView,
  type StepView,
} from "@/web/lib/run-events";
import { deriveTranscript, toTranscriptRows, type TranscriptRow } from "@/web/lib/transcript";
import { runDetailStatus, type RunDisplayStatus } from "@/web/lib/status";
import { StatusCell } from "@/web/components/status-cell";
import { useEscapeKey } from "@/web/lib/use-escape-key";
import { useMediaQuery } from "@/web/lib/use-media-query";
import { cn } from "@/web/lib/utils";

function metaRow(label: string, value: React.ReactNode, mono = false) {
  return (
    <tr key={label}>
      <th className="w-24 px-0 py-1 pr-4 text-left align-top font-mono text-[11px] font-normal whitespace-nowrap text-muted-foreground">
        {label}
      </th>
      <td className={cn("py-1 min-w-0 text-xs break-words", mono && "font-mono text-[11px]")}>
        {value}
      </td>
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
  readonly status: RunDisplayStatus;
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

/*
 * The step row: six columns >559px pane-width (status | kind | time | name |
 * descriptor | chevron), stacked full-width lines below that. The pane is a
 * named size container (`@container/steps`) so the compact layout reacts to
 * the pane's real width — the inspector aside can steal half of it on
 * desktop, which a viewport query cannot see. Grid areas re-order the
 * compact layout; wide layout is plain auto-flow.
 */
const STEP_ROW = [
  "grid w-full items-center gap-x-3 border border-l-[3px] bg-card px-3.5 py-2.5 text-left",
  "grid-cols-[112px_76px_64px_minmax(0,1fr)_auto_18px]",
  "border-l-(--status)",
  "@max-[559px]/steps:grid-cols-[minmax(0,1fr)_auto_auto]",
  "@max-[559px]/steps:gap-y-0.5",
  "@max-[559px]/steps:px-3",
  "@max-[559px]/steps:[grid-template-areas:'status_kind_time'_'name_name_name'_'meta_meta_meta']",
].join(" ");

const STEP_AREA_STATUS = "@max-[559px]/steps:[grid-area:status]";
const STEP_AREA_KIND = "@max-[559px]/steps:[grid-area:kind]";
const STEP_AREA_TIME = "@max-[559px]/steps:[grid-area:time] @max-[559px]/steps:justify-self-end";
const STEP_AREA_NAME = "@max-[559px]/steps:[grid-area:name]";
const STEP_AREA_META =
  "@max-[559px]/steps:[grid-area:meta] @max-[559px]/steps:max-w-none @max-[559px]/steps:text-left";
const STEP_CHEVRON = "text-right text-muted-foreground @max-[559px]/steps:hidden";
// Indexed step spine (finding 7): numbered nodes connected by a hairline.
const STEP_SPINE =
  "relative flex items-start justify-center after:absolute after:top-8 after:-bottom-[7px] after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border-strong group-last/step:after:hidden";
const STEP_ROW_SELECTED = "outline-solid outline-2 outline-(--ring) outline-offset-1";

function KindSpan({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: string;
}) {
  return (
    <span
      className={cn(
        "text-[11px] font-semibold tracking-[0.025em] whitespace-nowrap uppercase text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
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
    <div className="group/step relative grid grid-cols-[24px_minmax(0,1fr)] gap-3">
      <div className={STEP_SPINE}>
        <span
          data-status={step.status}
          className="relative z-[1] mt-2.5 grid size-[22px] place-items-center rounded-full border bg-card font-mono text-[10px] font-medium text-(--status) border-(--status)"
        >
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
        className={cn(STEP_ROW, selected && STEP_ROW_SELECTED)}
      >
        <StatusCell status={step.status} className={STEP_AREA_STATUS} />
        <KindSpan className={STEP_AREA_KIND}>{stepKindLabel(step)}</KindSpan>
        <span
          className={cn("whitespace-nowrap font-mono text-[11px]", STEP_AREA_TIME)}
          data-testid="step-duration"
        >
          {stepDuration(step, now)}
        </span>
        <span
          title={step.name}
          className={cn(
            "min-w-0 overflow-hidden font-mono text-xs font-medium text-ellipsis whitespace-nowrap",
            STEP_AREA_NAME,
          )}
        >
          {step.name}
        </span>
        <span
          title={step.descriptor}
          className={cn(
            "max-w-[32ch] min-w-0 overflow-hidden text-right font-mono text-[11px] whitespace-nowrap text-ellipsis text-muted-foreground",
            STEP_AREA_META,
          )}
        >
          {step.descriptor}
        </span>
        <span className={STEP_CHEVRON}>›</span>
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
  readonly status: RunDisplayStatus;
  readonly kind: string;
  readonly time: string;
  readonly name: string;
  readonly meta: string;
}) {
  return (
    <div className="group/step relative grid grid-cols-[24px_minmax(0,1fr)] gap-3">
      <div className={STEP_SPINE}>
        <span aria-hidden="true" className="mt-[18px] size-2 rounded-full bg-border" />
      </div>
      <div className={STEP_ROW} data-testid="step-row" data-kind={kind} data-status={status}>
        <StatusCell status={status} className={STEP_AREA_STATUS} />
        <KindSpan className={STEP_AREA_KIND}>{kind}</KindSpan>
        <span
          className={cn("whitespace-nowrap font-mono text-[11px]", STEP_AREA_TIME)}
          data-testid="step-duration"
        >
          {time}
        </span>
        <span
          title={name}
          className={cn(
            "min-w-0 overflow-hidden font-mono text-xs font-medium text-ellipsis whitespace-nowrap",
            STEP_AREA_NAME,
          )}
        >
          {name}
        </span>
        <span
          title={meta}
          className={cn(
            "max-w-[32ch] min-w-0 overflow-hidden text-right font-mono text-[11px] whitespace-nowrap text-ellipsis text-muted-foreground",
            STEP_AREA_META,
          )}
        >
          {meta}
        </span>
        <span className={STEP_CHEVRON} />
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
  testId,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly testId?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <details data-testid={testId} className="border border-border bg-muted/40">
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

/** Exec output, styled as a terminal — always dark, regardless of the app theme. */
function Terminal({
  command,
  stdout,
  stderr,
}: {
  readonly command: ReadonlyArray<string>;
  readonly stdout: string;
  readonly stderr: string;
}) {
  return (
    <div className="bg-term-bg border text-term-fg">
      <div className="flex items-center gap-2 border-b border-b-[oklch(1_0_0/12%)] px-3 py-2 font-mono text-[11px]">
        <span className="font-semibold text-status-ready">$</span>
        <span>{command.join(" ")}</span>
      </div>
      <pre className="m-0 max-h-80 overflow-y-auto px-3 py-2.5 font-mono text-[11px] whitespace-pre-wrap break-words">
        {stdout}
        {stderr ? <span className="text-status-blocked">{`\n${stderr}`}</span> : null}
      </pre>
    </div>
  );
}

function JsonBlock({ value }: { readonly value: unknown }) {
  return (
    <pre className="max-h-60 overflow-auto border border-border bg-muted/40 p-3 font-mono text-[11px] break-words whitespace-pre-wrap">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** One transcript part: prose for text, the shared disclosure for the rest. */
function TranscriptRowView({ row }: { readonly row: TranscriptRow }) {
  switch (row.kind) {
    case "text":
      return (
        <p
          data-testid="transcript-text"
          className="text-xs leading-relaxed break-words whitespace-pre-wrap"
        >
          {row.content}
        </p>
      );
    case "thinking":
      return (
        <Disclosure testId="transcript-reasoning" label="Reasoning">
          {row.content}
        </Disclosure>
      );
    case "tool-call":
      return (
        <Disclosure testId="transcript-tool" label={row.name} hint={row.state}>
          {row.args !== "" ? <div data-testid="transcript-tool-args">{row.args}</div> : null}
          {row.result !== undefined ? (
            <div
              data-testid="transcript-tool-result"
              className={cn("mt-2", row.isError && "text-status-blocked")}
            >
              {row.result}
            </div>
          ) : null}
        </Disclosure>
      );
    case "structured-output":
      return (
        <Disclosure
          testId="transcript-structured-output"
          label="Structured output"
          hint={row.status}
        >
          <JsonBlock value={row.data} />
        </Disclosure>
      );
  }
}

/**
 * Full-panel transcript (finding 7): the step's original prompt at the top,
 * then the message stream, with a back control. The `message-scroller` owns the
 * scroll; `autoScroll` only while the step is live so a reader can scroll back
 * without being yanked to the edge. `defaultScrollPosition="start"` opens a
 * saved transcript at the prompt.
 */
function TranscriptPanel({
  step,
  events,
  onBack,
}: {
  readonly step: AgentStepView;
  readonly events: ReadonlyArray<RunEvent>;
  readonly onBack: () => void;
}) {
  const { prompt, messages } = useMemo(
    () => deriveTranscript(events, step.stepId),
    [events, step.stepId],
  );
  const rows = useMemo(() => toTranscriptRows(messages), [messages]);
  const live = step.status === "running";

  return (
    <div data-testid="transcript" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <button
          type="button"
          data-testid="transcript-back"
          onClick={onBack}
          className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
        >
          ‹ {step.name}
        </button>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">transcript</span>
      </div>
      <MessageScrollerProvider defaultScrollPosition="start" autoScroll={live}>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-3 p-4">
              <MessageScrollerItem messageId="prompt" scrollAnchor>
                <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Prompt
                </span>
                <div
                  data-testid="transcript-prompt"
                  className="mt-1.5 border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap"
                >
                  {prompt}
                </div>
              </MessageScrollerItem>
              {rows.map((row, index) => (
                <MessageScrollerItem key={`${row.kind}-${index}`} messageId={`row-${index}`}>
                  <TranscriptRowView row={row} />
                </MessageScrollerItem>
              ))}
              {live ? (
                <span className="font-mono text-[11px] text-muted-foreground">streaming…</span>
              ) : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
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

/** Progressive step detail: summary fields, then collapsed disclosures, then the transcript. */
function StepDetails({
  step,
  onOpenTranscript,
}: {
  readonly step: StepView;
  readonly onOpenTranscript?: () => void;
}) {
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
        <Terminal command={step.command} stdout={step.stdout ?? ""} stderr={step.stderr ?? ""} />
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
        {step.kind === "agent" && onOpenTranscript !== undefined ? (
          <button
            type="button"
            data-testid="open-transcript"
            onClick={onOpenTranscript}
            className="flex w-full items-center gap-2 border border-border bg-muted/40 px-3 py-2 text-left font-mono text-[11px] hover:text-foreground"
          >
            <span>Transcript</span>
            <span className="ml-auto text-muted-foreground">prompt + {step.chunkCount} chunks</span>
          </button>
        ) : null}
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
            <td className="px-3 py-1.5 font-mono text-[11px] break-words text-muted-foreground">
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

const INSPECTOR_COMPACT_QUERY = "(max-width: 1199px)";

function RunDetailView({ runId }: { readonly runId: string }) {
  const runQuery = useRun(runId);
  const { events, streaming } = useRunEvents(runId);
  const [tab, setTab] = useState<"steps" | "events">("steps");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const inspectorCompact = useMediaQuery(INSPECTOR_COMPACT_QUERY);
  const closeInspector = () => {
    setInspectorOpen(false);
    setTranscriptOpen(false);
  };
  const selectStep = (key: string) => {
    setSelectedKey(key);
    setInspectorOpen(true);
    setTranscriptOpen(false);
  };

  useEscapeKey(inspectorCompact && inspectorOpen, closeInspector);

  const run = runQuery.data;
  const meta = deriveRunMeta(events);
  // Three sources, one answer — see `runDetailStatus`. In particular the run
  // stays live while *either* the stream is open or the polled summary says the
  // server still holds it, so a dropped connection no longer reads as a dead run.
  const status = runDetailStatus({ terminalTag: meta.terminalTag, streaming, summary: run });
  const active = status === "running";
  const now = useTickingNow(active);
  const steps = deriveSteps(events, { active });
  const selected = steps.find((step) => step.key === selectedKey) ?? null;

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

  const showAside = selected !== null && inspectorOpen;
  const desktopAside = showAside && !inspectorCompact;
  const mobileSheet = showAside && inspectorCompact;

  const selectedAgent = selected?.kind === "agent" ? selected : null;
  const inspectorBody =
    selected === null ? null : transcriptOpen && selectedAgent !== null ? (
      <TranscriptPanel
        step={selectedAgent}
        events={events}
        onBack={() => setTranscriptOpen(false)}
      />
    ) : (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <StepDetails
          step={selected}
          onOpenTranscript={selected.kind === "agent" ? () => setTranscriptOpen(true) : undefined}
        />
      </div>
    );

  return (
    <section data-testid="run-detail" className="flex h-full min-h-0 overflow-hidden">
      {/*
       * The whole main column scrolls as one page (header, tabs, steps), so a
       * tall overview can scroll away instead of pinning the steps. The aside
       * stays height-bound with its own internal scroll.
       */}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="shrink-0 border-b border-border px-5 pt-4 pb-3">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Link
              to="/"
              className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            >
              ‹ runs
            </Link>
            <span className="min-w-0 font-mono text-base font-semibold break-all">{runId}</span>
            <StatusCell status={status} />
            {active ? <CancelRunButton runId={runId} /> : null}
            {/*
             * The connection indicator reports the *connection*, not the run:
             * with reconnect in place these can legitimately disagree for a
             * moment (a live run whose stream is mid-retry), and saying
             * "connected" then would be a lie.
             */}
            {streaming ? (
              <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                <i
                  className="motion-reduce:animate-none animate-status-pulse size-[7px] flex-none rounded-full bg-(--status)"
                  data-status="running"
                  aria-hidden="true"
                />
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

        <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-2">
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
          <span className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground lg:inline">
            GET /api/runs/{runId}/events
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={inspectorOpen ? "Close inspector" : "Open inspector"}
            aria-expanded={inspectorOpen}
            disabled={selected === null}
            onClick={() => setInspectorOpen((value) => !value)}
            className="ml-auto"
          >
            <PanelRight />
          </Button>
        </div>

        <div className="min-w-0 flex-1 p-4 @container/steps">
          {tab === "steps" ? (
            steps.length === 0 && !active ? (
              <p className="py-12 text-center text-sm text-muted-foreground">No steps recorded.</p>
            ) : (
              <StepsList
                steps={steps}
                now={now}
                selectedKey={selectedKey}
                onSelect={selectStep}
                terminal={terminal}
              />
            )
          ) : (
            <EventsTable events={events} />
          )}
        </div>
      </div>

      {desktopAside && selected !== null ? (
        <aside className="flex h-full w-[22rem] shrink-0 flex-col overflow-hidden border-l border-border">
          {inspectorBody}
        </aside>
      ) : null}

      {mobileSheet ? (
        <div
          className="fixed top-14 right-0 bottom-0 left-0 z-40 bg-black/40"
          onClick={closeInspector}
          aria-hidden="true"
        />
      ) : null}
      {selected !== null && inspectorOpen && inspectorCompact ? (
        <aside className="fixed top-14 right-0 bottom-0 z-50 flex w-full max-w-sm flex-col overflow-hidden border-l border-border bg-card shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              Step detail
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close inspector"
              onClick={closeInspector}
            >
              <X />
            </Button>
          </div>
          {inspectorBody}
        </aside>
      ) : null}
    </section>
  );
}
