import { setTimeout as sleep } from "node:timers/promises";
import type {
  IntelligenceChannel,
  ModelProvider,
  ModelRequest,
  ModelRequestOptions,
  ModelResponse,
} from "../../domain/intelligence/index.js";
import { createFailedModelResponseFromError } from "./failures.js";
import { validateModelResponse } from "./validation.js";

export type NativeIntelligenceChannelOptions = {
  readonly provider: ModelProvider;
};

const RETRY_POLICY = {
  maxRetries: 3,
  baseDelayMs: 300,
  maxDelayMs: 5_000,
  jitterRatio: 0.2,
} as const;

export class NativeIntelligenceChannel implements IntelligenceChannel {
  constructor(private readonly options: NativeIntelligenceChannelOptions) {}

  async request(request: ModelRequest, options: ModelRequestOptions = {}): Promise<ModelResponse> {
    const providerResponse = await requestProviderWithRetry(
      this.options.provider,
      request,
      options,
    );

    const validation = this.validateResponse(request, providerResponse);
    const response = normalizeValidatedResponse(providerResponse, validation);

    return response;
  }

  validateResponse(request: ModelRequest, response: ModelResponse) {
    return validateModelResponse(request, response);
  }
}

async function requestProviderWithRetry(
  provider: ModelProvider,
  request: ModelRequest,
  options: ModelRequestOptions,
): Promise<ModelResponse> {
  let attempt = 0;
  for (;;) {
    let response: ModelResponse;
    try {
      response = await provider.complete(request, options);
    } catch (error) {
      response = createFailedModelResponseFromError({
        requestId: request.requestId,
        providerId: provider.providerId,
        providerKind: provider.providerKind,
        protocolKind: provider.protocolKind,
        model: provider.model,
        outputKind: request.outputContract.outputKind,
        error,
        fallbackMessage: "Model provider request failed.",
      });
    }
    if (!shouldRetryFailedResponse(response, attempt, options)) {
      return response;
    }
    await sleepBeforeRetry(attempt, options.abortSignal);
    if (options.abortSignal?.aborted === true) {
      return response;
    }
    attempt += 1;
  }
}

function shouldRetryFailedResponse(
  response: ModelResponse,
  attempt: number,
  options: ModelRequestOptions
): boolean {
  return options.abortSignal?.aborted !== true &&
    response.status === "failed" &&
    response.failure?.retryable === true &&
    attempt < RETRY_POLICY.maxRetries;
}

async function sleepBeforeRetry(
  retryIndex: number,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  const delayMs = retryDelayMs(retryIndex);
  if (delayMs <= 0 || isAborted(abortSignal)) {
    return;
  }
  await defaultRetrySleep(delayMs, abortSignal);
}

function retryDelayMs(retryIndex: number): number {
  const exponential = Math.min(RETRY_POLICY.maxDelayMs, RETRY_POLICY.baseDelayMs * 2 ** Math.max(0, retryIndex));
  const jitter = 1 + ((Math.random() * 2) - 1) * RETRY_POLICY.jitterRatio;
  return Math.max(0, Math.round(exponential * jitter));
}

async function defaultRetrySleep(delayMs: number, abortSignal?: AbortSignal): Promise<void> {
  if (delayMs <= 0 || isAborted(abortSignal)) {
    return;
  }
  try {
    await sleep(delayMs, undefined, { signal: abortSignal });
  } catch (error) {
    if (!isAborted(abortSignal)) {
      throw error;
    }
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function normalizeValidatedResponse(
  response: ModelResponse,
  validation: ModelResponse["validation"]
): ModelResponse {
  if (response.status === "completed" && validation.status === "passed") {
    return { ...response, validation };
  }

  if (response.status !== "completed") {
    return {
      ...response,
      validation: response.validation.status === "pending" ? validation : response.validation,
    };
  }

  return {
    ...response,
    status: "failed",
    finishReason: "error",
    validation,
    failure: {
      kind: "output_validation",
      retryable: false,
      message: "Model output failed the requested output contract.",
      sanitizedErrorRef: "model-error:output_validation",
    },
  };
}
