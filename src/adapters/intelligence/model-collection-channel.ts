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
  isRetryableModelFailure,
  modelFailureDetailWithCode,
  modelFailureKindFromFacts,
} from "../../kernel/intelligence/failures.js";
import { NativeIntelligenceChannel } from "../../kernel/intelligence/channel.js";
import { pendingModelOutputValidation } from "../../kernel/intelligence/validation.js";
import { modelUsageFromProvider } from "./provider-result-projection.js";
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

    const attempt = attemptLatencyAbort({
      callerSignal: requestOptions.abortSignal,
      maxLatencyMs: request.budget.maxLatencyMs,
    });
    try {
      const assistant = await this.options.modelRegistry.completeSimple(
        this.options.selectedModel,
        context.value,
        {
          signal: attempt.signal,
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
        cancelledByCaller: attempt.cancelledByCaller(),
        timedOut: attempt.timedOut(),
        maxLatencyMs: request.budget.maxLatencyMs,
      });
    } catch (error) {
      if (attempt.cancelledByCaller()) {
        return cancelledResponse(request, this.providerId, this.providerKind, this.protocolKind, this.model);
      }
      if (attempt.timedOut()) {
        return timedOutResponse(request, this.providerId, this.providerKind, this.protocolKind, this.model, request.budget.maxLatencyMs);
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
      if (message.attachments !== undefined) {
        return { error: "Pi model collection channel cannot carry system message attachments." };
      }
      systemPrompt = message.content;
      continue;
    }
    if (message.role !== "user" || message.attachments !== undefined) {
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
  readonly cancelledByCaller: boolean;
  readonly timedOut: boolean;
  readonly maxLatencyMs: number | undefined;
}): ModelResponse {
  if (input.cancelledByCaller) {
    return cancelledResponse(input.request, input.providerId, input.providerKind, input.protocolKind, input.model);
  }
  if (input.timedOut) {
    return timedOutResponse(
      input.request,
      input.providerId,
      input.providerKind,
      input.protocolKind,
      input.model,
      input.maxLatencyMs,
    );
  }
  if (input.assistant.stopReason === "aborted") {
    return cancelledResponse(input.request, input.providerId, input.providerKind, input.protocolKind, input.model);
  }
  if (input.assistant.stopReason === "error") {
    // Pi 把 provider 失败收进 assistant 消息（errorMessage + diagnostics）而不是抛出：
    // 失败分类按共享层的结构化事实推导（HTTP 状态 / 错误码 / 错误名），retryable
    // 显式给出。消费方（如研究的重试判定）只读 response.failure 的结构字段，
    // 不按错误文案自行判定。
    const facts = assistantFailureFacts(input.assistant);
    const failureKind = modelFailureKindFromFacts(facts);
    return createFailedModelResponse({
      requestId: input.request.requestId,
      providerId: input.providerId,
      providerKind: input.providerKind,
      protocolKind: input.protocolKind,
      model: input.model,
      outputKind: input.request.outputContract.outputKind,
      failureKind,
      retryable: isRetryableModelFailure(failureKind),
      // 429 等状态位判定之后，原始 code 仍要留在诊断详情里（账户级/项目级限额
      // 与普通限流的区别只在 code 中）。
      message: modelFailureDetailWithCode(
        input.assistant.errorMessage ?? "Pi model collection request failed.",
        facts.code,
      ),
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
    // 用量口径与 loop 侧共用同一份共享转换（inputTokens 含 cacheRead），
    // 不在这里维护第二份组装规则。
    usage: modelUsageFromProvider(input.assistant.usage),
    finishReason: input.assistant.stopReason === "length" ? "length" : "stop",
    validation: pendingModelOutputValidation(),
    completedAt: nowIso(),
  };
}

/**
 * Pi 失败诊断中的结构化事实：`details.status` 是 provider 返回的 HTTP 状态，
 * `error` 携带原始错误的 code / name。没有可用诊断时返回空事实，共享分类落到
 * `provider_response` 兜底——与透传前的硬编码相同，但 `retryable` 现在由共享
 * 策略显式决定，消费方不再需要按错误文案补偿。
 */
function assistantFailureFacts(assistant: AssistantMessage): {
  readonly status?: number;
  readonly code?: string | number;
  readonly name?: string | number;
} {
  const diagnostic = (assistant.diagnostics ?? []).find(
    (entry) => entry.error !== undefined || typeof entry.details?.status === "number",
  );
  if (diagnostic === undefined) return {};
  const status = diagnostic.details?.status;
  return {
    ...(typeof status === "number" && Number.isFinite(status) ? { status: Math.trunc(status) } : {}),
    ...(diagnostic.error?.code === undefined ? {} : { code: diagnostic.error.code }),
    ...(diagnostic.error?.name === undefined ? {} : { name: diagnostic.error.name }),
  };
}

/**
 * Merges this attempt's latency budget into its abort signal and keeps the two
 * abort causes apart.
 *
 * Pi's `timeoutMs` rejects the request without touching the caller's signal, so
 * before this merge a timed-out attempt left `abortSignal.aborted === false`,
 * looked like a retryable `provider_timeout`, and every retry spent another
 * full budget. Callers that already merged their own timeout into the signal
 * they pass (research) keep their semantics: whichever timeout fires first
 * aborts, and a caller-side timeout still settles as a cancellation.
 */
function attemptLatencyAbort(input: {
  readonly callerSignal: AbortSignal | undefined;
  readonly maxLatencyMs: number | undefined;
}): {
  readonly signal: AbortSignal | undefined;
  readonly cancelledByCaller: () => boolean;
  readonly timedOut: () => boolean;
} {
  if (input.maxLatencyMs === undefined) {
    return {
      signal: input.callerSignal,
      cancelledByCaller: () => input.callerSignal?.aborted === true,
      timedOut: () => false,
    };
  }
  const timeoutSignal = AbortSignal.timeout(input.maxLatencyMs);
  let timedOut = false;
  timeoutSignal.addEventListener("abort", () => { timedOut = true; }, { once: true });
  return {
    signal: input.callerSignal === undefined
      ? timeoutSignal
      : AbortSignal.any([input.callerSignal, timeoutSignal]),
    cancelledByCaller: () => input.callerSignal?.aborted === true,
    timedOut: () => timedOut,
  };
}

function timedOutResponse(
  request: ModelRequest,
  providerId: string,
  providerKind: ModelProviderKind,
  protocolKind: ModelProvider["protocolKind"],
  model: string,
  maxLatencyMs: number | undefined,
): ModelResponse {
  return createFailedModelResponse({
    requestId: request.requestId,
    providerId,
    providerKind,
    protocolKind,
    model,
    outputKind: request.outputContract.outputKind,
    failureKind: "provider_timeout",
    // Our own latency budget firing is terminal for the whole request: the same
    // request would need the same time again, so retrying only multiplies the
    // user's wait instead of recovering anything.
    retryable: false,
    message: `Pi model collection request exceeded the ${maxLatencyMs ?? "configured"} ms latency budget and was aborted.`,
  });
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
    // Cancellation is a structured response status, not a provider failure.
    // The previous `provider_network` failure block made a user cancel look
    // like a network fault in failure statistics.
    status: "cancelled",
    outputKind: request.outputContract.outputKind,
    finishReason: "error",
    validation: pendingModelOutputValidation(),
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
  if (model.api === "anthropic-messages") return "anthropic_messages";
  if (model.api === "openai-completions") return "openai_compatible_chat_completions";
  if (model.api === "openai-responses") return "openai_responses";
  throw new Error(`Pi model collection channel does not support API ${model.api}.`);
}
