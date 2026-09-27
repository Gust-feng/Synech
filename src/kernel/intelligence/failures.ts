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
  const facts = modelErrorFacts(input.error);
  const failureKind = modelFailureKindFromFacts(facts);
  return createFailedModelResponse({
    requestId: input.requestId,
    providerId: input.providerId,
    providerKind: input.providerKind,
    protocolKind: input.protocolKind,
    model: input.model,
    outputKind: input.outputKind,
    failureKind,
    retryable: isRetryableModelFailure(failureKind),
    message: modelFailureDetailWithCode(modelErrorMessageFromError(input.error, input.fallbackMessage), facts.code),
    responseId: input.responseId,
  });
}

/**
 * A status/code classification folds the raw provider code into the kind. The
 * diagnostic detail must still carry that code: reading only the kind reports
 * every 429 as "rate limited", while the real cause (project-level or per-day
 * limits) lives in the original code. A code already present in the message is
 * not appended twice.
 */
export function modelFailureDetailWithCode(
  message: string,
  code: string | number | undefined,
): string {
  const normalized = typeof code === "string" ? code.trim() : code;
  if (normalized === undefined || normalized === "" || message.includes(String(normalized))) {
    return message;
  }
  return `${message} (code: ${normalized})`;
}

export function modelFailureKindFromError(error: unknown): ModelFailureKind {
  return modelFailureKindFromFacts(modelErrorFacts(error));
}

function modelErrorFacts(error: unknown): {
  readonly explicitKind?: ModelFailureKind;
  readonly status?: number;
  readonly code?: string | number;
  readonly name?: string | number;
} {
  const chain = modelErrorChain(error);
  return {
    explicitKind: firstFailureKind(chain),
    status: firstFiniteIntegerField(chain, ["status", "statusCode"]),
    code: firstStringOrNumberField(chain, ["code", "errorCode"]),
    name: firstStringOrNumberField(chain, ["name"]),
  };
}

export function modelFailureKindFromFacts(input: {
  readonly explicitKind?: ModelFailureKind;
  readonly status?: number;
  readonly code?: string | number;
  readonly name?: string | number;
}): ModelFailureKind {
  if (input.explicitKind !== undefined) return input.explicitKind;
  const rawCode = normalizedCode(input.code ?? input.name);
  // Account exhaustion is reported by providers as a 429 with an account-level
  // code. It must win over the status, so a drained account stops the retry
  // budget instead of spending it on backoff before surfacing the real cause.
  if (rawCode !== undefined && ACCOUNT_EXHAUSTION_CODES.has(rawCode)) return "provider_quota";
  // Context-window codes are deterministic: the same request cannot fit after
  // any number of retries, so they must not be collected by the
  // `provider_response` catch-all (which would look retryable-by-default).
  if (rawCode !== undefined && CONTEXT_OVERFLOW_CODES.has(rawCode)) return "context_overflow";
  if (input.status === 401 || input.status === 403) return "provider_auth";
  if (input.status === 408 || input.status === 504) return "provider_timeout";
  if (input.status === 429) return "provider_rate_limit";

  const code = rawCode ?? "";
  if (CONTENT_FILTER_CODES.has(code)) return "content_filtered";
  if (TIMEOUT_CODES.has(code)) return "provider_timeout";
  if (NETWORK_CODES.has(code)) return "provider_network";
  if (AUTH_CODES.has(code)) return "provider_auth";
  if (RATE_LIMIT_CODES.has(code)) return "provider_rate_limit";
  if (CONFIG_CODES.has(code)) return "provider_config";
  if (CONTEXT_OVERFLOW_CODES.has(code)) return "context_overflow";
  return "provider_response";
}

/**
 * Only genuinely transient failures are retried. `provider_response` is the
 * catch-all for every unrecognized failure — 400-class errors, moderation
 * blocks, context overflow, and this channel's own "model returned an
 * unexpected tool call". Replaying those verbatim can only produce the same
 * result, so they must not consume the retry budget (and the user's wait).
 */
export function isRetryableModelFailure(kind: ModelFailureKind): boolean {
  return kind === "provider_network" || kind === "provider_timeout" || kind === "provider_rate_limit";
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
    value === "provider_rate_limit" || value === "provider_quota" || value === "provider_timeout" ||
    value === "provider_network" || value === "provider_response" || value === "content_filtered" ||
    value === "context_overflow" || value === "output_truncated" || value === "output_validation";
}

function normalizedCode(value: string | number | undefined): string | undefined {
  if (typeof value === "number") return undefined;
  const normalized = value?.trim().toLowerCase();
  return normalized === undefined || normalized === "" ? undefined : normalized;
}

const CONTENT_FILTER_CODES = new Set([
  "content_filter", "content_filtered", "safety", "safety_filter",
  "moderation", "moderation_block", "moderation_blocked", "content_policy_violation",
]);
const CONTEXT_OVERFLOW_CODES = new Set([
  "context_length_exceeded", "context_window_exceeded", "context_overflow",
  "prompt_too_long", "prompt_is_too_long",
]);
const TIMEOUT_CODES = new Set(["abort_err", "etimedout", "timeout", "request_timeout", "gateway_timeout"]);
const NETWORK_CODES = new Set([
  "econnreset", "econnrefused", "enotfound", "eai_again", "epipe", "network_error", "fetch_failed",
]);
const AUTH_CODES = new Set([
  "invalid_api_key", "authentication_error", "authorization_error", "permission_denied", "unauthorized", "forbidden",
]);
const RATE_LIMIT_CODES = new Set(["rate_limit", "rate_limit_exceeded", "too_many_requests"]);
const ACCOUNT_EXHAUSTION_CODES = new Set([
  "insufficient_quota",
  "insufficient_balance",
  "insufficient_credits",
  "credit_balance_too_low",
  "billing_hard_limit_reached",
  "budget_exceeded",
  "out_of_budget",
  "quota_exceeded",
  "account_exceeded_quota",
]);
const CONFIG_CODES = new Set([
  "missing_api_key", "missing_model", "missing_provider", "invalid_base_url", "provider_config",
]);

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
