/**
 * Phase 3's HTTP API + SSE replay (D22: plain `Bun.serve`, not Effect — the
 * same reasoning as D21's `store.ts`, request/response handling here is
 * synchronous callback-shaped with nothing for Effect to bridge; Effect's
 * job in the daemon is the scheduler's loop, `src/server/scheduler.ts`).
 *
 * Routes:
 *   GET  /api/workflows          -> [{id, inputSchema}] from the config (D30)
 *   GET  /api/runs              -> RunSummary[]              (`listRuns`)
 *   GET  /api/runs/:id          -> RunSummary | 404
 *   POST /api/runs              -> {runId}, starts a run      (`startTrackedRun`)
 *   POST /api/runs/:id/cancel   -> {runId, cancelled} | 409 (not active)
 *   GET  /api/runs/:id/events   -> SSE: persisted history, then live tail
 *   GET  /                      -> the phase 4 SPA (all non-API paths)
 *
 * Since phase 4, `serve()` is the composition root: the API handler is mounted
 * under `/api/*` and Bun's fullstack bundler serves `src/web/index.html` at `/`
 * and every other path (`/*`), so a client-side route deep link still gets the
 * SPA shell. Both live on one origin, which is why CORS never has to exist.
 * The route precedence — `/api/*` beating `/*` — is Bun's, exercised by
 * `http.test.ts`.
 *
 * SSE replay-then-tail race: `sseStream` subscribes to the live pubsub
 * *before* reading `getRunEvents`, buffering anything that arrives in
 * between, then drains the buffer de-duplicated by `seq` once the persisted
 * read completes. Without this ordering a live event emitted between the
 * subscribe and the read could be lost.
 *
 * #38: the handler receives DaemonServices (registry, pubsub, dedupe) as
 * required parameters rather than accessing module-level singletons.
 */

import type { Database } from "bun:sqlite";
import { isTerminal, type RunEvent } from "../events";
import type { FactoryConfig } from "../config";
import { Schema, SchemaParser } from "effect";
import { resetClone, type GitIdentity } from "../lib/clone";
import { loadWorkflow } from "../lib/load-workflow";
import { getRunEvents, listRuns, type RunSummary } from "../persistence/store";
import type { AgentAdapter } from "../runtime/agent-adapter";
import index from "../web/index.html";
import { admitRun } from "./admission";
import { DedupeKeyError } from "../lib/dedupe";
import {
  ConcurrencyLimitError,
  type DaemonServices,
  type DispatchEnv,
  type StartTrackedRunOptions,
  startTrackedRun,
} from "./runs";
import { nextFireAt, toRuntimeSchedules } from "./scheduler";

export interface ScheduleSummary {
  readonly id: string;
  readonly workflowId: string;
  readonly input: unknown;
  readonly cron: string;
  readonly timezone: string;
  readonly overlap: "skip" | "stack";
  readonly runOnStart: boolean;
  readonly nextFireAt: number;
  readonly lastRun:
    | { readonly runId: string; readonly status: string; readonly startedAt: number }
    | undefined;
}

export interface ServerOptions {
  readonly db: Database;
  readonly adapter: AgentAdapter;
  readonly services: DaemonServices;
  readonly config?: FactoryConfig;
  readonly sseKeepaliveMs?: number;
}

const DEFAULT_SSE_KEEPALIVE_MS = 5_000;

export type RunSummaryResponse = RunSummary & { readonly active: boolean };

function listSummaries(db: Database, services: DaemonServices): ReadonlyArray<RunSummaryResponse> {
  return listRuns(db).map((run) => ({ ...run, active: services.registry.isActive(run.runId) }));
}

function dispatchEnvFor(config: FactoryConfig, adapter: AgentAdapter): DispatchEnv {
  return {
    workspace: {
      workspaceRoot: config.workspaceRoot,
      sshUrl: config.repo.sshUrl,
      identity: config.repo.identity,
      retainedWorkspaces: config.retainedWorkspaces,
    },
    repo: { slug: config.repo.slug, baseBranch: config.repo.baseBranch },
    maxConcurrentRuns: config.maxConcurrentRuns,
    adapter,
    maxDispatchDepth: config.maxDispatchDepth,
    maxChildrenPerRun: config.maxChildrenPerRun,
  };
}

