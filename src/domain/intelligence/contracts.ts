import type { ObservationRef } from "../ordinary/observation.js";
import type { ToolCallRequest, ToolDefinition } from "../tools/contracts.js";
export type { ModelOutputKind } from "./model-output-contracts.js";
import type { ModelOutputKind } from "./model-output-contracts.js";
export type { ModelInputAttachment, ModelInputAttachmentRef, ModelInputAttachmentSource } from "./model-input-attachments.js";
import type { ModelInputAttachment } from "./model-input-attachments.js";
export type { ModelCallRef } from "./model-call-ref.js";

export const MODEL_PROTOCOL_KINDS = [
  "openai_compatible_chat_completions",
  "openai_responses",
] as const;

export type ModelProtocolKind = (typeof MODEL_PROTOCOL_KINDS)[number];

export type ModelProviderKind = "openai_compatible";

export type ModelArtifactRef = {
  readonly id: string;
  readonly producedBy: string;
  readonly type: "document" | "code" | "config" | "report" | "log" | "package";
  readonly path?: string;
  readonly uri?: string;
  readonly version: string;
  readonly createdAt: string;
};

/**
 * Purposes emitted by the current Ordinary feature and neutral model helpers.
 * New callers should choose from this union so deferred/experimental purposes
 * do not leak into the product path by accident.
 */
export type OrdinaryModelPurpose =
  | "skill_routing"
  | "skill_quality_eval"
  | "context_compaction"
  | "conversation_title"
  | "ordinary_agent";

/** Model request purposes supported by the current Ordinary product path. */
export type ModelPurpose = OrdinaryModelPurpose;

export type ModelMessage = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  /**
   * Ephemeral model-input attachments for a single provider request. Run context,
   * panel read-models, event logs, and persisted conversations should keep file
   * refs and metadata instead of storing raw attachment payloads.
   */
  readonly attachments?: readonly ModelInputAttachment[];
  readonly ref?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolCalls?: readonly ToolCallRequest[];
  /**
   * Opaque protocol continuation fields returned by an adapter and replayed
   * only while that protocol remains active. A protocol switch starts a new
   * context segment from portable message and tool facts instead of translating
   * these fields. They are never projected to EventLog, panel read models, Plan
   * material, or user-visible output. Durable feature state may retain only the
   * explicit whitelist produced by the model protocol persistence contract.
   */
  readonly protocolExtensions?: Readonly<Record<string, unknown>>;
};

export type ModelBudget = {
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxTotalTokens?: number;
  readonly maxLatencyMs?: number;
  readonly maxCostUsd?: number;
};

export type ModelOutputContract = {
  readonly contractId: string;
  readonly outputKind: ModelOutputKind;
  readonly format: "json_object" | "text";
  readonly requiredFields?: readonly string[];
  readonly requiredStringFields?: readonly string[];
  readonly minTextLength?: number;
  readonly maxTextLength?: number;
  readonly visibleOutput?: {
    readonly arrayField?: string;
    readonly fields: readonly string[];
    readonly fieldTypes?: Readonly<Record<string, ModelVisibleOutputFieldType>>;
    readonly maxItems?: number;
    readonly maxFieldLength?: number;
  };
};

export type ModelOutputValidationIssue = {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
};

export type ModelOutputValidationResult = {
  readonly status: "pending" | "passed" | "failed";
  readonly checkedAt: string;
  readonly issues: readonly ModelOutputValidationIssue[];
};

export type ModelVisibleOutputFieldType = "string" | "string_array";

export type ModelVisibleOutputField = {
  readonly name: string;
  readonly value: string;
  readonly truncated: boolean;
};

export type ModelVisibleOutputItem = {
  readonly itemId: string;
  readonly fields: readonly ModelVisibleOutputField[];
};

export type ModelVisibleOutputProjection = {
  readonly source: "structured_output" | "text_output";
  readonly contractId: string;
  readonly outputKind: ModelOutputKind;
  readonly validationStatus: ModelOutputValidationResult["status"];
  readonly items: readonly ModelVisibleOutputItem[];
  readonly truncated: boolean;
};

export type ModelRequest = {
  readonly requestId: string;
  readonly traceId: string;
  readonly callerRef: ObservationRef | string;
  readonly purpose: ModelPurpose;
  readonly inputRefs: readonly ObservationRef[];
  readonly sanitizedMessages: readonly ModelMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly toolChoice?: ModelToolChoice;
  readonly outputContract: ModelOutputContract;
  readonly budget: ModelBudget;
  readonly sensitivity: "public" | "internal" | "restricted";
  readonly requestedAt: string;
};

