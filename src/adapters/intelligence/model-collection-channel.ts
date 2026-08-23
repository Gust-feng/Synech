import type {
  Api,
  AssistantMessage,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelPurpose } from "../../domain/intelligence/index.js";
import type {
  IntelligenceChannel,
  ModelProvider,
  ModelProviderKind,
  ModelRequest,
  ModelRequestOptions,
  ModelResponse,
} from "../../domain/intelligence/index.js";
import { createId, nowIso } from "../../kernel/id.js";
import {
  createFailedModelResponse,
  createFailedModelResponseFromError,
} from "../../kernel/intelligence/failures.js";
import { NativeIntelligenceChannel } from "../../kernel/intelligence/channel.js";
import { pendingModelOutputValidation } from "../../kernel/intelligence/validation.js";
import type { ModelProviderPayloadTransformer } from "./model-provider-binding.js";

export type ModelCollectionChannelOptions = {
  readonly modelRegistry: Models;
  readonly selectedModel: Model<Api>;
  readonly thinkingLevel?: ThinkingLevel;
  readonly transformProviderPayload?: ModelProviderPayloadTransformer;
  readonly supportedPurposes?: readonly ModelPurpose[];
  readonly providerKind?: ModelProviderKind;
};

/**
 * Adapts Pi's simple model collection call to the neutral channel contract.
 * This intentionally supports only no-tool requests; tool loops stay owned by
 * the Pi Agent Session adapter and parity-sensitive shared consumers keep the
 * direct protocol adapters until their contracts can round-trip through Pi.
 */
export function createModelCollectionChannel(
  options: ModelCollectionChannelOptions,
): IntelligenceChannel {
  const provider = new ModelCollectionProvider(options);
  return new NativeIntelligenceChannel({ provider });
}

class ModelCollectionProvider implements ModelProvider {
  readonly providerId: string;
  readonly providerKind: ModelProviderKind;
  readonly protocolKind: ModelProvider["protocolKind"];
  readonly model: string;

  constructor(private readonly options: ModelCollectionChannelOptions) {
    this.providerId = options.selectedModel.provider;
    this.providerKind = options.providerKind ?? "openai_compatible";
    this.protocolKind = protocolForModel(options.selectedModel);
    this.model = options.selectedModel.id;
  }

  async complete(request: ModelRequest, requestOptions: ModelRequestOptions = {}): Promise<ModelResponse> {
    const unsupported = unsupportedRequestReason(request, this.options.supportedPurposes);
    if (unsupported !== undefined) {
      return createFailedModelResponse({
        requestId: request.requestId,
        providerId: this.providerId,
        providerKind: this.providerKind,
        protocolKind: this.protocolKind,
        model: this.model,
        outputKind: request.outputContract.outputKind,
        failureKind: "request_validation",
        message: unsupported,
      });
    }

    const context = contextFromRequest(request);
    if (context.error !== undefined || context.value === undefined) {
      return createFailedModelResponse({
        requestId: request.requestId,
        providerId: this.providerId,
        providerKind: this.providerKind,
        protocolKind: this.protocolKind,
        model: this.model,
        outputKind: request.outputContract.outputKind,
        failureKind: "request_validation",
        message: context.error ?? "Pi model collection channel could not build a model context.",
      });
    }

    try {
      const assistant = await this.options.modelRegistry.completeSimple(
        this.options.selectedModel,
        context.value,
        {
          signal: requestOptions.abortSignal,
          maxTokens: Math.min(
            request.budget.maxOutputTokens ?? this.options.selectedModel.maxTokens,
            this.options.selectedModel.maxTokens,
          ),
          timeoutMs: request.budget.maxLatencyMs,
          reasoning: this.options.thinkingLevel === "off" ? undefined : this.options.thinkingLevel,
          ...(this.options.transformProviderPayload === undefined
            ? {}
            : {
                onPayload: (payload: unknown) => this.options.transformProviderPayload?.({
                  model: this.options.selectedModel,
                  payload,
                  tools: [],
                }) ?? payload,
              }),
        },
      );
      return responseFromAssistant({
        request,
        assistant,
        providerId: this.providerId,
        providerKind: this.providerKind,
        protocolKind: this.protocolKind,
        model: this.model,
        aborted: requestOptions.abortSignal?.aborted === true,
      });
    } catch (error) {
      if (requestOptions.abortSignal?.aborted === true) {
      return cancelledResponse(request, this.providerId, this.providerKind, this.protocolKind, this.model);
      }
      return createFailedModelResponseFromError({
        requestId: request.requestId,
        providerId: this.providerId,
        providerKind: this.providerKind,
        protocolKind: this.protocolKind,
        model: this.model,
        outputKind: request.outputContract.outputKind,
        error,
        fallbackMessage: "Pi model collection request failed.",
      });
    }
  }
}

function unsupportedRequestReason(
  request: ModelRequest,
  supportedPurposes: readonly ModelPurpose[] | undefined,
): string | undefined {
  if (supportedPurposes !== undefined && !supportedPurposes.includes(request.purpose)) {
    return `Pi model collection channel does not support model purpose ${request.purpose}.`;
  }
  if ((request.tools?.length ?? 0) > 0 || request.toolChoice !== undefined && request.toolChoice !== "none") {
    return "Pi model collection channel only accepts requests without tools.";
  }
  if (
    request.budget.maxInputTokens !== undefined ||
    request.budget.maxTotalTokens !== undefined ||
    request.budget.maxCostUsd !== undefined
  ) {
    return "Pi model collection channel cannot enforce input, total-token, or cost budgets.";
  }
  return undefined;
}

