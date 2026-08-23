import { setTimeout as sleep } from "node:timers/promises";
import type {
  IntelligenceChannel,
  ModelProvider,
  ModelRequest,
  ModelRequestOptions,
  ModelResponse,
} from "../../domain/intelligence/index.js";
import { nowIso } from "../id.js";
import { createFailedModelResponse, createFailedModelResponseFromError } from "./failures.js";
import { validateModelRequest, validateModelResponse } from "./validation.js";

export type NativeIntelligenceChannelOptions = {
  readonly provider: ModelProvider;
  readonly retryPolicy?: ModelRequestRetryPolicy;
};

export type ModelRequestRetryPolicy = {
  /** Number of retries after the initial provider attempt. */
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
  readonly sleep?: (delayMs: number, abortSignal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
};

export class NativeIntelligenceChannel implements IntelligenceChannel {
  constructor(private readonly options: NativeIntelligenceChannelOptions) {}

  async request(request: ModelRequest, options: ModelRequestOptions = {}): Promise<ModelResponse> {
    const requestValidation = validateModelRequest(request);
    if (!requestValidation.passed) {
      const response = createFailedModelResponse({
        requestId: request.requestId ?? "invalid-model-request",
        providerId: this.options.provider.providerId,
        providerKind: this.options.provider.providerKind,
        protocolKind: this.options.provider.protocolKind,
        model: this.options.provider.model,
        outputKind: request.outputContract?.outputKind ?? "candidate",
        failureKind: "request_validation",
        message: "ModelRequest failed intelligence channel validation.",
        validation: {
          status: "failed",
          checkedAt: nowIso(),
          issues: requestValidation.issues,
        },
      });
      return response;
    }

    const providerResponse = await requestProviderWithRetry(
      this.options.provider,
      request,
      options,
      this.options.retryPolicy,
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
  retryPolicy: ModelRequestRetryPolicy | undefined,
): Promise<ModelResponse> {
  const policy = normalizeRetryPolicy(retryPolicy);
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
    if (!shouldRetryFailedResponse(response, attempt, options, policy)) {
      return response;
    }
    await sleepBeforeRetry(policy, attempt, options.abortSignal);
    if (options.abortSignal?.aborted === true) {
      return response;
    }
    attempt += 1;
  }
}

function shouldRetryFailedResponse(
  response: ModelResponse,
  attempt: number,
  options: ModelRequestOptions,
  policy: Required<ModelRequestRetryPolicy>
): boolean {
  return options.abortSignal?.aborted !== true &&
    response.status === "failed" &&
    response.failure?.retryable === true &&
    attempt < policy.maxRetries;
}

async function sleepBeforeRetry(
  policy: Required<ModelRequestRetryPolicy>,
  retryIndex: number,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  const delayMs = retryDelayMs(policy, retryIndex);
  if (delayMs <= 0 || abortSignal?.aborted === true) {
    return;
  }
  await policy.sleep(delayMs, abortSignal);
}

function retryDelayMs(policy: Required<ModelRequestRetryPolicy>, retryIndex: number): number {
  const base = Math.max(0, policy.baseDelayMs);
  if (base === 0) {
    return 0;
  }
  const exponential = Math.min(policy.maxDelayMs, base * 2 ** Math.max(0, retryIndex));
  const jitterRatio = Math.max(0, Math.min(1, policy.jitterRatio));
  if (jitterRatio === 0) {
    return Math.round(exponential);
  }
  const jitter = 1 + ((policy.random() * 2) - 1) * jitterRatio;
  return Math.max(0, Math.round(exponential * jitter));
}

function normalizeRetryPolicy(policy: ModelRequestRetryPolicy | undefined): Required<ModelRequestRetryPolicy> {
  return {
    maxRetries: normalizeNonNegativeInteger(policy?.maxRetries, 3),
    baseDelayMs: normalizeNonNegativeInteger(policy?.baseDelayMs, 300),
    maxDelayMs: normalizeNonNegativeInteger(policy?.maxDelayMs, 5_000),
    jitterRatio: normalizeJitterRatio(policy?.jitterRatio, 0.2),
    sleep: policy?.sleep ?? defaultRetrySleep,
    random: policy?.random ?? Math.random,
  };
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(0, Math.floor(value));
}

function normalizeJitterRatio(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(0, Math.min(1, value));
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
