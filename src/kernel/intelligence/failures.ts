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
  const chain = modelErrorChain(error);
  return modelFailureKindFromFacts({
    explicitKind: firstFailureKind(chain),
    status: firstFiniteIntegerField(chain, ["status", "statusCode"]),
    code: firstStringOrNumberField(chain, ["code", "errorCode"]),
    name: firstStringOrNumberField(chain, ["name"]),
  });
}

export function modelFailureKindFromFacts(input: {
  readonly explicitKind?: ModelFailureKind;
  readonly status?: number;
  readonly code?: string | number;
  readonly name?: string | number;
}): ModelFailureKind {
  if (input.explicitKind !== undefined) return input.explicitKind;
  if (input.status === 401 || input.status === 403) return "provider_auth";
  if (input.status === 408 || input.status === 504) return "provider_timeout";
  if (input.status === 429) return "provider_rate_limit";

  const code = String(input.code ?? input.name ?? "").trim().toLowerCase();
  if (CONTENT_FILTER_CODES.has(code)) return "content_filtered";
  if (TIMEOUT_CODES.has(code)) return "provider_timeout";
  if (NETWORK_CODES.has(code)) return "provider_network";
  if (AUTH_CODES.has(code)) return "provider_auth";
  if (RATE_LIMIT_CODES.has(code)) return "provider_rate_limit";
  if (CONFIG_CODES.has(code)) return "provider_config";
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
  field: string,
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

function firstFailureKind(values: readonly unknown[]): ModelFailureKind | undefined {
  for (const value of values) {
    for (const field of ["failureKind", "kind"] as const) {
      const candidate = readErrorField(value, field);
      if (isModelFailureKind(candidate)) return candidate;
    }
  }
  return undefined;
}

function firstFiniteIntegerField(values: readonly unknown[], fields: readonly string[]): number | undefined {
  for (const value of values) {
    for (const field of fields) {
      const candidate = readErrorField(value, field);
      if (typeof candidate === "number" && Number.isFinite(candidate)) return Math.trunc(candidate);
    }
  }
  return undefined;
}

function firstStringOrNumberField(values: readonly unknown[], fields: readonly string[]): string | number | undefined {
  for (const value of values) {
    for (const field of fields) {
      const candidate = readErrorField(value, field);
      if (typeof candidate === "string" || typeof candidate === "number") return candidate;
    }
  }
  return undefined;
}

function isModelFailureKind(value: unknown): value is ModelFailureKind {
  return value === "request_validation" || value === "provider_config" || value === "provider_auth" ||
    value === "provider_rate_limit" || value === "provider_timeout" || value === "provider_network" ||
    value === "provider_response" || value === "content_filtered" || value === "output_truncated" ||
    value === "output_validation";
}

const CONTENT_FILTER_CODES = new Set(["content_filter", "content_filtered", "safety", "safety_filter"]);
const TIMEOUT_CODES = new Set(["abort_err", "etimedout", "timeout", "request_timeout", "gateway_timeout"]);
const NETWORK_CODES = new Set([
  "econnreset", "econnrefused", "enotfound", "eai_again", "epipe", "network_error", "fetch_failed",
]);
const AUTH_CODES = new Set([
  "invalid_api_key", "authentication_error", "authorization_error", "permission_denied", "unauthorized", "forbidden",
]);
const RATE_LIMIT_CODES = new Set(["rate_limit", "rate_limit_exceeded", "too_many_requests"]);
const CONFIG_CODES = new Set([
  "missing_api_key", "missing_model", "missing_provider", "invalid_base_url", "provider_config",
]);

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
