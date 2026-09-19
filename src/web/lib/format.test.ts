import { describe, expect, test } from "bun:test";
import {
  formatAgo,
  formatAhead,
  formatClock,
  formatDuration,
  formatInZone,
  formatTokenCount,
  shortRunId,
} from "./format";

describe("formatDuration", () => {
  test("seconds below a minute, m/padded-s above", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(59_999)).toBe("1m 00s");
    expect(formatDuration(60_000)).toBe("1m 00s");
    expect(formatDuration(95_000)).toBe("1m 35s");
  });

  test("just under an hour stays m/padded-s, not h/m/s", () => {
    expect(formatDuration(59 * 60 * 1000)).toBe("59m 00s");
  });

  test("an hour or more adds an h component, minutes and seconds padded", () => {
    expect(formatDuration(3_600_000)).toBe("1h 00m 00s");
    expect(formatDuration(3_723_000)).toBe("1h 02m 03s");
    expect(formatDuration(7_325_000)).toBe("2h 02m 05s");
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

describe("formatInZone (issue #17)", () => {
  const ts = Date.UTC(2026, 0, 10, 3, 30, 0);

  test("renders the instant in the schedule's own timezone, not the machine's", () => {
    // 03:30 UTC is 04:30 in January in Europe/Berlin (UTC+1).
    expect(formatInZone(ts, "Europe/Berlin")).toBe("10 Jan, 04:30");
    expect(formatInZone(ts, "UTC")).toBe("10 Jan, 03:30");
  });
});

describe("formatTokenCount", () => {
  test("under a thousand is the raw number", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  test("thousands and millions get a trimmed one-decimal suffix", () => {
    expect(formatTokenCount(3_648)).toBe("3.6k");
    expect(formatTokenCount(10_000)).toBe("10k");
    expect(formatTokenCount(1_500_000)).toBe("1.5m");
    expect(formatTokenCount(2_000_000)).toBe("2m");
  });
});

describe("formatAhead (issue #17)", () => {
  const now = 1_000_000_000;
  test("doubles as an 'until next fire' label", () => {
    expect(formatAhead(now + 42_000, now)).toBe("in 42s");
    expect(formatAhead(now + 90_000, now)).toBe("in 1m");
    expect(formatAhead(now + 3 * 3_600_000 + 60_000, now)).toBe("in 3h 1m");
    expect(formatAhead(now + 27 * 3_600_000, now)).toBe("in 1d 3h");
  });
});
