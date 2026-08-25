import type { ModelMessage } from "../../domain/intelligence/index.js";
import type { ToolCallResult, ToolFactValue } from "../../domain/tools/index.js";
import type { ModelToolCall } from "../../domain/intelligence/contracts.js";
import { copyToolModelAttachments } from "../../domain/tools/index.js";

export function cloneModelMessage(message: ModelMessage): ModelMessage {
  return {
    ...message,
    attachments: message.attachments?.map((attachment) => globalThis.structuredClone(attachment)),
    protocolExtensions:
      message.protocolExtensions === undefined ? undefined : globalThis.structuredClone(message.protocolExtensions),
    toolCalls: message.toolCalls?.map(cloneModelToolCall),
  };
}

export function cloneModelToolCall(request: ModelToolCall): ModelToolCall {
  return {
    ...request,
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
