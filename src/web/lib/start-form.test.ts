import { describe, expect, test } from "bun:test";
import { buildStartInput, toStartFormSpec } from "./start-form";

describe("toStartFormSpec (D33 single-depth)", () => {
  test("renders string, number and boolean properties one level deep, with required flags", () => {
    const spec = toStartFormSpec({
      type: "object",
      properties: {
        title: { type: "string" },
        count: { type: "number" },
        enabled: { type: "boolean" },
      },
      required: ["title", "count"],
      additionalProperties: true,
    });
    expect(spec).toEqual({
      kind: "fields",
      fields: [
        { name: "title", type: "string", required: true },
        { name: "count", type: "number", required: true },
        { name: "enabled", type: "boolean", required: false },
      ],
    });
  });

  test("renders Effect Schema.Number's anyOf encoding as a number field", () => {
    const spec = toStartFormSpec({
      type: "object",
      properties: {
        issueNumber: {
          anyOf: [{ type: "number" }, { type: "string", enum: ["Infinity", "-Infinity", "NaN"] }],
        },
      },
      required: ["issueNumber"],
    });
    expect(spec).toEqual({
      kind: "fields",
      fields: [{ name: "issueNumber", type: "number", required: true }],
    });
  });

  test("falls back to raw JSON for a nested object property", () => {
    const spec = toStartFormSpec({
      type: "object",
      properties: { nested: { type: "object", properties: { x: { type: "string" } } } },
    });
    expect(spec).toEqual({ kind: "json" });
  });

  test("falls back to raw JSON when the schema is not an object with properties", () => {
    expect(toStartFormSpec({ not: { type: "null" } })).toEqual({ kind: "json" });
    expect(toStartFormSpec({ type: "string" })).toEqual({ kind: "json" });
    expect(toStartFormSpec({ type: "object" })).toEqual({ kind: "json" });
    expect(toStartFormSpec(undefined)).toEqual({ kind: "json" });
  });

  test("falls back to raw JSON for a union of two primitive types", () => {
    const spec = toStartFormSpec({
      type: "object",
      properties: { either: { anyOf: [{ type: "string" }, { type: "number" }] } },
    });
    expect(spec).toEqual({ kind: "json" });
  });
});

describe("buildStartInput", () => {
  const fields = [
    { name: "title", type: "string" as const, required: true },
    { name: "count", type: "number" as const, required: true },
    { name: "enabled", type: "boolean" as const, required: false },
  ];

  test("coerces field values to their schema types", () => {
    const result = buildStartInput(fields, {
      title: "hello",
      count: "7",
      enabled: true,
    });
    expect(result).toEqual({
      input: { title: "hello", count: 7, enabled: true },
    });
  });

  test("omits empty strings, and an unchecked optional boolean is omitted", () => {
    const result = buildStartInput(fields, { title: "", count: "", enabled: false });
    expect(result).toEqual({ input: {} });
  });

  test("includes a required boolean even when unchecked, and optional ones only when checked", () => {
    const result = buildStartInput(
      [
        { name: "always", type: "boolean" as const, required: true },
        { name: "maybe", type: "boolean" as const, required: false },
      ],
      {},
    );
    expect(result).toEqual({ input: { always: false } });

    const checked = buildStartInput(
      [
        { name: "always", type: "boolean" as const, required: true },
        { name: "maybe", type: "boolean" as const, required: false },
      ],
      { always: false, maybe: true },
    );
    expect(checked).toEqual({ input: { always: false, maybe: true } });
  });

  test("rejects a number field that does not parse", () => {
    const result = buildStartInput(fields, { title: "x", count: "seven", enabled: false });
    expect(result).toEqual({ error: "count must be a number" });
  });
});
