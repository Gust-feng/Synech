import { asRecord } from "../../../../kernel/values/index.js";
import type { ToolDisplayProjection } from "../../tool-display.js";
import type {
  DelegatedAgentExecutionMetadata,
  DelegatedAgentUsage,
  ToolErrorDomain,
  ToolErrorFacts,
  ToolFactValue,
} from "../../../../domain/tools/index.js";
import { isToolErrorDomain, toolDisplayName } from "../../../../domain/tools/index.js";
import { projectToolDisplay } from "../tool-projection/tool-display-projection.js";

export type PanelRunStreamEventDetail = {
  readonly kind: "tool";
  readonly display?: ToolDisplayProjection;
  readonly error?: string;
  readonly errorDomain?: ToolErrorDomain;
  readonly errorFacts?: ToolErrorFacts;
  readonly delegatedExecution?: DelegatedAgentExecutionMetadata;
};

export function toolSummary(
  type: "tool.requested" | "tool.completed" | "tool.failed" | "tool.cancelled",
  payload: Readonly<Record<string, unknown>>
): string {
  const toolName = stringOrUndefined(payload.toolName) ?? "unknown";
  const displayName = stringOrUndefined(payload.toolDisplayName) ?? localToolLabel(toolName);
  if (type === "tool.requested") {
    return displayName;
  }
  if (type === "tool.completed") {
    return `${displayName}完成。`;
  }
  return type === "tool.cancelled"
    ? `${displayName}已取消。`
    : `${displayName}失败。`;
}

export function toolStreamDetail(
  type: "tool.requested" | "tool.completed" | "tool.failed" | "tool.cancelled",
  payload: Readonly<Record<string, unknown>>
): PanelRunStreamEventDetail {
  const toolName = stringOrUndefined(payload.toolName) ?? "tool";
  const input = asRecord(payload.input);
  const output = payload.output;
  const outputRecord = asRecord(output);
  const callId = stringOrUndefined(payload.callId) ?? "panel-tool";
  const display = projectToolDisplay({
    providerCallId: callId,
    invocationId: callId,
    toolName,
    input: cloneToolFactValue(input),
  }, cloneToolFactValue(output));
  const errorDomain = errorDomainFromToolFacts(payload, outputRecord);
  const errorFacts = errorFactsFromToolFacts(payload, outputRecord);
  return {
    kind: "tool",
    display,
    error: type === "tool.failed"
      ? stringOrUndefined(payload.error)
      : type === "tool.cancelled"
        ? stringOrUndefined(payload.reason)
        : undefined,
    errorDomain,
    errorFacts,
    delegatedExecution: delegatedExecutionFromPayload(payload),
  };
}

function delegatedExecutionFromPayload(
  payload: Readonly<Record<string, unknown>>,
): DelegatedAgentExecutionMetadata | undefined {
  const candidate = asRecord(payload.delegatedExecution);
  const usage = asRecord(candidate.usage);
  const modelRounds = candidate.modelRounds;
  const toolCallCount = candidate.toolCallCount;
  if (!isNonnegativeInteger(modelRounds) || !isNonnegativeInteger(toolCallCount)) {
    return undefined;
  }
  return {
    modelRounds,
    toolCallCount,
    usage: delegatedUsageFromRecord(usage),
  };
}

function delegatedUsageFromRecord(usage: Readonly<Record<string, unknown>>): DelegatedAgentUsage {
  return {
    ...numberUsageFact(usage, "requestCount"),
    ...numberUsageFact(usage, "inputTokens"),
    ...numberUsageFact(usage, "outputTokens"),
    ...numberUsageFact(usage, "totalTokens"),
    ...numberUsageFact(usage, "cachedInputTokens"),
    ...numberUsageFact(usage, "cacheWriteInputTokens"),
    ...numberUsageFact(usage, "uncachedInputTokens"),
    ...numberUsageFact(usage, "reasoningOutputTokens"),
    ...numberUsageFact(usage, "estimatedCostUsd"),
  };
}

function numberUsageFact(
  usage: Readonly<Record<string, unknown>>,
  key: keyof DelegatedAgentUsage,
): Partial<DelegatedAgentUsage> {
  const value = usage[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? { [key]: value } : {};
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function toolErrorDomainOrUndefined(value: unknown): ToolErrorDomain | undefined {
  return isToolErrorDomain(value) ? value : undefined;
}

function cloneToolFactValue(value: unknown): ToolFactValue | undefined {
  return value === undefined ? undefined : globalThis.structuredClone(value as ToolFactValue);
}

function toolErrorFactsOrUndefined(value: unknown): ToolErrorFacts | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? globalThis.structuredClone(value as ToolErrorFacts)
    : undefined;
}

function errorDomainFromToolFacts(
  payload: Readonly<Record<string, unknown>>,
  output: Readonly<Record<string, unknown>>,
): ToolErrorDomain | undefined {
  return toolErrorDomainOrUndefined(output.errorDomain) ?? toolErrorDomainOrUndefined(payload.errorDomain);
}

function errorFactsFromToolFacts(
  payload: Readonly<Record<string, unknown>>,
  output: Readonly<Record<string, unknown>>,
): ToolErrorFacts | undefined {
  return toolErrorFactsOrUndefined(output.errorFacts) ?? toolErrorFactsOrUndefined(payload.errorFacts);
}


function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function localToolLabel(toolName: string): string {
  return toolDisplayName(toolName);
}
