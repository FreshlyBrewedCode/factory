import { describe, expect, test } from "bun:test";
import { runDetailStatus } from "./status";

/**
 * The run-detail badge's status, as a pure projection over the three things
 * that know something about a run: its own event stream (a terminal event),
 * the SSE connection (open or not), and the server's live registry (the
 * `active` bit on the run summary).
 *
 * The case that forced this out of the component: the SSE connection dropping
 * under a run that is still running. The page used to read that as "not
 * streaming, therefore not active" and render the store's read-time
 * `"interrupted"` — a healthy run shown as a dead one until a manual refresh.
 */
describe("runDetailStatus", () => {
  test("a terminal event decides the status outright", () => {
    // The event log is the spine (D3); nothing outranks a terminal event —
    // not a stream that happens to still be draining, not a stale summary.
    for (const [tag, expected] of [
      ["RunFinished", "finished"],
      ["RunFailed", "failed"],
      ["RunCancelled", "cancelled"],
    ] as const) {
      expect(
        runDetailStatus({
          terminalTag: tag,
          streaming: true,
          summary: { active: true, status: "interrupted" },
        }),
      ).toBe(expected);
    }
  });

  test("an open stream with no terminal event is running", () => {
    expect(runDetailStatus({ terminalTag: undefined, streaming: true, summary: undefined })).toBe(
      "running",
    );
  });

  test("a dropped stream over a run the server still holds is running", () => {
    // The defect, as a test. The store derives "interrupted" for any run
    // without a terminal event, so the summary's `status` says "interrupted"
    // for every live run — `active` is the bit that tells them apart, and it
    // has to win here.
    expect(
      runDetailStatus({
        terminalTag: undefined,
        streaming: false,
        summary: { active: true, status: "interrupted" },
      }),
    ).toBe("running");
  });

  test("a closed stream the server agrees is inactive is interrupted", () => {
    // A real crash: no terminal event was ever written and no process holds
    // the run. This is what "interrupted" is *for* (D12/D21).
    expect(
      runDetailStatus({
        terminalTag: undefined,
        streaming: false,
        summary: { active: false, status: "interrupted" },
      }),
    ).toBe("interrupted");
  });

  test("a closed stream falls back to the summary's terminal status", () => {
    // The run ended while the page was not looking — the summary carries the
    // outcome even though this page's event list never received it.
    expect(
      runDetailStatus({
        terminalTag: undefined,
        streaming: false,
        summary: { active: false, status: "RunFinished" },
      }),
    ).toBe("finished");
  });

  test("a closed stream with no summary at all is interrupted", () => {
    // Nothing known from any source: the honest answer is the pessimistic one.
    expect(runDetailStatus({ terminalTag: undefined, streaming: false, summary: undefined })).toBe(
      "interrupted",
    );
  });
});
