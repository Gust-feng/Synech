import type { ToolCallResult, ToolResult } from "../../domain/tools/index.js";

/** Converts one execution fact into an exclusive model body plus error facts. */
export function toolCallResultToModelToolResult(result: ToolCallResult): ToolResult {
  if (result.status === "failed" || result.status === "cancelled") {
    return {
      body: toolCallOutputToModelBody(result.output, result.toolName),
      error: {
        message: result.error ?? (result.status === "cancelled"
          ? "Tool execution was cancelled."
          : "Tool execution failed."),
        domain: result.errorDomain,
        facts: result.errorFacts,
      },
    };
  }
  if (result.status === "approval_required") {
    return {
      body: {
        format: "json",
        value: {
          confirmation: result.confirmationRequest,
          ...(result.output === undefined ? {} : { partialOutput: result.output }),
        },
      },
      error: result.error === undefined && result.errorFacts === undefined
        ? undefined
        : {
            message: result.error ?? "Approval pause could not deliver all partial tool output.",
            domain: result.errorDomain,
            facts: result.errorFacts,
          },
    };
  }
  return { body: toolCallOutputToModelBody(result.output, result.toolName) };
}

export function toolCallOutputToModelBody(
  output: ToolCallResult["output"],
  toolName?: string,
): ToolResult["body"] {
  if (output === undefined) {
    return { format: "none" };
  }
  if (typeof output === "string") {
    return { format: "text", text: output };
  }
  return { format: "json", value: toolModelOutputProjection(output, toolName) };
}

/** Keep canonical execution facts intact while removing only duplicated transport/input facts from model delivery. */
function toolModelOutputProjection(
  output: Exclude<ToolCallResult["output"], string | undefined>,
  toolName: string | undefined,
): Exclude<ToolCallResult["output"], string | undefined> {
  if (Array.isArray(output) || output === null) return output;
  const record = output as Readonly<Record<string, unknown>>;
  if (typeof record.contentRef === "string" && isRecord(record.continuation)) {
    return compactRecord(record, [
      "contentRef",
      "contentBytes",
      "contentSha256",
      "expiresAt",
      "continuationAvailability",
    ], true);
  }
  if (toolName === "ReadOutput") {
    return compactRecord(record, [
      "ref",
      "sourceToolName",
      "sourceCallId",
      "sourceFactId",
      "continuationAvailability",
    ], true);
  }
  if (toolName === "Read") return compactRecord(record, ["path"]);
  if (toolName === "List") {
    return compactRecord(record, ["path", "depth", "offset", "limit", "maxDepth", "maxEntries"]);
  }
  if (toolName === "Grep" || toolName === "Glob") {
    return compactRecord(record, ["query", "path", "offset", "limit", "maxOffset", "offsetCeiling"]);
  }
  if (toolName === "Shell") {
    return compactRecord(record, ["command", "commandLine", "args", "logPath"]);
  }
  if (toolName === "WebSearch") return compactRecord(record, ["query"]);
  return output;
}

function compactRecord(
  record: Readonly<Record<string, unknown>>,
  omittedKeys: readonly string[],
  compactContinuation = false,
): Exclude<ToolCallResult["output"], string | undefined> {
  const omitted = new Set(omittedKeys);
  const value: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (omitted.has(key)) continue;
    if (compactContinuation && key === "continuation" && isRecord(item)) {
      value.continuation = { nextInput: item.nextInput };
      continue;
    }
    value[key] = item;
  }
  return value as Exclude<ToolCallResult["output"], string | undefined>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