export type ModelRequestOptions = {
  readonly abortSignal?: AbortSignal;
};

export type ModelToolChoice =
  | "auto"
  | "none"
  | { readonly type: "function"; readonly function: { readonly name: string } };

export type ModelToolCall = ToolCallRequest;

/** Provider-reported token usage for one model request. */
export type ModelRequestUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly uncachedInputTokens?: number;
  readonly reasoningOutputTokens?: number;
};

export type ModelUsage = {
  /** Number of provider API requests represented by this usage snapshot. */
  readonly requestCount?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  /**
   * Provider-reported input tokens served from cache, such as DeepSeek
   * prompt_cache_hit_tokens. This is a subset of inputTokens when provided.
   */
  readonly cachedInputTokens?: number;
  /** Provider-reported prompt tokens written to cache for this request. */
  readonly cacheWriteInputTokens?: number;
  /**
   * Provider-reported input tokens not served from cache, such as DeepSeek
   * prompt_cache_miss_tokens.
   */
  readonly uncachedInputTokens?: number;
  /**
   * Provider-reported reasoning output tokens when available.
   */
  readonly reasoningOutputTokens?: number;
  readonly estimatedCostUsd?: number;
  /**
   * Total provider request duration measured by the adapter.
   */
  readonly latencyMs?: number;
  /**
   * Time from request dispatch to the first user-visible output token. This is
   * only populated for real streaming responses where the adapter can observe
   * the first visible output delta. A cumulative multi-request snapshot reports
   * the average across its observed request samples.
   */
  readonly firstTokenLatencyMs?: number;
  /**
   * Time between the first user-visible output token and request completion.
   */
  readonly outputDurationMs?: number;
  /**
   * Output token throughput derived only when outputTokens and outputDurationMs
   * are both known.
   */
  readonly outputTokensPerSecond?: number;
  /**
   * The most recent non-compaction request reported by the Agent model loop.
   * This remains separate from cumulative run totals so context capacity is
   * never inferred from usage accumulated across multiple requests.
   */
  readonly latestAgentRequest?: ModelRequestUsage;
};

export type ModelOutputDelta = {
  readonly kind?: "output" | "reasoning";
  readonly requestId: string;
  readonly purpose?: ModelPurpose;
  readonly providerId: string;
  readonly model: string;
  readonly delta: string;
  readonly index: number;
  readonly createdAt: string;
};

export type ModelReasoningOutputProjection = {
  readonly source:
    | "openai_responses_reasoning_summary"
    | "openai_chat_reasoning_content"
    | "provider_reasoning_content";
  readonly content: string;
  readonly truncated: boolean;
};

export type ModelFailureKind =
  | "request_validation"
  | "provider_config"
  | "provider_auth"
  | "provider_rate_limit"
  | "provider_timeout"
  | "provider_network"
  | "provider_response"
  | "content_filtered"
  | "output_truncated"
  | "output_validation";

export type ModelFailure = {
  readonly kind: ModelFailureKind;
  readonly retryable: boolean;
  readonly message: string;
  readonly sanitizedErrorRef?: string;
};

export type ModelResponse = {
  readonly responseId: string;
  readonly requestId: string;
  readonly providerId: string;
  readonly providerKind: ModelProviderKind;
  readonly protocolKind: ModelProtocolKind;
  readonly model: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly outputKind: ModelOutputKind;
  readonly structuredOutput?: unknown;
  readonly textOutput?: string;
  readonly textOutputRef?: ModelArtifactRef;
  readonly reasoningOutput?: ModelReasoningOutputProjection;
  readonly assistantMessage?: ModelMessage;
  readonly toolCalls?: readonly ToolCallRequest[];
  readonly usage?: ModelUsage;
  readonly finishReason?: "stop" | "length" | "tool_call" | "content_filter" | "error";
  readonly validation: ModelOutputValidationResult;
  readonly failure?: ModelFailure;
  readonly completedAt: string;
};

export type ModelProvider = {
  readonly providerId: string;
  readonly providerKind: ModelProviderKind;
  readonly protocolKind: ModelProtocolKind;
  readonly model: string;
  complete(request: ModelRequest, options?: ModelRequestOptions): Promise<ModelResponse>;
};

export type IntelligenceChannel = {
  request(request: ModelRequest, options?: ModelRequestOptions): Promise<ModelResponse>;
  validateResponse(request: ModelRequest, response: ModelResponse): ModelOutputValidationResult;
};
