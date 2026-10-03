import { stringOrUndefined } from "../values/index.js";
import type { ConfirmationRequest } from "../../domain/confirmation/index.js";
import type {
  ToolCallRequest,
  ToolDefinition,
  ToolDefinitionMetadata,
  ToolSecurityDecision,
  ToolSecurityEvaluationContext,
} from "../../domain/tools/index.js";
import { commandTextFromValue, toolInvocationId, toolPresentationForDefinition } from "../../domain/tools/index.js";
import { nowIso } from "../id.js";

export function evaluateToolCallSecurity(input: {
  readonly request: ToolCallRequest;
  readonly definition: ToolDefinition;
  readonly metadata: ToolDefinitionMetadata;
  readonly context: ToolSecurityEvaluationContext;
}): ToolSecurityDecision {
  const confirmationId = confirmationIdForToolCall(toolInvocationId(input.request));
  if (input.context.approvedConfirmationIds?.includes(confirmationId) === true) {
    return { decision: "allow", reason: "Matching confirmation id was approved for this tool call." };
  }

  // Only an explicit HTTP executor contract gives method fields network meaning.
  const httpWrite = input.metadata.runtimeHints?.some((hint) => hint.kind === "http_request") === true &&
    isSideEffectHttpSubmission(input.request);
  if (input.metadata.requiresConfirmation === true || httpWrite) {
    if (input.context.accessPolicy?.approvalMode === "bypass") {
      return { decision: "allow", reason: "Full access mode allows confirmation-gated tool calls." };
    }
    return approvalDecision({
      request: input.request,
      definition: input.definition,
      metadata: input.metadata,
    });
  }

  return { decision: "allow", reason: "Tool call is allowed by metadata and platform policy." };
}

export function confirmationRequestFromSecurityDecision(input: {
  readonly request: ToolCallRequest;
  readonly decision: Extract<ToolSecurityDecision, { readonly decision: "approval_required" }>;
}): ConfirmationRequest {
  return {
    confirmationId: confirmationIdForToolCall(toolInvocationId(input.request)),
    invocationId: toolInvocationId(input.request),
    title: input.decision.title,
    actionSummary: input.decision.actionSummary,
    consequence: input.decision.consequence,
    affectedResources: input.decision.affectedResources,
    riskLevel: input.decision.riskLevel,
    resumeAvailability: "live",
    requestedAt: nowIso(),
    sourceRefs: input.decision.sourceRefs,
  };
}

export function confirmationIdForToolCall(callId: string): string {
  return `confirmation-${callId}`;
}

function approvalDecision(input: {
  readonly request: ToolCallRequest;
  readonly definition: ToolDefinition;
  readonly metadata: ToolDefinitionMetadata;
}): Extract<ToolSecurityDecision, { readonly decision: "approval_required" }> {
  const presentation = toolPresentationForDefinition(input.definition);
  const affectedResources = affectedResourcesFromInput(input.request.input);
  const actionSummary = compactPolicyText(
    confirmationActionSummary(presentation.displayName, affectedResources),
    500
  );
  const consequence = compactPolicyText(
    confirmationConsequence(presentation.displayName),
    500
  );
  return {
    decision: "approval_required",
    reason: `等待确认：${actionSummary}`,
    title: presentation.displayName,
    actionSummary,
    consequence,
    affectedResources,
    riskLevel: input.metadata.riskLevel,
    sourceRefs: [`tool:${toolInvocationId(input.request)}`],
  };
}

function confirmationActionSummary(displayName: string, affectedResources: readonly string[]): string {
  return affectedResources.length === 0
    ? displayName
    : `${displayName}：${affectedResources.join("、")}`;
}

function confirmationConsequence(displayName: string): string {
  return `批准后只执行本次${displayName}。`;
}

const SIDE_EFFECT_HTTP_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

function isSideEffectHttpSubmission(request: ToolCallRequest): boolean {
  const record = asRecord(request.input);
  const method = stringOrUndefined(record.method)?.toUpperCase();
  return stringOrUndefined(record.url) !== undefined &&
    method !== undefined &&
    SIDE_EFFECT_HTTP_METHODS.has(method);
}

function affectedResourcesFromInput(input: unknown): readonly string[] {
  const record = asRecord(input);
  const commandText = commandTextFromValue(record);
  const values = [
    commandText,
    stringOrUndefined(record.path),
    stringOrUndefined(record.url),
    stringOrUndefined(record.ref),
  ];
  return values.filter((value): value is string => value !== undefined).map((value) => compactPolicyText(value, 240)).slice(0, 8);
}

function compactPolicyText(value: string, maxLength = 1_200): string {
  const text = value.trim();
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}
