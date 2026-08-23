/**
 * JSON Schema values received from MCP or passed to a model provider.
 *
 * This models the wire shape rather than a hand-picked keyword subset. A
 * provider adapter may reject an unsupported keyword explicitly, but copying a
 * tool contract must never silently erase it.
 */
export type ToolJsonSchemaValue =
  | null
  | string
  | number
  | boolean
  | readonly ToolJsonSchemaValue[]
  | { readonly [key: string]: ToolJsonSchemaValue };

export type ToolJsonSchema = boolean | { readonly [key: string]: ToolJsonSchemaValue };

export class InvalidToolSchemaError extends Error {
  readonly code = "invalid_tool_schema";

  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`Tool JSON Schema is invalid at ${path}: ${reason}.`);
    this.name = "InvalidToolSchemaError";
  }
}

/**
 * Normalize an external object-schema value into a detached JSON-safe fact.
 * Undefined object fields are omitted because they are not representable in
 * JSON; all other unsupported values fail explicitly instead of being lost.
 */
export function normalizeToolInputSchema(value: unknown): import("./contracts.js").ToolInputSchema {
  const normalized = normalizeSchemaValue(value, "$", new Set<object>(), 0);
  if (!isRecord(normalized) || normalized.type !== "object") {
    throw new InvalidToolSchemaError("$", "the root schema type must be object");
  }
  const properties = normalized.properties === undefined
    ? {}
    : normalized.properties;
  if (!isRecord(properties)) {
    throw new InvalidToolSchemaError("$.properties", "properties must be an object");
  }
  if (normalized.required !== undefined) {
    assertRequiredNames(normalized.required);
  }
  if (
    normalized.additionalProperties !== undefined &&
    typeof normalized.additionalProperties !== "boolean" &&
    !isRecord(normalized.additionalProperties)
  ) {
    throw new InvalidToolSchemaError(
      "$.additionalProperties",
      "additionalProperties must be a boolean or schema object",
    );
  }
  return {
    ...normalized,
    type: "object",
    properties,
  } as import("./contracts.js").ToolInputSchema;
}

export function cloneToolInputSchema(value: unknown): import("./contracts.js").ToolInputSchema {
  return normalizeToolInputSchema(value);
}

/** Normalize and detach an arbitrary JSON Schema, including boolean schemas. */
export function cloneToolJsonSchema(value: unknown): ToolJsonSchema {
  const normalized = normalizeSchemaValue(value, "$", new Set<object>(), 0);
  if (typeof normalized === "boolean") return normalized;
  if (!isRecord(normalized)) {
    throw new InvalidToolSchemaError("$", "schema must be a boolean or object");
  }
  return normalized;
}

/** Stable JSON serialization used for run-born contract hashes and metrics. */
export function stableToolSchemaStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableToolSchemaStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableToolSchemaStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function normalizeSchemaValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  depth: number,
): ToolJsonSchemaValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidToolSchemaError(path, "non-finite numbers are not supported");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new InvalidToolSchemaError(path, `${typeof value} values are not supported`);
  }
  if (depth >= 100) {
    throw new InvalidToolSchemaError(path, "maximum schema nesting depth was exceeded");
  }
  if (ancestors.has(value)) {
    throw new InvalidToolSchemaError(path, "circular references are not supported");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => {
        const normalized = normalizeSchemaValue(item, `${path}[${index}]`, ancestors, depth + 1);
        if (normalized === undefined) {
          throw new InvalidToolSchemaError(`${path}[${index}]`, "undefined values are not supported");
        }
        return normalized;
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InvalidToolSchemaError(path, "only plain objects are supported");
    }
    if (Object.getOwnPropertySymbols(value).some((symbol) =>
      Object.prototype.propertyIsEnumerable.call(value, symbol))) {
      throw new InvalidToolSchemaError(path, "symbol-keyed fields are not supported");
    }
    const result: Record<string, ToolJsonSchemaValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeSchemaValue(item, `${path}.${key}`, ancestors, depth + 1);
      if (normalized !== undefined) {
        Object.defineProperty(result, key, {
          value: normalized,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function assertRequiredNames(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new InvalidToolSchemaError("$.required", "required must be an array of non-empty strings");
  }
  if (new Set(value).size !== value.length) {
    throw new InvalidToolSchemaError("$.required", "required must not contain duplicate names");
  }
}

function isRecord(value: unknown): value is Record<string, ToolJsonSchemaValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
