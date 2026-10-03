import type { ModelMessage } from "../../domain/intelligence/index.js";
import type { ToolFactValue } from "../../domain/tools/index.js";
import type { ModelToolCall } from "../../domain/intelligence/contracts.js";

export function cloneModelMessage(message: ModelMessage): ModelMessage {
  return {
    ...message,
    attachments: message.attachments?.map((attachment) => globalThis.structuredClone(attachment)),
    toolCalls: message.toolCalls?.map(cloneModelToolCall),
  };
}

export function cloneModelToolCall(request: ModelToolCall): ModelToolCall {
  return {
    ...request,
    input: cloneToolFact(request.input),
  };
}

function cloneToolFact<T extends ToolFactValue | undefined>(value: T): T {
  if (value === undefined || value === null || typeof value !== "object") {
    return value;
  }
  return globalThis.structuredClone(value);
}