function contextFromRequest(request: ModelRequest): {
  readonly value?: {
    readonly systemPrompt?: string;
    readonly messages: Array<{ readonly role: "user"; readonly content: string; readonly timestamp: number }>;
  };
  readonly error?: string;
} {
  let systemPrompt: string | undefined;
  const messages: Array<{ readonly role: "user"; readonly content: string; readonly timestamp: number }> = [];
  for (const message of request.sanitizedMessages) {
    if (message.role === "system" && systemPrompt === undefined) {
      if (message.attachments !== undefined || message.protocolExtensions !== undefined) {
        return { error: "Pi model collection channel cannot carry system message attachments or protocol extensions." };
      }
      systemPrompt = message.content;
      continue;
    }
    if (message.role !== "user" || message.attachments !== undefined || message.protocolExtensions !== undefined) {
      return { error: "Pi model collection channel only accepts text system and user messages." };
    }
    messages.push({ role: "user", content: message.content, timestamp: Date.now() });
  }
  if (messages.length === 0) {
    return { error: "Pi model collection channel requires at least one user message." };
  }
  return { value: { systemPrompt, messages } };
}

function responseFromAssistant(input: {
  readonly request: ModelRequest;
  readonly assistant: AssistantMessage;
  readonly providerId: string;
  readonly providerKind: ModelProviderKind;
  readonly protocolKind: ModelProvider["protocolKind"];
  readonly model: string;
  readonly aborted: boolean;
}): ModelResponse {
  if (input.aborted || input.assistant.stopReason === "aborted") {
    return cancelledResponse(input.request, input.providerId, input.providerKind, input.protocolKind, input.model);
  }
  if (input.assistant.stopReason === "error") {
    return createFailedModelResponse({
      requestId: input.request.requestId,
      providerId: input.providerId,
      providerKind: input.providerKind,
      protocolKind: input.protocolKind,
      model: input.model,
      outputKind: input.request.outputContract.outputKind,
      failureKind: "provider_response",
      message: input.assistant.errorMessage ?? "Pi model collection request failed.",
    });
  }
  if (input.assistant.content.some((block) => block.type === "toolCall")) {
    return createFailedModelResponse({
      requestId: input.request.requestId,
      providerId: input.providerId,
      providerKind: input.providerKind,
      protocolKind: input.protocolKind,
      model: input.model,
      outputKind: input.request.outputContract.outputKind,
      failureKind: "provider_response",
      message: "Pi model collection channel received an unexpected tool call.",
    });
  }
  const textOutput = input.assistant.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const thinkingOutput = input.assistant.content
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking)
    .join("\n");
  const structuredOutput = input.request.outputContract.format === "json_object"
    ? parseJsonObject(textOutput)
    : undefined;
  return {
    responseId: input.assistant.responseId ?? createId("model-response"),
    requestId: input.request.requestId,
    providerId: input.providerId,
    providerKind: input.providerKind,
    protocolKind: input.protocolKind,
    model: input.model,
    status: "completed",
    outputKind: input.request.outputContract.outputKind,
    ...(structuredOutput === undefined ? {} : { structuredOutput }),
    ...(textOutput.length === 0 ? {} : { textOutput }),
    ...(thinkingOutput.length === 0
      ? {}
      : { reasoningOutput: { source: "provider_reasoning_content" as const, content: thinkingOutput, truncated: false } }),
    assistantMessage: { role: "assistant", content: textOutput },
    usage: {
      requestCount: 1,
      inputTokens: input.assistant.usage.input,
      outputTokens: input.assistant.usage.output,
      totalTokens: input.assistant.usage.totalTokens,
      cachedInputTokens: input.assistant.usage.cacheRead,
      cacheWriteInputTokens: input.assistant.usage.cacheWrite,
      uncachedInputTokens: input.assistant.usage.input,
      ...(input.assistant.usage.reasoning === undefined
        ? {}
        : { reasoningOutputTokens: input.assistant.usage.reasoning }),
    },
    finishReason: input.assistant.stopReason === "length" ? "length" : "stop",
    validation: pendingModelOutputValidation(),
    completedAt: nowIso(),
  };
}

function cancelledResponse(
  request: ModelRequest,
  providerId: string,
  providerKind: ModelProviderKind,
  protocolKind: ModelProvider["protocolKind"],
  model: string,
): ModelResponse {
  return {
    responseId: createId("model-response"),
    requestId: request.requestId,
    providerId,
    providerKind,
    protocolKind,
    model,
    status: "cancelled",
    outputKind: request.outputContract.outputKind,
    finishReason: "error",
    validation: pendingModelOutputValidation(),
    failure: {
      kind: "provider_network",
      retryable: false,
      message: "Pi model collection request was cancelled.",
      sanitizedErrorRef: "model-error:cancelled",
    },
    completedAt: nowIso(),
  };
}

function parseJsonObject(value: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, unknown>>
      : undefined;
  } catch {
    return undefined;
  }
}

function protocolForModel(model: Model<Api>): ModelProvider["protocolKind"] {
  if (model.api === "openai-completions") return "openai_compatible_chat_completions";
  if (model.api === "openai-responses") return "openai_responses";
  throw new Error(`Pi model collection channel does not support API ${model.api}.`);
}
