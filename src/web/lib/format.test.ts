import { describe, expect, test } from "bun:test";
import { formatAgo, formatClock, formatDuration, shortRunId } from "./format";

describe("formatDuration", () => {
  test("seconds below a minute, m/padded-s above", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(59_999)).toBe("1m 00s");
    expect(formatDuration(60_000)).toBe("1m 00s");
    expect(formatDuration(95_000)).toBe("1m 35s");
    expect(formatDuration(3_600_000)).toBe("60m 00s");
  });

  test("unknown duration is an em dash", () => {
    expect(formatDuration(undefined)).toBe("—");
  });
});

describe("formatAgo", () => {
  const now = 1_000_000_000;
  test("doubles as an 'ago' label", () => {
    expect(formatAgo(now, now)).toBe("0s ago");
    expect(formatAgo(now - 42_000, now)).toBe("42s ago");
    expect(formatAgo(now - 90_000, now)).toBe("1m ago");
    expect(formatAgo(now - 3 * 3_600_000 - 60_000, now)).toBe("3h 1m ago");
  });
});

describe("formatClock", () => {
  test("zero-pads to HH:MM:SS", () => {
    expect(formatClock(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe("03:04:05");
  });
});

describe("shortRunId", () => {
  test("keeps a stable tail for both timestamp and uuid run ids", () => {
    expect(shortRunId("run-1789381260241")).toBe("…81260241");
    expect(shortRunId("run-1a2b3c4d-5e6f-7890-abcd-ef1234567890")).toBe("…34567890");
  });
});