function configRunOptions(
  config: FactoryConfig,
  adapter: AgentAdapter,
  maxConcurrentRuns: number | undefined,
  extra: {
    readonly scheduleId?: string;
    readonly dedupeKey?: string;
    readonly agentOverrides?: { readonly model?: string };
  } = {},
): Omit<StartTrackedRunOptions, "input" | "adapter"> {
  return {
    workspace: {
      workspaceRoot: config.workspaceRoot,
      sshUrl: config.repo.sshUrl,
      identity: config.repo.identity,
      retainedWorkspaces: config.retainedWorkspaces,
    },
    repo: { slug: config.repo.slug, baseBranch: config.repo.baseBranch },
    maxConcurrentRuns,
    dispatchEnv: dispatchEnvFor(config, adapter),
    ...(extra.scheduleId !== undefined ? { scheduleId: extra.scheduleId } : {}),
    ...(extra.dedupeKey !== undefined ? { dedupeKey: extra.dedupeKey } : {}),
    ...(extra.agentOverrides !== undefined ? { agentOverrides: extra.agentOverrides } : {}),
  };
}

interface StartRunBody {
  readonly workflowId?: unknown;
  readonly workflowPath?: unknown;
  readonly input?: unknown;
  readonly dedupeKey?: unknown;
  readonly dir?: string;
  readonly clone?: { readonly sshUrl: string; readonly identity: GitIdentity };
}

function json(body: unknown, init?: { readonly status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status,
    headers: { "content-type": "application/json" },
  });
}

function parseLastEventId(req: Request): number | undefined {
  const raw = req.headers.get("last-event-id");
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

function sseStream(
  db: Database,
  services: DaemonServices,
  runId: string,
  lastEventId?: number,
  keepaliveMs: number = DEFAULT_SSE_KEEPALIVE_MS,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  let closed = false;
  let unsubscribe: () => void = () => undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const stopKeepalive = (): void => {
    if (keepalive !== undefined) clearInterval(keepalive);
    keepalive = undefined;
  };

  return new ReadableStream({
    start(controller) {
      let lastSeq = lastEventId ?? -1;
      let draining = false;
      const buffered: Array<RunEvent> = [];

      const send = (event: RunEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          closed = true;
          stopKeepalive();
          unsubscribe();
          return;
        }
        lastSeq = event.seq;
      };

      const finish = (): void => {
        if (closed) return;
        closed = true;
        stopKeepalive();
        unsubscribe();
        controller.close();
      };

      unsubscribe = services.pubsub.subscribe(runId, (event) => {
        if (!draining) {
          buffered.push(event);
          return;
        }
        if (event.seq <= lastSeq) return;
        send(event);
        if (isTerminal(event.payload)) finish();
      });

      for (const event of getRunEvents(db, runId)) {
        if (event.seq <= lastSeq) continue;
        send(event);
      }

      draining = true;
      let sawTerminal = false;
      for (const event of buffered) {
        if (event.seq <= lastSeq) continue;
        send(event);
        if (isTerminal(event.payload)) sawTerminal = true;
      }

      if (sawTerminal || !services.registry.isActive(runId)) {
        finish();
        return;
      }

      keepalive = setInterval(() => {
        if (closed) {
          stopKeepalive();
          return;
        }
        try {
          controller.enqueue(encoder.encode(":keepalive\n\n"));
        } catch {
          closed = true;
          stopKeepalive();
          unsubscribe();
        }
      }, keepaliveMs);
    },
    cancel(): void {
      closed = true;
      stopKeepalive();
      unsubscribe();
    },
  });
}

