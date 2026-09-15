/**
 * Phase 3's HTTP API + SSE replay (D22: plain `Bun.serve`, not Effect — the
 * same reasoning as D21's `store.ts`, request/response handling here is
 * synchronous callback-shaped with nothing for Effect to bridge; Effect's
 * job in phase 3 is the dispatcher's scheduling loop, `src/server/dispatch.ts`).
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
import { subscribe } from "./pubsub";
import { activeRunIds, getActiveHandle, isActive, startTrackedRun } from "./runs";

export interface ServerOptions {
  readonly db: Database;
  readonly adapter: AgentAdapter;
  /**
   * The loaded `factory.config.ts` (D27). Absent = the phase 3 path-based API
   * behaves exactly as before (no limit, explicit dir+clone, `/api/workflows`
   * serves an empty list) — the dispatcher legitimately keeps supplying
   * filesystem paths (D31).
   */
  readonly config?: FactoryConfig;
}

/** `RunSummary` plus this process's live-registry bit — what the SPA reads. */
export type RunSummaryResponse = RunSummary & { readonly active: boolean };

/**
 * A run with no terminal event is `"interrupted"` in the store, which cannot
 * tell a crash apart from a run this process still holds. The runs page needs
 * that bit to group live rows, so it is derived here from the in-memory
 * registry (`server/runs.ts`) rather than stored (D24: active is process state).
 */
function listSummaries(db: Database): ReadonlyArray<RunSummaryResponse> {
  return listRuns(db).map((run) => ({ ...run, active: isActive(run.runId) }));
}

interface StartRunBody {
  readonly workflowId?: unknown;
  readonly workflowPath?: unknown;
  readonly input?: unknown;
  readonly dir?: string;
  readonly clone?: { readonly sshUrl: string; readonly identity: GitIdentity };
}

function json(body: unknown, init?: { readonly status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The SSE `Last-Event-ID` header, or `undefined` if absent or not a sequence
 * number. `EventSource` sends it automatically on reconnect, and `seq` is the
 * value we stamp on each frame's `id:` line, so it is the resume offset.
 */
function parseLastEventId(req: Request): number | undefined {
  const raw = req.headers.get("last-event-id");
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

function sseStream(db: Database, runId: string, lastEventId?: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      // `Last-Event-ID` makes this resume: seed `lastSeq` from it and the
      // persisted replay below skips everything the client already has, exactly
      // as the live tail already does. `seq` is the offset (D20/D26).
      let lastSeq = lastEventId ?? -1;
      let draining = false;
      const buffered: Array<RunEvent> = [];

      const send = (event: RunEvent): void => {
        controller.enqueue(encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`));
        lastSeq = event.seq;
      };

      const unsubscribe = subscribe(runId, (event) => {
        if (!draining) {
          buffered.push(event);
          return;
        }
        if (event.seq <= lastSeq) return;
        send(event);
        if (isTerminal(event.payload)) {
          unsubscribe();
          controller.close();
        }
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

      if (sawTerminal || !isActive(runId)) {
        unsubscribe();
        controller.close();
      }
    },
  });
}

export function createHandler(options: ServerOptions): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/api/runs") {
      return json(listSummaries(options.db));
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
      // D29: the one admission function, consulted here and on the dispatch
      // path alike. Without config there is no limit to enforce.
      const maxConcurrentRuns = options.config?.maxConcurrentRuns;
      if (maxConcurrentRuns !== undefined && !admitRun(maxConcurrentRuns, activeRunIds().length)) {
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
        const registry = options.config?.workflows ?? [];
        const workflow = registry.find((w) => w.id === body.workflowId);
        if (workflow === undefined) {
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

        const runId = await startTrackedRun(options.db, workflow, {
          ...(options.config !== undefined
            ? {
                workspace: {
                  workspaceRoot: options.config.workspaceRoot,
                  sshUrl: options.config.repo.sshUrl,
                  identity: options.config.repo.identity,
                  retainedWorkspaces: options.config.retainedWorkspaces,
                },
              }
            : {}),
          input: decodedInput,
          adapter: options.adapter,
        });
        return json({ runId }, { status: 201 });
      }

      if (typeof body.workflowPath !== "string") {
        return json({ error: "workflowPath (string) is required" }, { status: 400 });
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
      const runId = await startTrackedRun(options.db, workflow, {
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
        input: body.input,
        adapter: options.adapter,
      });
      return json({ runId }, { status: 201 });
    }

    const cancelMatch = /^\/api\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
    if (req.method === "POST" && cancelMatch) {
      const runId = cancelMatch[1] as string;
      const handle = getActiveHandle(runId);
      if (handle === undefined) return json({ error: "run not active" }, { status: 409 });
      await handle.cancel();
      return json({ runId, cancelled: true });
    }

    const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (req.method === "GET" && eventsMatch) {
      const runId = eventsMatch[1] as string;
      const exists = listSummaries(options.db).some((r) => r.runId === runId);
      if (!exists) return json({ error: "not found" }, { status: 404 });
      return new Response(sseStream(options.db, runId, parseLastEventId(req)), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && runMatch) {
      const runId = runMatch[1] as string;
      const run = listSummaries(options.db).find((r) => r.runId === runId);
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
    // Bun's `development: true` HMR mode crashes TanStack Router at boot
    // (`Cannot read properties of null (reading 'replaceRouteChunk')` from
    // router-core's dev-only prototype patch). Runtime bundling with
    // `development: false` still serves the same HTML-route bundle, cached and
    // minified, so the POC takes correctness over hot reload. See STATUS S2.
    development: false,
  });
}
