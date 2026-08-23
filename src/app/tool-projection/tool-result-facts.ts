import { asRecord } from "../../kernel/values/index.js";
export { asRecord };
import type { ToolErrorFacts } from "../../domain/tools/index.js";

/** Runtime value readers shared by model and display projections. */


export function optionalRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const record = asRecord(value);
  return Object.keys(record).length === 0 ? undefined : record;
}

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Unlike stringOrUndefined, this preserves whitespace in a model content block. */
export function textOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanOrUndefined(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

export function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function stringRecordOrUndefined(value: unknown): Readonly<Record<string, string>> | undefined {
  const record = asRecord(value);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isMcpToolName(toolName: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*__[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(toolName);
}

export function readErrorFactsFromOutput(record: Readonly<Record<string, unknown>>): ToolErrorFacts | undefined {
  const direct = optionalRecord(record.errorFacts);
  if (direct !== undefined) {
    return direct as ToolErrorFacts;
  }
  const trace = asRecord(record.trace);
  const sourceSteps = Array.isArray(trace.sourceSteps) ? trace.sourceSteps : [];
  for (const value of sourceSteps) {
    const step = asRecord(value);
    if (stringOrUndefined(step.status) === "completed") {
      continue;
    }
    const facts = optionalRecord(step.errorFacts);
    if (facts !== undefined) {
      return facts as ToolErrorFacts;
    }
  }
  return undefined;
}

export function readErrorMessageFromOutput(record: Readonly<Record<string, unknown>>): string | undefined {
  const direct = stringOrUndefined(record.error);
  if (direct !== undefined) {
    return direct;
  }
  return firstIncompleteSourceStepMessage(record);
}

export function searchMessageFromOutput(record: Readonly<Record<string, unknown>>): string | undefined {
  const direct = stringOrUndefined(record.message);
  if (direct !== undefined) {
    return direct;
  }
  return firstIncompleteSourceStepMessage(record);
}

function firstIncompleteSourceStepMessage(record: Readonly<Record<string, unknown>>): string | undefined {
  const trace = asRecord(record.trace);
  const sourceSteps = Array.isArray(trace.sourceSteps) ? trace.sourceSteps : [];
  for (const value of sourceSteps) {
    const step = asRecord(value);
    if (stringOrUndefined(step.status) === "completed") {
      continue;
    }
    const message = stringOrUndefined(step.message);
    if (message !== undefined) {
      return message;
    }
  }
  return undefined;
}