export function createHandler(options: ServerOptions): (req: Request) => Promise<Response> {
  const services = options.services;
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/api/runs") {
      return json(listSummaries(options.db, services));
    }

    if (req.method === "GET" && url.pathname === "/api/workflows") {
      return json(
        (options.config?.workflows ?? []).map((workflow) => ({
          id: workflow.id,
          inputSchema: Schema.toJsonSchemaDocument(workflow.input).schema,
        })),
      );
    }

    if (req.method === "POST" && url.pathname === "/api/runs") {
      const maxConcurrentRuns = options.config?.maxConcurrentRuns;
      if (
        maxConcurrentRuns !== undefined &&
        !admitRun(maxConcurrentRuns, services.registry.activeRunIds().length)
      ) {
        return json(
          { error: `concurrency limit reached (max ${maxConcurrentRuns} concurrent runs)` },
          { status: 409 },
        );
      }

      let body: StartRunBody;
      try {
        body = (await req.json()) as StartRunBody;
      } catch {
        return json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.workflowId === "string") {
        if (
          body.dedupeKey !== undefined &&
          (typeof body.dedupeKey !== "string" || body.dedupeKey === "")
        ) {
          return json({ error: "dedupeKey must be a non-empty string" }, { status: 400 });
        }
        const registry = options.config?.workflows ?? [];
        const workflow = registry.find((w) => w.id === body.workflowId);
        const runEnv = options.config;
        if (workflow === undefined || runEnv === undefined) {
          return json(
            { error: `unknown workflow id: ${body.workflowId} (see GET /api/workflows)` },
            { status: 404 },
          );
        }

        let decodedInput: unknown;
        try {
          decodedInput = SchemaParser.decodeUnknownSync(workflow.input)(body.input);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return json(
            { error: `input failed workflow "${workflow.id}" schema decode: ${message}` },
            { status: 400 },
          );
        }

        const startOptions: StartTrackedRunOptions = {
          ...configRunOptions(runEnv, options.adapter, maxConcurrentRuns, {
            dedupeKey: typeof body.dedupeKey === "string" ? body.dedupeKey : undefined,
          }),
          input: decodedInput,
          adapter: options.adapter,
        };
        let runId: string;
        try {
          runId = await startTrackedRun(options.db, services, workflow, startOptions);
        } catch (err) {
          if (err instanceof ConcurrencyLimitError) {
            return json({ error: err.message }, { status: 409 });
          }
          if (err instanceof DedupeKeyError) {
            return json(
              { error: err.message, dedupeKey: err.key, holderRunId: err.holderRunId },
              { status: 409 },
            );
          }
          throw err;
        }
        return json({ runId }, { status: 201 });
      }

      if (typeof body.workflowPath !== "string") {
        return json({ error: "workflowPath (string) is required" }, { status: 400 });
      }
      if (
        body.dedupeKey !== undefined &&
        (typeof body.dedupeKey !== "string" || body.dedupeKey === "")
      ) {
        return json({ error: "dedupeKey must be a non-empty string" }, { status: 400 });
      }
      if (typeof body.dir !== "string" && options.config === undefined) {
        return json({ error: "dir (string) is required" }, { status: 400 });
      }

      let workflow;
      try {
        workflow = await loadWorkflow(body.workflowPath);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }

      if (body.clone !== undefined && typeof body.dir === "string") {
        await resetClone(body.dir, body.clone.sshUrl, body.clone.identity);
      }

      const runEnv = options.config;
      const startOptions: StartTrackedRunOptions = {
        dir: body.dir,
        workspace:
          runEnv === undefined
            ? undefined
            : {
                workspaceRoot: runEnv.workspaceRoot,
                sshUrl: runEnv.repo.sshUrl,
                identity: runEnv.repo.identity,
                retainedWorkspaces: runEnv.retainedWorkspaces,
              },
        repo:
          runEnv === undefined
            ? undefined
            : { slug: runEnv.repo.slug, baseBranch: runEnv.repo.baseBranch },
        ...(runEnv !== undefined ? { maxConcurrentRuns } : {}),
        ...(runEnv !== undefined ? { dispatchEnv: dispatchEnvFor(runEnv, options.adapter) } : {}),
        input: body.input,
        adapter: options.adapter,
        ...(typeof body.dedupeKey === "string" ? { dedupeKey: body.dedupeKey } : {}),
      };
      let runId: string;
      try {
        runId = await startTrackedRun(options.db, services, workflow, startOptions);
      } catch (err) {
        if (err instanceof ConcurrencyLimitError) {
          return json({ error: err.message }, { status: 409 });
        }
        if (err instanceof DedupeKeyError) {
          return json(
            { error: err.message, dedupeKey: err.key, holderRunId: err.holderRunId },
            { status: 409 },
          );
        }
        throw err;
      }
      return json({ runId }, { status: 201 });
    }

    if (req.method === "GET" && url.pathname === "/api/schedules") {
      const config = options.config;
      const schedules = config?.schedules ?? [];
      const lastRunBySchedule = new Map<string, RunSummary>();
      for (const run of listRuns(options.db)) {
        if (run.scheduleId !== undefined && !lastRunBySchedule.has(run.scheduleId)) {
          lastRunBySchedule.set(run.scheduleId, run);
        }
      }
      const parsed =
        config !== undefined && schedules.length > 0
          ? new Map(toRuntimeSchedules(config).map((s) => [s.id, s] as const))
          : undefined;
      return json(
        schedules.map((schedule): ScheduleSummary => {
          const lastRun = lastRunBySchedule.get(schedule.id);
          const runtime = parsed!.get(schedule.id)!;

          return {
            id: schedule.id,
            workflowId: schedule.workflowId,
            input: schedule.input,
            cron: schedule.cron,
            timezone: schedule.timezone,
            overlap: schedule.overlap,
            runOnStart: schedule.runOnStart,
            nextFireAt: nextFireAt(runtime, Date.now()),
            ...(lastRun !== undefined
              ? {
                  lastRun: {
                    runId: lastRun.runId,
                    status: lastRun.status,
                    startedAt: lastRun.startedAt,
                  },
                }
              : { lastRun: undefined }),
          };
        }),
      );
    }

    const scheduleRunMatch = /^\/api\/schedules\/([^/]+)\/run$/.exec(url.pathname);
    if (req.method === "POST" && scheduleRunMatch) {
      const scheduleId = decodeURIComponent(scheduleRunMatch[1] as string);
      if (options.config === undefined) return json({ error: "not found" }, { status: 404 });
      const schedule = (options.config?.schedules ?? []).find((s) => s.id === scheduleId);
      if (schedule === undefined) {
        return json({ error: `unknown schedule id: ${scheduleId}` }, { status: 404 });
      }
      const workflow = options.config!.workflows.find((w) => w.id === schedule.workflowId)!;

      const maxConcurrentRuns = options.config.maxConcurrentRuns;
      if (!admitRun(maxConcurrentRuns, services.registry.activeRunIds().length)) {
        return json(
          { error: `concurrency limit reached (max ${maxConcurrentRuns} concurrent runs)` },
          { status: 409 },
        );
      }

      let runId: string;
      try {
        runId = await startTrackedRun(options.db, services, workflow, {
          ...configRunOptions(options.config, options.adapter, maxConcurrentRuns, {
            scheduleId: schedule.id,
            ...(schedule.overlap === "skip" ? { dedupeKey: `schedule:${schedule.id}` } : {}),
            ...(schedule.agent !== undefined ? { agentOverrides: schedule.agent } : {}),
          }),
          input: schedule.input,
          adapter: options.adapter,
        });
      } catch (err) {
        if (err instanceof ConcurrencyLimitError) {
          return json({ error: err.message }, { status: 409 });
        }
        if (err instanceof DedupeKeyError) {
          return json(
            { error: err.message, dedupeKey: err.key, holderRunId: err.holderRunId },
            { status: 409 },
          );
        }
        throw err;
      }
      return json({ runId }, { status: 201 });
    }

    const cancelMatch = /^\/api\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
    if (req.method === "POST" && cancelMatch) {
      const runId = cancelMatch[1] as string;
      const target = services.registry.cancelRegisteredRun(runId);
      if (target === undefined) return json({ error: "run not active" }, { status: 409 });
      if (target.kind === "handle") await target.handle.cancel();
      return json({ runId, cancelled: true });
    }

    const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (req.method === "GET" && eventsMatch) {
      const runId = eventsMatch[1] as string;
      const exists = listSummaries(options.db, services).some((r) => r.runId === runId);
      if (!exists) return json({ error: "not found" }, { status: 404 });
      return new Response(
        sseStream(options.db, services, runId, parseLastEventId(req), options.sseKeepaliveMs),
        {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        },
      );
    }

    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && runMatch) {
      const runId = runMatch[1] as string;
      const run = listSummaries(options.db, services).find((r) => r.runId === runId);
      if (run === undefined) return json({ error: "not found" }, { status: 404 });
      return json(run);
    }

    return json({ error: "not found" }, { status: 404 });
  };
}

export function serve(options: ServerOptions & { port?: number }): ReturnType<typeof Bun.serve> {
  const handler = createHandler(options);
  return Bun.serve({
    port: options.port ?? 0,
    routes: {
      "/": index,
      "/api/*": (req) => handler(req),
      "/*": index,
    },
    development: false,
  });
}
