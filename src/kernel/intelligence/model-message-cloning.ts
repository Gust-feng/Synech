import type { ModelMessage } from "../../domain/intelligence/index.js";
import type { ToolCallRequest, ToolCallResult, ToolFactValue } from "../../domain/tools/index.js";
import { copyToolModelAttachments } from "../../domain/tools/index.js";

export function cloneModelMessage(message: ModelMessage): ModelMessage {
  return {
    ...message,
    attachments: message.attachments?.map((attachment) => globalThis.structuredClone(attachment)),
    protocolExtensions:
      message.protocolExtensions === undefined ? undefined : globalThis.structuredClone(message.protocolExtensions),
    toolCalls: message.toolCalls?.map(cloneToolCallRequest),
  };
}

export function cloneToolCallRequest(request: ToolCallRequest): ToolCallRequest {
  return {
    callId: request.callId,
    toolName: request.toolName,
    input: cloneToolFact(request.input),
  };
}

export function cloneToolResults(results: readonly ToolCallResult[]): ToolCallResult[] {
  return results.map(cloneToolResult);
}

export function cloneToolResult(result: ToolCallResult): ToolCallResult {
  return {
    ...result,
    input: cloneToolFact(result.input),
    output: cloneToolFact(result.output),
    confirmationRequest:
      result.confirmationRequest === undefined ? undefined : globalThis.structuredClone(result.confirmationRequest),
  };
}

function cloneToolFact<T extends ToolFactValue | undefined>(value: T): T {
  if (value === undefined || value === null || typeof value !== "object") {
    return value;
  }
  const cloned = globalThis.structuredClone(value) as T;
  return copyToolModelAttachments(value, cloned as object) as T;
}
