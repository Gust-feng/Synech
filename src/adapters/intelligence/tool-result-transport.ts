import type { AgentHarnessEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { canonicalToolResultMessage } from "../../app/model-runtime/tool-result-message.js";
import type { ConfirmationDecision, ConfirmationRequest } from "../../domain/confirmation/index.js";
import type { ModelInputAttachment, ModelInputAttachmentRef } from "../../domain/intelligence/index.js";
import {
  copyToolModelAttachments,
  toolCallFactId,
  toolModelAttachmentsFromOutput,
  type ToolCallRequest,
  type ToolCallResult,
} from "../../domain/tools/index.js";
import { errorMessage } from "../../kernel/values/index.js";

export type ToolExecutionDetails = {
  readonly kind: "progress";
} | {
  readonly kind: "result";
  readonly result: ToolCallResult;
};

export type PendingToolResultDelivery = {
  readonly result: ToolCallResult;
};

type ToolExecutionEndEvent = Extract<AgentHarnessEvent, { readonly type: "tool_execution_end" }>;
type PiToolResultMessage = Extract<AgentMessage, { readonly role: "toolResult" }>;

export function piImmediateToolResult(input: {
  readonly request: ToolCallRequest;
  readonly rawResult: ToolExecutionEndEvent["result"];
  readonly prepared: boolean;
  readonly knownActiveTool: boolean;
  readonly cancellationRequested: boolean;
}): ToolCallResult {
  const error = piToolResultText(input.rawResult.content) ||
    `Pi did not return a canonical result for ${input.request.toolName}.`;
  if (input.cancellationRequested) {
    return {
      ...input.request,
      output: undefined,
      status: "cancelled",
      error,
      errorDomain: "runtime_error",
      errorFacts: { code: "pi_tool_call_cancelled" },
      durationMs: 0,
    };
  }
  if (input.prepared) {
    return {
      ...input.request,
      output: undefined,
      status: "failed",
      error,
      errorDomain: "tool_error",
      errorFacts: { code: "pi_tool_execution_failed", doNotBlindlyRetry: true },
      failureAttribution: "execution_failure",
      durationMs: 0,
    };
  }
  return {
    ...input.request,
    output: undefined,
    status: "failed",
    error,
    errorDomain: input.knownActiveTool ? "tool_error" : "runtime_error",
    errorFacts: {
      code: input.knownActiveTool ? "pi_tool_schema_validation_failed" : "pi_tool_call_rejected",
      doNotBlindlyRetry: true,
    },
    ...(input.knownActiveTool ? { failureAttribution: "schema_validation" as const } : {}),
    durationMs: 0,
  };
}

export function harnessToolResult(
  result: ToolCallResult,
  modelInput: {
    readonly supportsVisionInput: boolean;
    readonly modelInputSupportsImage: boolean;
  },
  terminate = false,
  addedToolNames?: readonly string[],
) {
  const deliverable = toolResultForPiTransport(
    result,
    modelInput.supportsVisionInput,
    modelInput.modelInputSupportsImage,
  );
  const message = canonicalToolResultMessage(deliverable);
  const imageContent = toolResultImageContentFromAttachments(message.attachments);
  return {
    content: [{ type: "text" as const, text: message.content }, ...imageContent],
    details: { kind: "result" as const, result: cloneToolResult(deliverable) },
    ...(deliverable === result && addedToolNames !== undefined && addedToolNames.length > 0
      ? { addedToolNames: [...addedToolNames] }
      : {}),
    ...(terminate || deliverable.errorFacts?.code === "tool_result_attachment_not_supported" ||
        deliverable.errorFacts?.code === "tool_result_image_input_unsupported" ||
        deliverable.errorFacts?.code === "tool_result_image_input_projection_mismatch"
      ? { terminate: true }
      : {}),
  };
}

export function toolResultForPiTransport(
  result: ToolCallResult,
  supportsVisionInput: boolean,
  modelInputSupportsImage: boolean,
): ToolCallResult {
  const attachments = toolModelAttachmentsFromOutput(result.output);
  const unsupported = attachments?.find((attachment) =>
    attachment.kind !== "image" || attachment.source.kind !== "data"
  );
  const image = attachments?.find((attachment) => attachment.kind === "image" && attachment.source.kind === "data");
  const deliveryFailureCode = image !== undefined && !supportsVisionInput
    ? "tool_result_image_input_unsupported"
    : image !== undefined && !modelInputSupportsImage
      ? "tool_result_image_input_projection_mismatch"
      : undefined;
  if (unsupported === undefined && deliveryFailureCode === undefined) {
    return attachments === undefined || result.modelAttachmentRefs !== undefined
      ? result
      : { ...result, modelAttachmentRefs: modelAttachmentRefsFromAttachments(attachments) };
  }
  const attachment = unsupported ?? image;
  if (attachment === undefined) return result;
  return {
    ...result,
    output: result.output === undefined ? undefined : globalThis.structuredClone(result.output),
    modelAttachmentRefs: undefined,
    status: "failed",
    error: deliveryFailureCode === undefined
      ? `Tool result could not be delivered to the Pi model because ${attachment.kind} attachments are unsupported by the active model transport.`
      : "Tool result image could not be delivered because the active model does not accept image input.",
    errorDomain: "runtime_error",
    errorFacts: {
      ...(result.errorFacts ?? {}),
      code: deliveryFailureCode ?? "tool_result_attachment_not_supported",
      sourceExecutionStatus: result.status,
      doNotBlindlyRetry: true,
      outputDeliveryPhase: "model_transport",
      attachmentKind: attachment.kind,
      attachmentSource: attachment.source.kind,
    },
    confirmationRequest: undefined,
  };
}

export function deniedToolResult(
  approval: ToolCallResult & { readonly status: "approval_required" },
  decision: ConfirmationDecision,
): ToolCallResult {
  const guidance = decision.decision === "guidance" ? decision.guidance?.trim() : undefined;
  return {
    ...approval,
    status: "failed",
    error: guidance === undefined || guidance.length === 0
      ? "User rejected this tool call."
      : `User rejected this tool call with guidance: ${guidance}`,
    errorDomain: "tool_error",
    errorFacts: { code: decision.decision === "guidance" ? "tool_call_guidance" : "tool_call_denied" },
    confirmationRequest: undefined,
  };
}

export function cancelledApprovalResult(
  approval: ToolCallResult & { readonly status: "approval_required" },
  reason: unknown,
): ToolCallResult {
  return {
    ...approval,
    status: "cancelled",
    error: `Tool call was cancelled while awaiting confirmation: ${cancellationReason(reason)}`,
    errorDomain: "tool_error",
    errorFacts: { code: "tool_call_cancelled" },
    confirmationRequest: undefined,
  };
}

export function toolResultAcceptanceFailure(result: ToolCallResult, error: unknown): ToolCallResult {
  return {
    ...result,
    output: undefined,
    status: "failed",
    error: `The owning feature could not accept this tool result: ${errorMessage(error)}`,
    errorDomain: "runtime_error",
    errorFacts: {
      code: "tool_result_acceptance_failed",
      sourceExecutionStatus: result.status,
      doNotBlindlyRetry: true,
    },
    confirmationRequest: undefined,
  };
}

export function requireConfirmationRequest(result: ToolCallResult): ConfirmationRequest {
  if (result.confirmationRequest === undefined) {
    throw new Error(`Approval-required tool result ${toolCallFactId(result)} is missing its confirmation request.`);
  }
  return result.confirmationRequest;
}

export function requireApprovalRequiredResult(
  result: ToolCallResult,
): ToolCallResult & { readonly status: "approval_required" } {
  if (result.status !== "approval_required") {
    throw new Error(`Expected an approval-required tool result, received ${result.status}.`);
  }
  return result as ToolCallResult & { readonly status: "approval_required" };
}

export function toolRequestFromResult(result: ToolCallResult): ToolCallRequest {
  return {
    callId: result.callId,
    ...(result.factId === undefined ? {} : { factId: result.factId }),
    ...(result.parentToolCallFactId === undefined ? {} : { parentToolCallFactId: result.parentToolCallFactId }),
    toolName: result.toolName,
    input: result.input,
  };
}

export function toolResultFromDetails(details: unknown): ToolCallResult | undefined {
  if (typeof details !== "object" || details === null || !("kind" in details)) return undefined;
  const candidate = details as ToolExecutionDetails;
  return candidate.kind === "result" ? candidate.result : undefined;
}

export function pendingToolResultForMessage(
  pendingToolResults: ReadonlyMap<string, PendingToolResultDelivery>,
  message: PiToolResultMessage,
  parentToolCallFactId: string | undefined,
  ambiguousResult: (message: string) => never,
): PendingToolResultDelivery | undefined {
  const detailed = toolResultFromDetails(message.details);
  if (detailed !== undefined) {
    return pendingToolResults.get(toolCallFactId(detailed));
  }
  const matches = [...pendingToolResults.values()].filter(({ result }) =>
    result.callId === message.toolCallId && result.toolName === message.toolName &&
    result.parentToolCallFactId === parentToolCallFactId);
  if (matches.length > 1) {
    return ambiguousResult(`Pi returned ambiguous pending tool results for call ${message.toolCallId}.`);
  }
  return matches[0];
}

export function toolResultHasInlineImage(result: ToolCallResult): boolean {
  return toolResultImageContentFromAttachments(canonicalToolResultMessage(result).attachments).length > 0;
}

export function cloneToolResult(result: ToolCallResult): ToolCallResult {
  const cloned = globalThis.structuredClone(result);
  if (result.output !== undefined && cloned.output !== undefined &&
      typeof result.output === "object" && result.output !== null &&
      typeof cloned.output === "object" && cloned.output !== null) {
    return {
      ...cloned,
      output: copyToolModelAttachments(result.output, cloned.output),
    };
  }
  return cloned;
}

function modelAttachmentRefsFromAttachments(
  attachments: readonly ModelInputAttachment[],
): readonly ModelInputAttachmentRef[] {
  return attachments.flatMap((attachment) => {
    if (attachment.kind !== "image" || attachment.source.kind !== "data") return [];
    return [{
      kind: "image" as const,
      ...(attachment.attachmentId === undefined ? {} : { attachmentId: attachment.attachmentId }),
      ...(attachment.inputRef === undefined ? {} : { inputRef: attachment.inputRef }),
      mimeType: attachment.source.mimeType,
      ...(attachment.byteLength === undefined ? {} : { byteLength: attachment.byteLength }),
      sha256: createHash("sha256").update(Buffer.from(attachment.source.data, "base64")).digest("hex"),
    }];
  });
}

function toolResultImageContentFromAttachments(
  attachments: readonly ModelInputAttachment[] | undefined,
): ImageContent[] {
  return (attachments ?? []).flatMap((attachment) => {
    if (attachment.kind !== "image" || attachment.source.kind !== "data") return [];
    return [{
      type: "image" as const,
      mimeType: attachment.source.mimeType,
      data: attachment.source.data,
    }];
  });
}

function piToolResultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { readonly type: "text"; readonly text: string } =>
      typeof block === "object" && block !== null &&
      "type" in block && block.type === "text" &&
      "text" in block && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function cancellationReason(reason: unknown): string {
  return reason === undefined ? "cancelled" : errorMessage(reason);
}
