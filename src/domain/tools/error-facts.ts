import type { ToolErrorDomain, ToolErrorFactValue, ToolErrorFacts } from "./contracts.js";

const MAX_FACT_ENTRIES = 24;
const MAX_FACT_DEPTH = 2;

export type NormalizeToolErrorFactsOptions = {
  readonly compactString?: (value: string) => string;
};

export function isToolErrorDomain(value: unknown): value is ToolErrorDomain {
  return value === "tool_error" ||
    value === "runtime_error" ||
    value === "model_error" ||
    value === "ui_submit_error" ||
    value === "process_error";
}

export function normalizeToolErrorFacts(
  value: unknown,
  options: NormalizeToolErrorFactsOptions = {}
): ToolErrorFacts | undefined {
  const record = asRecord(value);
  const result: Record<string, ToolErrorFactValue> = {};
  for (const [key, item] of Object.entries(record).slice(0, MAX_FACT_ENTRIES)) {
    const fact = normalizeToolErrorFactValue(item, options);
    if (fact !== undefined) {
      Object.defineProperty(result, key, {
        value: fact,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

export function normalizeToolErrorFactValue(
  value: unknown,
  options: NormalizeToolErrorFactsOptions = {}
): ToolErrorFactValue | undefined {
  return normalizeToolErrorFactValueInternal(value, options, new Set<object>(), 0);
}

function normalizeToolErrorFactValueInternal(
  value: unknown,
  options: NormalizeToolErrorFactsOptions,
  ancestors: Set<object>,
  depth: number
): ToolErrorFactValue | undefined {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      return String(value);
    }
    return value;
  }
  if (typeof value === "string") {
    return options.compactString?.(value) ?? value;
  }
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  if (depth >= MAX_FACT_DEPTH) {
    return "[max_depth]";
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return "[circular]";
    }
    ancestors.add(value);
    try {
      return value
        .slice(0, MAX_FACT_ENTRIES)
        .map((item) => normalizeToolErrorFactValueInternal(item, options, ancestors, depth + 1))
        .filter((item): item is ToolErrorFactValue => item !== undefined);
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === "object" && value !== null) {
    if (ancestors.has(value)) {
      return "[circular]";
    }
    ancestors.add(value);
    const result: Record<string, ToolErrorFactValue> = {};
    try {
      for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_FACT_ENTRIES)) {
        const fact = normalizeToolErrorFactValueInternal(item, options, ancestors, depth + 1);
        if (fact !== undefined) {
          Object.defineProperty(result, key, {
            value: fact,
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
  return undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}
