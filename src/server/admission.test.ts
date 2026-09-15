import { describe, expect, test } from "bun:test";
import { admitRun } from "./admission";

describe("admitRun (D29)", () => {
  test("admits below the limit", () => {
    expect(admitRun(3, 0)).toBe(true);
    expect(admitRun(3, 2)).toBe(true);
  });

  test("admits at the boundary but never over it", () => {
    expect(admitRun(2, 1)).toBe(true);
    expect(admitRun(2, 2)).toBe(false);
    expect(admitRun(2, 3)).toBe(false);
  });

  test("a limit of 1 reproduces D24's old WIP behaviour", () => {
    expect(admitRun(1, 0)).toBe(true);
    expect(admitRun(1, 1)).toBe(false);
  });
});
