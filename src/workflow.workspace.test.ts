import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { defineWorkflow } from "./workflow";

const wf = (workspace: unknown) =>
  defineWorkflow("wf", {
    input: Schema.Struct({}) as never,
    run: () => Promise.resolve(),
    ...(workspace !== undefined ? { workspace: workspace as never } : {}),
  });

describe("defineWorkflow workspace spec (issue #13)", () => {
  test("clone is the default: a workflow without `workspace` declares clone", () => {
    expect(wf(undefined).workspace).toEqual({ kind: "clone" });
  });

  test("an explicit clone spec is round-tripped", () => {
    expect(wf({ kind: "clone" }).workspace).toEqual({ kind: "clone" });
  });

  test("a scratch spec is accepted", () => {
    expect(wf({ kind: "scratch" }).workspace).toEqual({ kind: "scratch" });
  });
});
