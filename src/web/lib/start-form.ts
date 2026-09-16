/**
 * D33's start-form projection (ADR 0005): the workflow's JSON-Schema input
 * (from `GET /api/workflows`) becomes either single-depth
 * `string`/`number`/`boolean` fields, or the raw-JSON escape hatch when
 * anything is not renderable. The server still validates everything through
 * D31's decode — this only decides what the form can *render*.
 *
 * Pure so the form logic stays unit-testable without a DOM.
 */

export interface StartFormField {
  readonly name: string;
  readonly type: "string" | "number" | "boolean";
  readonly required: boolean;
}

export type StartFormSpec =
  | { readonly kind: "fields"; readonly fields: ReadonlyArray<StartFormField> }
  | { readonly kind: "json" };

interface SchemaNode {
  readonly type?: unknown;
  readonly properties?: unknown;
  readonly anyOf?: unknown;
  readonly enum?: unknown;
}

function primitiveType(node: unknown): StartFormField["type"] | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const { type, anyOf } = node as SchemaNode;
  if (type === "string" || type === "boolean") return type;
  if (type === "number" || type === "integer") return "number";
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    // Effect's Schema.Number encodes as anyOf[number, "Infinity"|"NaN"|...] —
    // a closed string enum is the marker sidecar, not a second renderable type.
    // `Schema.optional(X)` encodes as anyOf[X, null] — the null variant is
    // optionality's marker, not a second renderable type.
    const variants = anyOf
      .filter((variant) => !(typeof variant === "object" && variant !== null && "enum" in variant))
      .map((variant) => {
        if (typeof variant !== "object" || variant === null) return undefined;
        if ((variant as SchemaNode).type === "null") return undefined;
        const variantType = (variant as SchemaNode).type;
        return variantType === "number" || variantType === "integer"
          ? ("number" as const)
          : (variantType as StartFormField["type"] | undefined);
      });
    const renderable = variants.filter((v) => v !== undefined);
    if (renderable.length === 0) return undefined;
    if (renderable.every((v) => v === "number")) return "number";
    if (new Set(renderable).size > 1) return undefined;
    return renderable[0];
  }
  return undefined;
}

export function toStartFormSpec(schema: unknown): StartFormSpec {
  if (typeof schema !== "object" || schema === null) return { kind: "json" };
  const { type, properties, required } = schema as SchemaNode & { required?: unknown };
  if (type !== "object" || typeof properties !== "object" || properties === null) {
    return { kind: "json" };
  }

  const requiredSet = new Set(
    Array.isArray(required) ? required.filter((r): r is string => typeof r === "string") : [],
  );
  const fields: Array<StartFormField> = [];
  for (const [name, node] of Object.entries(properties as Record<string, unknown>)) {
    const fieldType = primitiveType(node);
    if (fieldType === undefined) return { kind: "json" };
    fields.push({ name, type: fieldType, required: requiredSet.has(name) });
  }
  return { kind: "fields", fields };
}

export type BuildStartInputResult =
  | { readonly input: Record<string, unknown> }
  | { readonly error: string };

export function buildStartInput(
  fields: ReadonlyArray<StartFormField>,
  values: Readonly<Record<string, string | boolean>>,
): BuildStartInputResult {
  const input: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (field.type === "boolean") {
      // A checkbox cannot express "unset", so an untouched optional boolean
      // (unchecked) omits the key instead of sending an explicit `false`;
      // raw-JSON mode covers explicit false.
      if (!field.required && raw !== true) continue;
      input[field.name] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw : "";
    if (text === "") continue;
    if (field.type === "number") {
      const parsed = Number(text);
      if (Number.isNaN(parsed)) return { error: `${field.name} must be a number` };
      input[field.name] = parsed;
    } else {
      input[field.name] = text;
    }
  }
  return { input };
}
