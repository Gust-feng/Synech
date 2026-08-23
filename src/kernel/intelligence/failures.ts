import type {
  ModelFailure,
  ModelFailureKind,
  ModelOutputKind,
  ModelOutputValidationResult,
  ModelProtocolKind,
  ModelProviderKind,
  ModelResponse,
} from "../../domain/intelligence/index.js";
import { createId, nowIso } from "../id.js";
import { preserveVisibleText } from "../visible-text-policy.js";
import { failedModelOutputValidation } from "./validation.js";

const MAX_MODEL_ERROR_CHAIN_DEPTH = 8;
const MODEL_ERROR_NESTED_FIELDS = ["cause", "error"] as const;

export function createFailedModelResponse(input: {
  requestId: string;
  providerId: string;
  providerKind: ModelProviderKind;
  protocolKind: ModelProtocolKind;
  model: string;
  outputKind: ModelOutputKind;
  failureKind: ModelFailureKind;
  message: string;
  retryable?: boolean;
  validation?: ModelOutputValidationResult;
  responseId?: string;
}): ModelResponse {
  const failure: ModelFailure = {
    kind: input.failureKind,
    retryable: input.retryable ?? false,
    message: input.message,
    sanitizedErrorRef: `model-error:${input.failureKind}`,
  };

  return {
    responseId: input.responseId ?? createId("model-response"),
    requestId: input.requestId,
    providerId: input.providerId,
    providerKind: input.providerKind,
    protocolKind: input.protocolKind,
    model: input.model,
    status: "failed",
    outputKind: input.outputKind,
    finishReason: "error",
    validation:
      input.validation ??
      failedModelOutputValidation(
        `MODEL_${input.failureKind.toUpperCase()}`,
        input.message,
        "failure"
      ),
    failure,
    completedAt: nowIso(),
  };
}

export function createFailedModelResponseFromError(input: {
  requestId: string;
  providerId: string;
  providerKind: ModelProviderKind;
  protocolKind: ModelProtocolKind;
  model: string;
  outputKind: ModelOutputKind;
  error: unknown;
  fallbackMessage?: string;
  responseId?: string;
}): ModelResponse {
  const failureKind = modelFailureKindFromError(input.error);
  return createFailedModelResponse({
    requestId: input.requestId,
    providerId: input.providerId,
    providerKind: input.providerKind,
    protocolKind: input.protocolKind,
    model: input.model,
    outputKind: input.outputKind,
    failureKind,
    retryable: isRetryableModelFailure(failureKind),
    message: modelErrorMessageFromError(input.error, input.fallbackMessage),
    responseId: input.responseId,
  });
}

export function modelFailureKindFromError(error: unknown): ModelFailureKind {
  const message = rawModelErrorMessage(error).toLowerCase();
  if (/\bcontent[ _-]?filter(?:ed)?\b/.test(message)) {
    return "content_filtered";
  }
  if (/\b(timeout|timed out|etimedout)\b/.test(message)) {
    return "provider_timeout";
  }
  if (/\b(network|connection error|fetch failed|terminated|econnreset|econnrefused|enotfound|eai_again|socket|dns)\b/.test(message) ||
    message.includes("other side closed")) {
    return "provider_network";
  }
  if (/\b(unauthorized|forbidden|auth|401|403)\b/.test(message)) {
    return "provider_auth";
  }
  if (/\b(rate limit|rate_limit|too many requests|429)\b/.test(message)) {
    return "provider_rate_limit";
  }
  if (/\b(config|configuration|missing model|missing provider|base url|api[_ -]?key)\b/.test(message)) {
    return "provider_config";
  }
  return "provider_response";
}

export function isRetryableModelFailure(kind: ModelFailureKind): boolean {
  return kind === "provider_network" || kind === "provider_timeout" || kind === "provider_rate_limit" || kind === "provider_response";
}

export function modelErrorMessageFromError(error: unknown, fallbackMessage = "Model request failed."): string {
  const visible = preserveVisibleText(rawModelErrorMessage(error, fallbackMessage)).replace(/\s+/g, " ").trim();
  if (visible.length === 0) {
    return fallbackMessage;
  }
  return visible.length <= 1_000 ? visible : `${visible.slice(0, 999)}…`;
}

function rawModelErrorMessage(error: unknown, fallbackMessage = "Model request failed."): string {
  const messages = modelErrorChain(error)
    .map(errorChainMessage)
    .filter((message): message is string => message !== undefined && message.length > 0);
  return messages.length === 0 ? fallbackMessage : messages.join(" Cause: ");
}

function modelErrorChain(error: unknown): readonly unknown[] {
  const chain: unknown[] = [];
  const visited = new WeakSet<object>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_MODEL_ERROR_CHAIN_DEPTH) {
      return;
    }
    if (isObjectLike(value)) {
      if (visited.has(value)) {
        return;
      }
      visited.add(value);
    }
    chain.push(value);
    for (const field of MODEL_ERROR_NESTED_FIELDS) {
      const nested = readErrorField(value, field);
      if (nested !== undefined) {
        visit(nested, depth + 1);
      }
    }
  };

  visit(error, 0);
  return chain;
}

function errorChainMessage(value: unknown): string | undefined {
  if (value instanceof Error || typeof value === "string") {
    return typeof value === "string" ? value : value.message;
  }
  return undefined;
}

function readErrorField(
  value: unknown,
  field: typeof MODEL_ERROR_NESTED_FIELDS[number],
): unknown {
  if (!isObjectLike(value)) {
    return undefined;
  }
  try {
    return Reflect.get(value, field);
  } catch {
    return undefined;
  }
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
