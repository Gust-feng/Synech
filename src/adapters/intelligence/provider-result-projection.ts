import { isContextOverflow, type AssistantMessage, type ImageContent, type Usage } from "@earendil-works/pi-ai";
import type { ModelInputAttachment, ModelMessage, ModelToolCall, ModelUsage } from "../../domain/intelligence/index.js";
import { normalizeToolFactValue } from "../../domain/tools/index.js";
import { modelFailureKindFromFacts } from "../../kernel/intelligence/failures.js";

/**
 * Convert a Pi AssistantMessage to the neutral ModelMessage. The provider-side
 * tool calls are exposed without a Synech invocation id; the calling loop is
 * responsible for binding them through the owning feature's acceptToolInvocations
 * hook and adding the per-message roundId before dispatching the model.
 */
export function modelMessageFromAssistant(message: AssistantMessage): ModelMessage {
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  const toolCalls: ModelToolCall[] = message.content
    .filter((block) => block.type === "toolCall")
    .map((call) => ({
      providerCallId: call.id,
      toolName: call.name,
      input: normalizeToolFactValue(call.arguments),
    }));
  return {
    role: "assistant",
    content: text,
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
  };
}

export function imageContentFromAttachments(
  attachments: readonly ModelInputAttachment[] | undefined,
): ImageContent[] {
  return (attachments ?? []).map((attachment) => {
    if (attachment.kind !== "image" || attachment.source.kind !== "data") {
      throw new Error(`Agent loop cannot persist ${attachment.kind} attachment ${attachment.attachmentId ?? "unknown"}.`);
    }
    return { type: "image", mimeType: attachment.source.mimeType, data: attachment.source.data };
  });
}

export function assistantText(message: AssistantMessage): string {
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

export function modelUsageFromProvider(usage: Usage): ModelUsage {
  return {
    requestCount: 1,
    inputTokens: usage.input + usage.cacheRead,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    cachedInputTokens: usage.cacheRead,
    cacheWriteInputTokens: usage.cacheWrite,
    uncachedInputTokens: usage.input,
    ...(usage.reasoning === undefined ? {} : { reasoningOutputTokens: usage.reasoning }),
    estimatedCostUsd: usage.cost.total,
    latestAgentRequest: {
      inputTokens: usage.input + usage.cacheRead,
      outputTokens: usage.output,
      totalTokens: usage.totalTokens,
      cachedInputTokens: usage.cacheRead,
      cacheWriteInputTokens: usage.cacheWrite,
      uncachedInputTokens: usage.input,
      ...(usage.reasoning === undefined ? {} : { reasoningOutputTokens: usage.reasoning }),
    },
  };
}

export function providerFailureFromAssistant(
  assistant: AssistantMessage,
  contextWindow: number,
): { readonly error: string; readonly errorCode: string } | undefined {
  if (isContextOverflow(assistant, contextWindow)) {
    return {
      error: assistant.errorMessage ?? "The model request exceeded the available context window.",
      errorCode: "context_overflow",
    };
  }
  if (assistant.stopReason !== "error") return undefined;
  const error = assistant.errorMessage ?? "Provider returned an error stop reason.";
  const diagnostic = [...(assistant.diagnostics ?? [])].reverse().find((item) =>
    item.type === "provider_transport_failure" || item.type === "pi_messages_response_failure");
  const status = finiteInteger(diagnostic?.details?.status);
  // SDK errors carry the account-level and policy codes inside the response
  // body, not on the error object, so the body is the structured source.
  const code = structuredProviderErrorCode(diagnostic) ?? stringOrNumber(diagnostic?.details?.code);
  return {
    error,
    errorCode: modelFailureKindFromFacts({
      ...(status === undefined ? {} : { status }),
      ...(code === undefined ? {} : { code }),
      ...(diagnostic?.error?.name === undefined ? {} : { name: diagnostic.error.name }),
    }),
  };
}

function finiteInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return undefined;
}

function stringOrNumber(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    return asRecordValue(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function asRecordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function codeFromProviderErrorBody(body: unknown): string | undefined {
  const parsed = typeof body === "string" ? parseJsonObject(body) : asRecordValue(body);
  const envelope = parsed === undefined ? undefined : asRecordValue(parsed.error) ?? parsed;
  const code = envelope?.code ?? envelope?.type;
  return typeof code === "string" && code.trim() !== "" ? code.trim() : undefined;
}

function structuredProviderErrorCode(diagnostic: {
  readonly error?: { readonly code?: string | number };
  readonly details?: Record<string, unknown>;
} | undefined): string | number | undefined {
  if (diagnostic === undefined) return undefined;
  const direct = stringOrNumber(diagnostic.error?.code);
  if (direct !== undefined) return direct;
  return codeFromProviderErrorBody(diagnostic.details?.body);
}
