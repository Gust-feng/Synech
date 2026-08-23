import type { ModelMessage } from "./contracts.js";

export const OPENAI_RESPONSES_OUTPUT_ITEMS_EXTENSION = "openai_responses_output_items";
export const OPENAI_CHAT_CONTINUATION_EXTENSIONS = [
  "reasoning",
  "reasoning_content",
  "reasoning_details",
] as const;

type PersistedModelProtocolExtension =
  | typeof OPENAI_RESPONSES_OUTPUT_ITEMS_EXTENSION
  | typeof OPENAI_CHAT_CONTINUATION_EXTENSIONS[number];

export type PersistedModelProtocolExtensionFailureReason =
  | "not_array"
  | "empty_items"
  | "not_json_safe"
  | "invalid_item";

/**
 * Raised when a known provider continuation is present but cannot be retained
 * without breaking the provider's replay contract. Unknown provider fields are
 * intentionally ignored; only the explicit Responses and Chat allowlists fail.
 */
export class ModelProtocolContinuationPersistenceError extends Error {
  readonly code = "model_protocol_continuation_not_persistable" as const;
  readonly errorDomain = "runtime_error" as const;
  readonly facts: Readonly<{
    code: "model_protocol_continuation_not_persistable";
    extension: PersistedModelProtocolExtension;
    reason: PersistedModelProtocolExtensionFailureReason;
  }>;

  constructor(
    reason: PersistedModelProtocolExtensionFailureReason,
    extension: PersistedModelProtocolExtension = OPENAI_RESPONSES_OUTPUT_ITEMS_EXTENSION,
  ) {
    super(`[model_protocol_continuation_not_persistable] Model protocol continuation ${extension} cannot be persisted (${reason}).`);
    this.name = "ModelProtocolContinuationPersistenceError";
    this.facts = {
      code: this.code,
      extension,
      reason,
    };
  }
}

/**
 * Produces the exact JSON-safe protocol continuation facts that a feature may
 * persist without interpreting provider-private data. Request-only extensions
 * and domain-level model attachment references are not copied into this
 * protocol-extension envelope; Pi Session owns persistence of consumed image
 * content at the provider message boundary.
 */
export function persistedModelProtocolExtensions(
  extensions: ModelMessage["protocolExtensions"],
): Readonly<Record<string, unknown>> | undefined {
  if (extensions === undefined) return undefined;
  const persisted: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(extensions, OPENAI_RESPONSES_OUTPUT_ITEMS_EXTENSION)) {
    persisted[OPENAI_RESPONSES_OUTPUT_ITEMS_EXTENSION] = persistedResponsesItems(
      extensions[OPENAI_RESPONSES_OUTPUT_ITEMS_EXTENSION],
    );
  }
  for (const key of OPENAI_CHAT_CONTINUATION_EXTENSIONS) {
    if (!Object.prototype.hasOwnProperty.call(extensions, key)) continue;
    const value = extensions[key];
    if (!isSupportedChatContinuation(key, value) || !isProtocolJsonValue(value, new Set<object>(), 0)) {
      throw new ModelProtocolContinuationPersistenceError("invalid_item", key);
    }
    persisted[key] = JSON.parse(JSON.stringify(value)) as unknown;
  }
  return Object.keys(persisted).length === 0 ? undefined : persisted;
}

function persistedResponsesItems(rawItems: unknown): readonly unknown[] {
  if (!Array.isArray(rawItems)) {
    throw new ModelProtocolContinuationPersistenceError("not_array");
  }
  if (rawItems.length === 0) {
    throw new ModelProtocolContinuationPersistenceError("empty_items");
  }
  if (!isProtocolJsonValue(rawItems, new Set<object>(), 0)) {
    throw new ModelProtocolContinuationPersistenceError("not_json_safe");
  }
  const serialized = JSON.stringify(rawItems);
  const detached = JSON.parse(serialized) as unknown;
  if (!Array.isArray(detached) || !detached.every(isProtocolOutputItem)) {
    throw new ModelProtocolContinuationPersistenceError("invalid_item");
  }
  return detached;
}

function isSupportedChatContinuation(
  key: typeof OPENAI_CHAT_CONTINUATION_EXTENSIONS[number],
  value: unknown,
): boolean {
  if (key === "reasoning" || key === "reasoning_content") {
    return typeof value === "string" && value.length > 0;
  }
  return (Array.isArray(value) && value.length > 0) ||
    (typeof value === "object" && value !== null && !Array.isArray(value));
}

function isProtocolJsonValue(value: unknown, ancestors: Set<object>, depth: number): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || depth >= 100 || ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index) || !isProtocolJsonValue(value[index], ancestors, depth + 1)) {
          return false;
        }
      }
      return true;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    if (Object.getOwnPropertySymbols(value).some((symbol) => Object.prototype.propertyIsEnumerable.call(value, symbol))) {
      return false;
    }
    return Object.values(value).every((item) => isProtocolJsonValue(item, ancestors, depth + 1));
  } finally {
    ancestors.delete(value);
  }
}

function isProtocolOutputItem(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const type = (value as { readonly type?: unknown }).type;
  return typeof type === "string" && type.length > 0;
}