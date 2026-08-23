import { copyToolModelAttachments } from "./model-attachments.js";

export type ToolFactValue =
  | null
  | string
  | number
  | boolean
  | readonly ToolFactValue[]
  | { readonly [key: string]: ToolFactValue | undefined };

export class InvalidToolFactError extends Error {
  readonly code = "invalid_tool_fact";
  readonly errorDomain = "runtime_error" as const;
  readonly facts: Readonly<Record<string, string>>;

  constructor(
    readonly path: string,
    readonly reason: string
  ) {
    super(`Tool fact is not JSON-safe at ${path}: ${reason}.`);
    this.name = "InvalidToolFactError";
    this.facts = { code: this.code, path, reason };
  }
}

/**
 * Normalizes and detaches executor output as plain JSON facts. Optional object fields may
 * be undefined and are omitted; top-level undefined remains a valid no-result.
 * Values that JSON would silently corrupt or discard fail explicitly.
 */
export function normalizeToolFactValue(value: unknown): ToolFactValue | undefined {
  const normalized = normalize(value, "$", new Set<object>(), 0);
  return normalized !== null && typeof normalized === "object"
    ? copyToolModelAttachments(value, normalized)
    : normalized;
}

function normalize(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  depth: number
): ToolFactValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidToolFactError(path, "non-finite numbers are not supported");
    }
    return value;
  }
  if (typeof value === "bigint") {
    throw new InvalidToolFactError(path, "bigint values are not supported");
  }
  if (typeof value === "function") {
    throw new InvalidToolFactError(path, "function values are not supported");
  }
  if (typeof value === "symbol") {
    throw new InvalidToolFactError(path, "symbol values are not supported");
  }
  if (depth >= 100) {
    throw new InvalidToolFactError(path, "maximum fact nesting depth was exceeded");
  }

  if (ancestors.has(value)) {
    throw new InvalidToolFactError(path, "circular references are not supported");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: ToolFactValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const item = normalize(value[index], `${path}[${index}]`, ancestors, depth + 1);
        // JSON represents an undefined array position as null. Make that
        // normalization explicit instead of relying on stringify side effects.
        result.push(item ?? null);
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      const name = prototype?.constructor?.name;
      throw new InvalidToolFactError(
        path,
        `${typeof name === "string" && name.length > 0 ? name : "non-plain object"} values are not supported`
      );
    }
    const symbols = Object.getOwnPropertySymbols(value)
      .filter((symbol) => Object.prototype.propertyIsEnumerable.call(value, symbol));
    if (symbols.length > 0) {
      throw new InvalidToolFactError(path, "symbol-keyed fields are not supported");
    }

    const result: Record<string, ToolFactValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalize(item, `${path}.${key}`, ancestors, depth + 1);
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
