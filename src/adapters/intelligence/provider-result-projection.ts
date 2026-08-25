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

export function providerRefusalFromAssistant(assistant: AssistantMessage): string | undefined {
  const diagnostic = assistant.diagnostics?.find((item) => item.type === "provider_refusal");
  if (diagnostic === undefined) return undefined;
  const refusal = diagnostic.details?.refusal;
  return typeof refusal === "string" ? refusal.trim() : "";
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
  const code = diagnostic?.error?.code ?? stringOrNumber(diagnostic?.details?.code);
  const incompleteReason = assistant.providerMetadata?.incompleteReason;
  return {
    error,
    errorCode: modelFailureKindFromFacts({
      ...(incompleteReason === "content_filter" ? { explicitKind: "content_filtered" as const } : {}),
      ...(status === undefined ? {} : { status }),
      ...(code === undefined ? {} : { code }),
      ...(diagnostic?.error?.name === undefined ? {} : { name: diagnostic.error.name }),
    }),
  };
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function stringOrNumber(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}
