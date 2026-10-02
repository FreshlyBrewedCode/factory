/**
 * A fake ACP agent over stdio for `acp-adapter.test.ts`, built on the SDK's
 * `AgentSideConnection` — the same protocol opencode and claude-agent-acp
 * speak, with behaviour chosen by the prompt's first word:
 *
 * - `hello`: usage, a text reply naming the session's model, usage with cost.
 * - `permission`: asks to edit a file and replies with the option it got.
 * - `json`: replies with a JSON object (structured output).
 * - `env`: replies with the names of its `CLAUDE*` environment variables.
 * - `hang`: works until cancelled, then ends the turn as `cancelled`.
 * - `deaf`: works forever and ignores `session/cancel`.
 * - `crash`: writes to stderr and exits with code 3 mid-turn.
 * - `refuse`: ends the turn with `stopReason: "refusal"`.
 *
 * `FAKE_ACP_NO_MODEL=1` offers no model option.
 */

import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { Writable } from "node:stream";

const MODELS = ["fake/default", "fake/fast", "fake/smart"];

const sessions = new Map<string, { model: string; cancelled: () => void; wasCancelled: boolean }>();

function modelOption(current: string): SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: current,
    options: [
      { group: "fake", name: "Fake", options: MODELS.map((value) => ({ value, name: value })) },
    ],
  };
}

const connection = new AgentSideConnection(
  (conn) => {
    const say = (sessionId: string, text: string) =>
      conn.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    const usage = (sessionId: string, used: number, cost?: number) =>
      conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "usage_update",
          used,
          size: 200_000,
          ...(cost !== undefined && { cost: { amount: cost, currency: "USD" } }),
        },
      });
    return {
      initialize: async () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
        agentInfo: { name: "fake-acp-agent", version: "0.0.0" },
      }),
      newSession: async () => {
        const sessionId = crypto.randomUUID();
        sessions.set(sessionId, { model: MODELS[0]!, cancelled: () => {}, wasCancelled: false });
        return {
          sessionId,
          configOptions: process.env.FAKE_ACP_NO_MODEL ? [] : [modelOption(MODELS[0]!)],
        };
      },
      setSessionConfigOption: async (params) => {
        const session = sessions.get(params.sessionId)!;
        if (params.configId === "model" && typeof params.value === "string")
          session.model = params.value;
        return { configOptions: [modelOption(session.model)] };
      },
      authenticate: async () => ({}),
      cancel: async ({ sessionId }) => {
        const session = sessions.get(sessionId);
        if (session) {
          session.wasCancelled = true;
          session.cancelled();
        }
      },
      prompt: async ({ sessionId, prompt }) => {
        const session = sessions.get(sessionId)!;
        const text = prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
        const verb = text.trim().split(/\s+/)[0];
        switch (verb) {
          case "hello":
            await usage(sessionId, 1000);
            await say(sessionId, `hello from ${session.model}`);
            await usage(sessionId, 1200, 0.25);
            return {
              stopReason: "end_turn",
              usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 990, totalTokens: 1005 },
            };
          case "permission": {
            await conn.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "t1",
                title: "Edit math.ts",
                kind: "edit",
                status: "pending",
              },
            });
            const answer = await conn.requestPermission({
              sessionId,
              toolCall: { toolCallId: "t1", title: "Edit math.ts" },
              options: [
                { optionId: "once", name: "Allow once", kind: "allow_once" },
                { optionId: "always", name: "Always allow", kind: "allow_always" },
                { optionId: "no", name: "Reject", kind: "reject_once" },
              ],
            });
            const chosen =
              answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled";
            await conn.sessionUpdate({
              sessionId,
              update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
            });
            await say(sessionId, `permission: ${chosen}`);
            return { stopReason: "end_turn" };
          }
          case "json":
            await say(sessionId, '{"summary":"done","count":2}');
            return { stopReason: "end_turn" };
          case "env":
            await say(
              sessionId,
              Object.keys(process.env)
                .filter((k) => k.startsWith("CLAUDE"))
                .sort()
                .join(","),
            );
            return { stopReason: "end_turn" };
          case "hang":
            await say(sessionId, "working");
            await new Promise<void>((resolve) => {
              session.cancelled = resolve;
              if (session.wasCancelled) resolve();
            });
            return { stopReason: "cancelled" };
          case "deaf":
            await say(sessionId, "working");
            await new Promise(() => {});
            return { stopReason: "end_turn" };
          case "crash":
            await say(sessionId, "about to fail");
            process.stderr.write("starting up\nfatal: the fake agent fell over\n");
            setTimeout(() => process.exit(3), 20);
            await new Promise(() => {});
            return { stopReason: "end_turn" };
          case "refuse":
            return { stopReason: "refusal" };
          default:
            throw new Error(`fake agent: unknown prompt ${JSON.stringify(verb)}`);
        }
      },
    };
  },
  ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Bun.stdin.stream()),
);

await connection.closed;
