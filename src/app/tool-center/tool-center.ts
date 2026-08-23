import { asRecord } from "../../kernel/values/index.js";
import type {
  ToolCallRequest,
  ToolCallResult,
  ToolDefinition,
  ToolDefinitionMetadata,
  ToolErrorDomain,
  ToolErrorFacts,
  ToolExecutionContext,
  ToolExecutionGateway,
  ToolExecutionPreflight,
  ToolExecutor,
  ToolExecutorResult,
  ToolPermissionCheck,
  ToolSecurityDecision,
  ToolExecutionMetricsSink,
} from "../../domain/tools/index.js";
import { createHash } from "node:crypto";
import {
  assertCanonicalToolName,
  cloneToolInputSchema,
  cloneToolJsonSchema,
  copyToolModelAttachments,
  isToolErrorDomain,
  InvalidToolFactError,
  normalizeToolErrorFacts,
  normalizeToolErrorFactValue,
  normalizeToolFactValue,
  toolCallFactId,
  toolDisplayName,
} from "../../domain/tools/index.js";
import type { ConfirmationRequest } from "../../domain/confirmation/contracts.js";
import {
  confirmationRequestFromSecurityDecision,
  evaluateToolCallSecurity,
} from "../../kernel/tools/index.js";
import { toolResultMessage } from "../../kernel/intelligence/tool-use-loop-messages.js";
import {
  ToolOutputStoreError,
  type ToolOutputMediaType,
  type ToolOutputStore,
} from "./tool-output-store.js";
import {
  DEFAULT_MAX_INLINE_TOOL_OUTPUT_CHARS,
  DEFAULT_MAX_INLINE_TOOL_RESULT_TOKENS,
  DEFAULT_TARGET_INLINE_TOOL_BODY_TOKENS,
  MAX_TOOL_OUTPUT_READ_CHARS,
  type ToolOutputTokenCounter,
} from "./tool-output-limits.js";
import { utf16SafePrefixLength } from "./text-window.js";

export type ToolCenterOptions = {
  readonly platform?: NodeJS.Platform;
  readonly outputStore?: ToolOutputStore;
  readonly maxInlineOutputChars?: number;
  readonly outputTokenCounter?: ToolOutputTokenCounter;
  readonly maxInlineOutputTokens?: number;
  readonly targetInlineBodyTokens?: number;
  readonly metricsSink?: ToolExecutionMetricsSink;
};

const RETAINED_TOOL_OUTPUT_PREVIEW_CHARS = 4_000;
const RETAINED_TOOL_OUTPUT_READ_CHARS = MAX_TOOL_OUTPUT_READ_CHARS;
const MAX_INLINE_APPROVAL_PARTIAL_OUTPUT_CHARS = 24_000;
const TOOL_OUTPUT_READER_NAME = "ReadOutput";

type ToolExecutionPreflightInternal =
  | (Extract<ToolExecutionPreflight, { readonly status: "ready" }> & {
      readonly executor: ToolExecutor;
    })
  | Exclude<ToolExecutionPreflight, { readonly status: "ready" }>;

export class ToolCenter implements ToolExecutionGateway {
  private readonly tools = new Map<string, ToolExecutor>();
  private readonly platform: NodeJS.Platform;
  private readonly outputStore: ToolOutputStore | undefined;
  private readonly maxInlineOutputChars: number;
  private readonly outputTokenCounter: ToolOutputTokenCounter | undefined;
  private readonly maxInlineOutputTokens: number;
  private readonly targetInlineBodyTokens: number;
  private readonly metricsSink: ToolExecutionMetricsSink | undefined;

  constructor(options: ToolCenterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.outputStore = options.outputStore;
    this.maxInlineOutputChars = positiveInlineOutputLimit(options.maxInlineOutputChars);
    this.outputTokenCounter = options.outputTokenCounter;
    this.maxInlineOutputTokens = positiveTokenLimit(
      options.maxInlineOutputTokens,
      DEFAULT_MAX_INLINE_TOOL_RESULT_TOKENS,
      "maxInlineOutputTokens",
    );
    this.targetInlineBodyTokens = positiveTokenLimit(
      options.targetInlineBodyTokens,
      DEFAULT_TARGET_INLINE_TOOL_BODY_TOKENS,
      "targetInlineBodyTokens",
    );
    this.metricsSink = options.metricsSink;
  }

  register(executor: ToolExecutor): void {
    assertCanonicalToolName(executor.definition.name);
    if (this.tools.has(executor.definition.name)) {
      throw new Error(`Tool ${executor.definition.name} is already registered.`);
    }
    const metadata = normalizeToolMetadata(executor.definition);
    this.tools.set(executor.definition.name, {
      ...executor,
      definition: {
        ...executor.definition,
        inputSchema: cloneToolInputSchema(executor.definition.inputSchema),
        outputSchema:
          executor.definition.outputSchema === undefined
            ? undefined
            : cloneToolJsonSchema(executor.definition.outputSchema),
        metadata,
      },
    });
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((executor) => cloneToolDefinition(executor.definition));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  preflight(
    request: ToolCallRequest,
    context: ToolExecutionContext,
    permission: ToolPermissionCheck,
  ): ToolExecutionPreflight {
    const outcome = this.preflightInternal(request, context, permission, Date.now());
    if (outcome.status === "ready") {
      return { status: "ready", request: outcome.request };
    }
    return outcome;
  }

  async execute(
    request: ToolCallRequest,
    context: ToolExecutionContext,
    permission: ToolPermissionCheck
  ): Promise<ToolCallResult> {
    const startedAt = Date.now();
    const preflight = this.preflightInternal(request, context, permission, startedAt);
    if (preflight.status !== "ready") {
      this.recordExecutionMetric(preflight.result, preflight.result);
      return preflight.result;
    }
    const factRequest = preflight.request;
    const executor = preflight.executor;

    let output: unknown;
    try {
      output = await executor.execute(factRequest.input, {
        ...context,
        toolCallId: toolCallFactId(factRequest),
        approvedConfirmationIds: permission.approvedConfirmationIds,
        confirmationPolicy: permission.confirmationPolicy,
      });
    } catch (error) {
      if (isAbortSignalAborted(context.abortSignal) && isAbortError(error)) {
        const cancelled = cancelledToolResult(factRequest, startedAt, {
          abortRequested: true,
          sourceExecutionStatus: "unknown",
          doNotBlindlyRetry: true,
        });
        this.recordExecutionMetric(cancelled, cancelled);
        return cancelled;
      }
      const sanitized = sanitizeError(error, factRequest.toolName);
      const abortRequestedFacts: ToolErrorFacts = {
        abortRequested: true,
        sourceExecutionStatus: "unknown",
        doNotBlindlyRetry: true,
      };
      const failure = !isAbortSignalAborted(context.abortSignal)
        ? sanitized
        : {
            ...sanitized,
            facts: mergeToolErrorFacts(sanitized.facts, abortRequestedFacts),
            fullFacts: mergeToolErrorFacts(sanitized.fullFacts, abortRequestedFacts),
          };
      const rawFailure = {
        ...failedToolResult(factRequest, startedAt, failure),
        failureAttribution: "execution_failure" as const,
      };
      const deliveryStartedAt = Date.now();
      const delivered = await this.prepareThrownErrorForDelivery(
        rawFailure,
        permission,
        failure,
        context.traceId,
      );
      this.recordExecutionMetric(rawFailure, delivered, Date.now() - deliveryStartedAt);
      return delivered;
    }

    // Once the executor resolves, its returned value is the execution fact. A late abort
    // belongs to the owning loop; replacing this fact with `cancelled` could replay a side effect.
    try {
      if (isToolExecutorResult(output)) {
        const rawResult = normalizeExecutorResult(output.result, factRequest, startedAt);
        const deliveryStartedAt = Date.now();
        const delivered = await this.prepareResultForDelivery(
          rawResult,
          permission,
          context.traceId,
        );
        this.recordExecutionMetric(rawResult, delivered, Date.now() - deliveryStartedAt);
        return delivered;
      }
      const rawResult: ToolCallResult = {
        callId: factRequest.callId,
        ...toolFactIdentity(factRequest),
        toolName: factRequest.toolName,
        input: factRequest.input,
        output: normalizeToolFactValue(output),
        status: "completed",
        durationMs: Date.now() - startedAt,
      };
      const deliveryStartedAt = Date.now();
      const delivered = await this.prepareResultForDelivery(rawResult, permission, context.traceId);
      this.recordExecutionMetric(rawResult, delivered, Date.now() - deliveryStartedAt);
      return delivered;
    } catch (error) {
      const sanitized = sanitizeError(error, factRequest.toolName);
      const sourceExecutionStatus = isToolExecutorResult(output)
        ? toolCallStatus(output.result.status) ?? "unknown"
        : "completed";
      const failed = failedToolResult(factRequest, startedAt, sanitized);
      const rawFailure: ToolCallResult = {
          ...failed,
          errorFacts: mergeToolErrorFacts(sanitized.facts, {
            sourceExecutionStatus,
            doNotBlindlyRetry: true,
            outputDeliveryPhase: "executor_result_normalization",
          }),
      };
      const deliveryStartedAt = Date.now();
      const delivered = await this.prepareResultForDelivery(rawFailure, permission, context.traceId);
      this.recordExecutionMetric(rawFailure, delivered, Date.now() - deliveryStartedAt);
      return delivered;
    }
  }

  async deliverResult(
    result: ToolCallResult,
    permission: ToolPermissionCheck,
    ownerId: string,
  ): Promise<ToolCallResult> {
    const deliveryStartedAt = Date.now();
    const delivered = await this.prepareResultForDelivery(result, permission, ownerId);
    this.recordExecutionMetric(result, delivered, Date.now() - deliveryStartedAt);
    return delivered;
  }

  private recordExecutionMetric(raw: ToolCallResult, delivered: ToolCallResult, deliveryMs?: number): void {
    const sink = this.metricsSink;
    if (sink === undefined) return;
    try {
      const rawBody = raw.output === undefined ? "" : JSON.stringify(raw.output);
      const rawInput = raw.input === undefined ? "" : JSON.stringify(raw.input);
      const rawEnvelopeTokens = this.outputTokenCounter === undefined
        ? undefined
        : toolResultEnvelopeTokens(this.outputTokenCounter, raw);
      const finalEnvelopeTokens = this.outputTokenCounter === undefined
        ? undefined
        : toolResultEnvelopeTokens(this.outputTokenCounter, delivered);
      const deliveredOutput = recordFromUnknown(delivered.output);
      const continuation = recordFromUnknown(deliveredOutput.continuation);
      const inputRecord = recordFromUnknown(raw.input);
      const continuationInput = recordFromUnknown(continuation.nextInput);
      const producerContinuation = nativeProducerContinuation(raw.toolName, inputRecord, deliveredOutput);
      const chainValue = producerContinuation?.chainValue ??
        continuationIdentity(continuationInput) ?? continuationIdentity(inputRecord);
      const continuationObserved = producerContinuation !== undefined || Object.keys(continuation).length > 0 ||
        raw.toolName === TOOL_OUTPUT_READER_NAME || chainValue !== undefined;
      const retained = typeof deliveredOutput.contentRef === "string";
      const retentionFailed = deliveredOutput.retentionFailed === true;
      const deliveredErrorFacts = recordFromUnknown(delivered.errorFacts);
      const retentionFailureCode = stringFromUnknown(
        deliveredErrorFacts.outputDeliveryCode ?? deliveredErrorFacts.errorEvidenceCode,
      );
      const bodyLimit = rawBody.length > this.maxInlineOutputChars;
      const envelopeLimit = rawEnvelopeTokens !== undefined && rawEnvelopeTokens > this.maxInlineOutputTokens;
      sink.record({
        kind: "execution",
        toolName: raw.toolName,
        operationType: this.tools.get(raw.toolName)?.definition.metadata?.operationType ?? "read-write",
        status: delivered.status,
        inputTokens: this.outputTokenCounter === undefined
          ? undefined
          : this.outputTokenCounter.countText(rawInput),
        rawBodyTokens: this.outputTokenCounter === undefined
          ? undefined
          : this.outputTokenCounter.countText(rawBody),
        rawEnvelopeTokens,
        finalEnvelopeTokens,
        outputChars: rawBody.length,
        outputBytes: Buffer.byteLength(rawBody, "utf8"),
        durationMs: raw.durationMs,
        ...(retained
          ? {
              retained: {
                reason: bodyLimit && envelopeLimit
                  ? "body_and_envelope_limit" as const
                  : bodyLimit
                    ? "body_limit" as const
                    : "envelope_limit" as const,
                chars: numberFromUnknown(deliveredOutput.contentChars),
                bytes: numberFromUnknown(deliveredOutput.contentBytes),
                availability: deliveredOutput.continuationAvailability === "durable" ? "durable" as const : "live_only" as const,
              },
            }
          : {}),
        ...(retentionFailed
          ? { retentionFailure: retentionFailureReason(retentionFailureCode) }
          : {}),
        ...(!retained && !retentionFailed ? {} : { retentionMs: deliveryMs }),
        ...(!continuationObserved
          ? {}
          : {
              continuation: {
                kind: raw.toolName === TOOL_OUTPUT_READER_NAME ? "read_output" as const : "native" as const,
                offered: producerContinuation?.offered ?? Object.keys(continuation).length > 0,
                completed: delivered.status === "completed" &&
                  (producerContinuation?.completed ?? Object.keys(continuation).length === 0),
                ...(chainValue === undefined
                  ? {}
                  : { chainHash: createHash("sha256").update(chainValue).digest("hex") }),
                pageChars: producerContinuation?.pageChars ??
                  numberFromUnknown(deliveredOutput.textChars) ?? numberFromUnknown(deliveredOutput.bodyChars),
                ...(delivered.status !== "failed"
                  ? {}
                  : { failure: continuationFailure(deliveredErrorFacts) }),
              },
            }),
      });
    } catch {
      try {
        sink.recordDropped?.();
      } catch {
        // Metrics are observational and must never replace a tool fact.
      }
    }
  }

  private preflightInternal(
    request: ToolCallRequest,
    context: ToolExecutionContext,
    permission: ToolPermissionCheck,
    startedAt: number,
  ): ToolExecutionPreflightInternal {
    let factRequest: ToolCallRequest;
    try {
      factRequest = { ...request, input: normalizeToolFactValue(request.input) };
    } catch (error) {
      if (!(error instanceof InvalidToolFactError)) {
        throw error;
      }
      return blockedPreflight(failedToolResult({ ...request, input: undefined }, startedAt, {
        message: `Tool input is not JSON-safe at ${error.path}: ${error.reason}.`,
        errorDomain: "runtime_error",
        facts: { ...error.facts, code: "invalid_tool_input_fact", phase: "input" },
      }));
    }
    if (isAbortSignalAborted(context.abortSignal)) {
      return blockedPreflight(cancelledToolResult(factRequest, startedAt));
    }
    const executor = this.tools.get(factRequest.toolName);
    if (executor === undefined) {
      return blockedPreflight(failedToolResult(factRequest, startedAt, {
        message: `${toolDisplayName(factRequest.toolName)}未注册。`,
        errorDomain: "tool_error",
      }));
    }

    if (permission.callerAgentId !== context.callerAgentId) {
      return blockedPreflight(failedToolResult(
        factRequest,
        startedAt,
        {
          message: `${toolDisplayName(factRequest.toolName)}调用者身份与本轮工具授权不一致。`,
          errorDomain: "tool_error",
        }
      ));
    }

    if (!permission.allowedTools.includes(factRequest.toolName)) {
      return blockedPreflight(failedToolResult(
        factRequest,
        startedAt,
        {
          message: `${toolDisplayName(factRequest.toolName)}未授权给当前 Agent。`,
          errorDomain: "tool_error",
        }
      ));
    }

    const metadata = normalizeToolMetadata(executor.definition);
    const securityDecision = evaluateToolCallSecurity({
      request: factRequest,
      definition: executor.definition,
      metadata,
      context: {
        platform: this.platform,
        approvedConfirmationIds: permission.approvedConfirmationIds,
        confirmationPolicy: permission.confirmationPolicy,
      },
    });
    if (securityDecision.decision === "blocked") {
      return blockedPreflight(failedToolResult(factRequest, startedAt, {
        message: securityDecision.reason,
        errorDomain: "tool_error",
        facts: {
          code: securityDecision.code,
          affectedResources: [...securityDecision.affectedResources],
        },
      }));
    }
    if (securityDecision.decision === "approval_required") {
      return {
        status: "approval_required",
        result: approvalRequiredToolResult(factRequest, startedAt, securityDecision),
      };
    }
    return { status: "ready", request: factRequest, executor };
  }

  private async prepareResultForDelivery(
    result: ToolCallResult,
    permission: ToolPermissionCheck,
    ownerId: string,
  ): Promise<ToolCallResult> {
    if (result.toolName === TOOL_OUTPUT_READER_NAME) {
      return result;
    }
    const failureCandidate = oversizedExplicitFailureCandidate(
      result,
      this.maxInlineOutputChars,
      this.exceedsTokenEnvelope(result),
    );
    if (failureCandidate !== undefined) {
      return this.prepareExplicitFailureForDelivery(
        result,
        permission,
        failureCandidate,
        ownerId,
      );
    }
    const inlineOutputLimit = result.status === "approval_required"
      ? Math.min(this.maxInlineOutputChars, MAX_INLINE_APPROVAL_PARTIAL_OUTPUT_CHARS)
      : this.maxInlineOutputChars;
    const candidate = oversizedOutputCandidate(
      result.output,
      inlineOutputLimit,
      this.exceedsTokenEnvelope(result),
    );
    if (candidate === undefined) {
      return result;
    }

    const preview = retainedOutputPreview(candidate.content);
    if (
      this.outputStore === undefined ||
      !this.tools.has(TOOL_OUTPUT_READER_NAME) ||
      !permission.allowedTools.includes(TOOL_OUTPUT_READER_NAME)
    ) {
      return outputRetentionFailure(result, candidate, preview, {
        code: "tool_output_reader_unavailable",
        message: "Tool output exceeded the model transport budget, but read_output is not available in this run.",
      });
    }

    try {
      const retained = await this.outputStore.retain({
        mediaType: candidate.mediaType,
        content: candidate.content,
        sourceToolName: result.toolName,
        sourceCallId: result.callId,
        sourceFactId: toolCallFactId(result),
        ownerId,
      });
      const deliveryOutput = copyToolModelAttachments(
        result.output,
        retainedContentDelivery(preview, retained),
      );
      return this.fitRetainedDeliveryPreview(
        { ...result, output: deliveryOutput },
        candidate.content,
      );
    } catch (error) {
      const storeError = error instanceof ToolOutputStoreError ? error : undefined;
      return outputRetentionFailure(result, candidate, preview, {
        code: storeError?.code ?? "tool_output_retention_failed",
        message: storeError?.message ?? "Tool output could not be retained for model continuation.",
        facts: storeError?.facts,
      });
    }
  }

  private async prepareExplicitFailureForDelivery(
    result: ToolCallResult,
    permission: ToolPermissionCheck,
    candidate: OversizedOutputCandidate,
    ownerId: string,
  ): Promise<ToolCallResult> {
    const preview = retainedOutputPreview(candidate.content);
    if (
      this.outputStore === undefined ||
      !this.tools.has(TOOL_OUTPUT_READER_NAME) ||
      !permission.allowedTools.includes(TOOL_OUTPUT_READER_NAME)
    ) {
      return explicitFailureRetentionFailure(result, candidate, preview, {
        code: "tool_error_reader_unavailable",
        message: "Tool failure evidence exceeded the model transport budget, but read_output is not available in this run.",
      });
    }

    try {
      const retained = await this.outputStore.retain({
        mediaType: candidate.mediaType,
        content: candidate.content,
        sourceToolName: result.toolName,
        sourceCallId: result.callId,
        sourceFactId: toolCallFactId(result),
        ownerId,
      });
      return this.fitRetainedDeliveryPreview({
        ...result,
        output: copyToolModelAttachments(
          result.output,
          retainedContentDelivery(preview, retained),
        ),
        error: retainedErrorMessage(result.error),
        errorFacts: retainedExplicitFailureFacts(result.errorFacts, retained),
      }, candidate.content);
    } catch (storeFailure) {
      const storeError = storeFailure instanceof ToolOutputStoreError ? storeFailure : undefined;
      return explicitFailureRetentionFailure(result, candidate, preview, {
        code: storeError?.code ?? "tool_error_retention_failed",
        message: storeError?.message ?? "Tool failure evidence could not be retained for model continuation.",
        facts: storeError?.facts,
      });
    }
  }

  private exceedsTokenEnvelope(result: ToolCallResult): boolean {
    return this.outputTokenCounter !== undefined &&
      toolResultEnvelopeTokens(this.outputTokenCounter, result) > this.maxInlineOutputTokens;
  }

  private fitRetainedDeliveryPreview(
    result: ToolCallResult,
    sourceContent: string,
  ): ToolCallResult {
    if (this.outputTokenCounter === undefined) return result;
    const output = result.output;
    if (typeof output !== "object" || output === null || Array.isArray(output)) return result;
    let low = 0;
    let high = sourceContent.length;
    let best = "";
    while (low <= high) {
      const requestedLength = Math.floor((low + high) / 2);
      const prefixLength = utf16SafePrefixLength(sourceContent, requestedLength);
      const preview = prefixLength < sourceContent.length
        ? `${sourceContent.slice(0, Math.max(0, utf16SafePrefixLength(sourceContent, prefixLength - 1)))}…`
        : sourceContent;
      const candidate = {
        ...result,
        output: { ...output, contentPreview: preview },
      };
      const fits = this.outputTokenCounter.countText(preview) <= this.targetInlineBodyTokens &&
        toolResultEnvelopeTokens(this.outputTokenCounter, candidate) <= this.maxInlineOutputTokens;
      if (fits) {
        best = preview;
        low = requestedLength + 1;
      } else {
        high = requestedLength - 1;
      }
    }
    return { ...result, output: { ...output, contentPreview: best } };
  }

  private async prepareThrownErrorForDelivery(
    result: ToolCallResult,
    permission: ToolPermissionCheck,
    error: SanitizedToolError,
    ownerId: string,
  ): Promise<ToolCallResult> {
    const completeErrorResult = { ...result, errorFacts: error.fullFacts };
    const candidate = oversizedThrownErrorCandidate(
      error,
      this.maxInlineOutputChars,
      this.exceedsTokenEnvelope(completeErrorResult),
    );
    if (candidate === undefined) {
      return completeErrorResult;
    }

    const preview = retainedOutputPreview(candidate.content);
    const deliveryResult = {
      ...result,
      error: retainedErrorMessage(result.error),
    };
    if (
      this.outputStore === undefined ||
      !this.tools.has(TOOL_OUTPUT_READER_NAME) ||
      !permission.allowedTools.includes(TOOL_OUTPUT_READER_NAME)
    ) {
      return errorRetentionFailure(deliveryResult, candidate, preview, {
        code: "tool_error_reader_unavailable",
        message: "Tool error evidence exceeded the model transport budget, but read_output is not available in this run.",
      });
    }

    try {
      const retained = await this.outputStore.retain({
        mediaType: candidate.mediaType,
        content: candidate.content,
        sourceToolName: result.toolName,
        sourceCallId: result.callId,
        sourceFactId: toolCallFactId(result),
        ownerId,
      });
      return this.fitRetainedDeliveryPreview({
        ...deliveryResult,
        output: retainedContentDelivery(preview, retained),
      }, candidate.content);
    } catch (storeFailure) {
      const storeError = storeFailure instanceof ToolOutputStoreError ? storeFailure : undefined;
      return errorRetentionFailure(deliveryResult, candidate, preview, {
        code: storeError?.code ?? "tool_error_retention_failed",
        message: storeError?.message ?? "Tool error evidence could not be retained for model continuation.",
        facts: storeError?.facts,
      });
    }
  }

}

type OversizedOutputCandidate = {
  readonly mediaType: ToolOutputMediaType;
  readonly content: string;
};

type RetainedToolOutput = Awaited<ReturnType<ToolOutputStore["retain"]>>;

type RetainedContentDelivery = {
  readonly contentRef: string;
  readonly mediaType: ToolOutputMediaType;
  readonly contentChars: number;
  readonly contentBytes: number;
  readonly contentSha256: string;
  readonly contentPreview: string;
  readonly hasMoreAfter: true;
  readonly truncated: true;
  readonly expiresAt?: string;
  readonly continuationAvailability: "live_only" | "durable";
  readonly continuation: {
    readonly ref: string;
    readonly nextInput: {
      readonly ref: string;
      readonly startChar: number;
      readonly maxChars: number;
    };
    readonly note: string;
  };
};

function oversizedOutputCandidate(
  output: ToolCallResult["output"],
  maxInlineChars: number,
  exceedsTokenEnvelope = false,
): OversizedOutputCandidate | undefined {
  if (output === undefined) {
    return undefined;
  }
  if (typeof output === "string") {
    return JSON.stringify(output).length > maxInlineChars || exceedsTokenEnvelope
      ? { mediaType: "text/plain", content: output }
      : undefined;
  }
  const content = JSON.stringify(output);
  return content.length > maxInlineChars || exceedsTokenEnvelope
    ? { mediaType: "application/json", content }
    : undefined;
}

function oversizedExplicitFailureCandidate(
  result: ToolCallResult,
  maxInlineChars: number,
  exceedsTokenEnvelope = false,
): OversizedOutputCandidate | undefined {
  if (result.status !== "failed" && result.status !== "cancelled") {
    return undefined;
  }
  const content = JSON.stringify({
    status: result.status,
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.errorDomain === undefined ? {} : { errorDomain: result.errorDomain }),
    ...(result.errorFacts === undefined ? {} : { errorFacts: result.errorFacts }),
  });
  return content.length > maxInlineChars || exceedsTokenEnvelope
    ? { mediaType: "application/json", content }
    : undefined;
}

function toolResultEnvelopeTokens(
  counter: ToolOutputTokenCounter,
  result: ToolCallResult,
): number {
  return counter.countText(JSON.stringify(toolResultMessage(result)));
}

function retainedOutputPreview(content: string): string {
  if (content.length <= RETAINED_TOOL_OUTPUT_PREVIEW_CHARS) {
    return content;
  }
  const end = utf16SafePrefixLength(content, RETAINED_TOOL_OUTPUT_PREVIEW_CHARS - 1);
  return `${content.slice(0, end)}…`;
}

function retainedContentDelivery(
  preview: string,
  retained: RetainedToolOutput,
): RetainedContentDelivery {
  return {
    contentRef: retained.ref,
    mediaType: retained.mediaType,
    contentChars: retained.totalChars,
    contentBytes: retained.byteLength,
    contentSha256: retained.sha256,
    contentPreview: preview,
    hasMoreAfter: true,
    truncated: true,
    ...(retained.expiresAt === undefined ? {} : { expiresAt: retained.expiresAt }),
    continuationAvailability: retained.availability,
    continuation: {
      ref: retained.ref,
      nextInput: {
        ref: retained.ref,
        startChar: 0,
        maxChars: RETAINED_TOOL_OUTPUT_READ_CHARS,
      },
      note: "Call read_output with nextInput to read the retained result without executing the original tool again.",
    },
  };
}

function oversizedThrownErrorCandidate(
  error: SanitizedToolError,
  maxInlineChars: number,
  exceedsTokenEnvelope = false,
): OversizedOutputCandidate | undefined {
  const content = JSON.stringify({
    message: error.message,
    errorDomain: error.errorDomain,
    ...(error.fullFacts === undefined ? {} : { facts: error.fullFacts }),
  });
  return content.length > maxInlineChars || exceedsTokenEnvelope
    ? { mediaType: "application/json", content }
    : undefined;
}

function retainedErrorMessage(value: string | undefined): string | undefined {
  return value === undefined ? undefined : retainedOutputPreview(value);
}

function retainedExplicitFailureFacts(
  facts: ToolErrorFacts | undefined,
  retained: RetainedToolOutput,
): ToolErrorFacts {
  return mergeToolErrorFacts(compactErrorFactsForDelivery(facts), {
    errorEvidenceCode: "tool_error_evidence_retained",
    errorEvidencePhase: "explicit_failure_retention",
    errorEvidenceRef: retained.ref,
    errorEvidenceChars: retained.totalChars,
  });
}

function explicitFailureRetentionFailure(
  result: ToolCallResult,
  candidate: OversizedOutputCandidate,
  preview: string,
  failure: {
    readonly code: string;
    readonly message: string;
    readonly facts?: Readonly<Record<string, string | number>>;
  },
): ToolCallResult {
  return {
    ...result,
    output: copyToolModelAttachments(result.output, {
      mediaType: candidate.mediaType,
      contentChars: candidate.content.length,
      contentPreview: preview,
      hasMoreAfter: true,
      contentIncomplete: true,
      retentionFailed: true,
    }),
    error: retainedErrorMessage(result.error) ?? failure.message,
    errorFacts: mergeToolErrorFacts(compactErrorFactsForDelivery(result.errorFacts), {
      ...(failure.facts ?? {}),
      errorEvidenceCode: failure.code,
      errorEvidencePhase: "explicit_failure_retention",
      errorEvidenceMessage: failure.message,
    }),
  };
}

function errorRetentionFailure(
  result: ToolCallResult,
  candidate: OversizedOutputCandidate,
  preview: string,
  failure: {
    readonly code: string;
    readonly message: string;
    readonly facts?: Readonly<Record<string, string | number>>;
  },
): ToolCallResult {
  return {
    ...result,
    output: {
      mediaType: candidate.mediaType,
      contentChars: candidate.content.length,
      contentPreview: preview,
      hasMoreAfter: true,
      contentIncomplete: true,
      retentionFailed: true,
    },
    errorFacts: mergeToolErrorFacts(result.errorFacts, {
      ...(failure.facts ?? {}),
      errorEvidenceCode: failure.code,
      errorEvidencePhase: "error_retention",
      errorEvidenceMessage: failure.message,
    }),
  };
}

function outputRetentionFailure(
  result: ToolCallResult,
  candidate: OversizedOutputCandidate,
  preview: string,
  failure: {
    readonly code: string;
    readonly message: string;
    readonly facts?: Readonly<Record<string, string | number>>;
  },
): ToolCallResult {
  const output = copyToolModelAttachments(result.output, {
    mediaType: candidate.mediaType,
    contentChars: candidate.content.length,
    contentPreview: preview,
    retentionFailed: true,
    contentIncomplete: true,
    deliveryStatus: "failed",
    deliveryCode: failure.code,
    deliveryMessage: failure.message,
    sourceExecutionStatus: result.status,
    doNotBlindlyRetry: result.status === "completed",
  });
  if (result.status !== "completed") {
    return {
      ...result,
      output,
      error: result.error ?? failure.message,
      errorDomain: result.errorDomain ?? "runtime_error",
      errorFacts: mergeToolErrorFacts(compactErrorFactsForDelivery(result.errorFacts), {
        ...(failure.facts ?? {}),
        outputDeliveryCode: failure.code,
        outputDeliveryPhase: "output_retention",
        outputDeliveryMessage: failure.message,
        originalStatus: result.status,
      }),
    };
  }
  return {
    ...result,
    output,
    status: "failed",
    error: failure.message,
    errorDomain: "runtime_error",
    errorFacts: {
      code: failure.code,
      phase: "output_retention",
      originalStatus: result.status,
      outputDeliveryCode: failure.code,
      ...(failure.facts ?? {}),
    },
    confirmationRequest: undefined,
  };
}

function compactErrorFactsForDelivery(facts: ToolErrorFacts | undefined): ToolErrorFacts | undefined {
  return normalizeToolErrorFacts(facts, {
    compactString: (value) => compactToolErrorText(value, 500),
  });
}

function positiveInlineOutputLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_INLINE_TOOL_OUTPUT_CHARS;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error("ToolCenter maxInlineOutputChars must be a positive safe integer.");
  }
  return resolved;
}

function positiveTokenLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`ToolCenter ${name} must be a positive safe integer.`);
  }
  return resolved;
}

function isToolExecutorResult(value: unknown): value is ToolExecutorResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly kind?: unknown }).kind === "tool_call_result" &&
    typeof (value as { readonly result?: unknown }).result === "object" &&
    (value as { readonly result?: unknown }).result !== null
  );
}

function recordFromUnknown(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function retentionFailureReason(code: string | undefined): "capacity_failure" | "serialization_failure" {
  return code === "tool_output_capacity_exceeded" || code === "tool_output_item_too_large"
    ? "capacity_failure"
    : "serialization_failure";
}

function continuationFailure(
  facts: Readonly<Record<string, unknown>>,
): "expired" | "read_failed" {
  const code = stringFromUnknown(facts.code);
  return code === "tool_output_expired" || code === "tool_output_not_found"
    ? "expired"
    : "read_failed";
}

function continuationIdentity(record: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["ref", "snapshotRef", "responseRef"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return `${key}:${value}`;
  }
  return undefined;
}

function nativeProducerContinuation(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  output: Readonly<Record<string, unknown>>,
): {
  readonly offered: boolean;
  readonly completed: boolean;
  readonly chainValue: string;
  readonly pageChars?: number;
} | undefined {
  const contract = toolName === "Read"
    ? { nextKeys: ["nextStartChar", "nextStartLine"], startKeys: ["startChar", "startLine"], identityKeys: ["path"] }
    : toolName === "List"
      ? { nextKeys: ["nextOffset"], startKeys: ["offset"], identityKeys: ["path", "depth"] }
      : toolName === "Grep"
        ? { nextKeys: ["nextOffset"], startKeys: ["offset"], identityKeys: ["path", "query"] }
        : undefined;
  if (contract === undefined) return undefined;
  const outputContinuation = recordFromUnknown(output.continuation);
  const continuationInput = recordFromUnknown(outputContinuation.nextInput);
  const offered = contract.startKeys.some((key) => numberFromUnknown(continuationInput[key]) !== undefined) ||
    contract.nextKeys.some((key) => numberFromUnknown(output[key]) !== undefined);
  const isContinuationRequest = contract.startKeys.some((key) => (numberFromUnknown(input[key]) ?? 0) > 0);
  if (!offered && !isContinuationRequest) return undefined;
  const identitySource = offered ? continuationInput : input;
  const identity = Object.fromEntries(contract.identityKeys.map((key) => [
    key,
    identitySource[key] ?? input[key] ?? null,
  ]));
  return {
    offered,
    completed: !offered,
    chainValue: `${toolName}:${JSON.stringify(identity)}`,
    pageChars: numberFromUnknown(output.textChars) ??
      (typeof output.content === "string" ? output.content.length : JSON.stringify(output).length),
  };
}

function normalizeExecutorResult(
  result: ToolCallResult,
  request: ToolCallRequest,
  startedAt: number
): ToolCallResult {
  const raw = result as ToolCallResult & Readonly<Record<string, unknown>>;
  const output = normalizeToolFactValue(raw.output);
  const durationMs = finiteDuration(raw.durationMs, startedAt);
  const status = toolCallStatus(raw.status);
  if (status === undefined) {
    return invalidExecutorResult({
      request,
      output,
      durationMs,
      code: "invalid_tool_result_status",
      message: "Tool executor returned an invalid completion status.",
    });
  }

  if (status === "approval_required") {
    const confirmationRequest = normalizeConfirmationRequest(raw.confirmationRequest);
    if (confirmationRequest === undefined) {
      return invalidExecutorResult({
        request,
        output,
        durationMs,
        code: "invalid_tool_confirmation_request",
        message: "Tool executor requested approval without a valid confirmation request.",
      });
    }
    return {
      callId: request.callId,
      ...toolFactIdentity(request),
      toolName: request.toolName,
      input: request.input,
      output,
      status,
      durationMs,
      confirmationRequest,
    };
  }

  if (status === "completed") {
    return {
      callId: request.callId,
      ...toolFactIdentity(request),
      toolName: request.toolName,
      input: request.input,
      output,
      status,
      durationMs,
    };
  }

  const errorFacts = normalizeToolErrorFacts(raw.errorFacts);
  const errorDomain = isToolErrorDomain(raw.errorDomain)
    ? raw.errorDomain
    : status === "failed"
      ? defaultToolErrorDomain(request.toolName, errorFacts)
      : undefined;
  return {
    callId: request.callId,
    ...toolFactIdentity(request),
    toolName: request.toolName,
    input: request.input,
    output,
    status,
    error: typeof raw.error === "string" && raw.error.trim().length > 0
      ? raw.error
      : status === "cancelled"
        ? "Tool execution cancelled."
        : "Tool execution failed.",
    errorDomain,
    errorFacts,
    ...(status === "failed" ? { failureAttribution: "execution_failure" as const } : {}),
    durationMs,
  };
}

function invalidExecutorResult(input: {
  readonly request: ToolCallRequest;
  readonly output: ToolCallResult["output"];
  readonly durationMs: number;
  readonly code: string;
  readonly message: string;
}): ToolCallResult {
  return {
    callId: input.request.callId,
    ...toolFactIdentity(input.request),
    toolName: input.request.toolName,
    input: input.request.input,
    output: input.output,
    status: "failed",
    error: input.message,
    errorDomain: "runtime_error",
    errorFacts: {
      code: input.code,
      phase: "executor_result",
      sourceExecutionStatus: "unknown",
      doNotBlindlyRetry: true,
      outputDeliveryPhase: "executor_result_normalization",
      outputDeliveryCode: input.code,
    },
    durationMs: input.durationMs,
  };
}

function finiteDuration(value: unknown, startedAt: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : Date.now() - startedAt;
}

function toolCallStatus(value: unknown): ToolCallResult["status"] | undefined {
  return value === "completed" || value === "failed" || value === "approval_required" || value === "cancelled"
    ? value
    : undefined;
}

function normalizeConfirmationRequest(value: unknown): ConfirmationRequest | undefined {
  const record = asPlainRecord(value);
  const confirmationId = nonEmptyString(record.confirmationId);
  const confirmationToolCallFactId = nonEmptyString(record.toolCallFactId);
  const title = nonEmptyString(record.title);
  const actionSummary = nonEmptyString(record.actionSummary);
  const requestedAt = nonEmptyString(record.requestedAt);
  const affectedResources = stringArray(record.affectedResources);
  const sourceRefs = stringArray(record.sourceRefs);
  const riskLevel = confirmationRiskLevel(record.riskLevel);
  const conversationId = optionalNonEmptyString(record.conversationId);
  const consequence = optionalNonEmptyString(record.consequence);
  const expiresAt = optionalNonEmptyString(record.expiresAt);
  const resumeAvailability = confirmationResumeAvailability(record.resumeAvailability);
  if (
    confirmationId === undefined ||
    confirmationToolCallFactId === undefined ||
    title === undefined ||
    actionSummary === undefined ||
    requestedAt === undefined ||
    affectedResources === undefined ||
    sourceRefs === undefined ||
    riskLevel === undefined ||
    (record.conversationId !== undefined && conversationId === undefined) ||
    (record.consequence !== undefined && consequence === undefined) ||
    (record.expiresAt !== undefined && expiresAt === undefined) ||
    (record.resumeAvailability !== undefined && resumeAvailability === undefined)
  ) {
    return undefined;
  }
  return {
    confirmationId,
    toolCallFactId: confirmationToolCallFactId,
    conversationId,
    title,
    actionSummary,
    consequence,
    affectedResources,
    riskLevel,
    resumeAvailability,
    requestedAt,
    expiresAt,
    sourceRefs,
  };
}

function asPlainRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return value === undefined ? undefined : nonEmptyString(value);
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => nonEmptyString(item) !== undefined)
    ? value.map((item) => nonEmptyString(item)!)
    : undefined;
}

function confirmationRiskLevel(value: unknown): ConfirmationRequest["riskLevel"] | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function confirmationResumeAvailability(
  value: unknown
): ConfirmationRequest["resumeAvailability"] | undefined {
  return value === undefined || value === "live" || value === "lost_after_restart"
    ? value
    : undefined;
}

function failedToolResult(
  request: ToolCallRequest,
  startedAt: number,
  error: SanitizedToolError
): ToolCallResult & { readonly status: "failed" } {
  const durationMs = Date.now() - startedAt;
  return {
    callId: request.callId,
    ...toolFactIdentity(request),
    toolName: request.toolName,
    input: request.input,
    output: undefined,
    status: "failed",
    error: error.message,
    errorDomain: error.errorDomain,
    errorFacts: error.facts,
    durationMs,
  };
}

function blockedPreflight(
  result: ToolCallResult & { readonly status: "failed" | "cancelled" },
): Extract<ToolExecutionPreflight, { readonly status: "blocked" }> {
  return { status: "blocked", result };
}

function approvalRequiredToolResult(
  request: ToolCallRequest,
  startedAt: number,
  decision: Extract<ToolSecurityDecision, { readonly decision: "approval_required" }>
): ToolCallResult & { readonly status: "approval_required" } {
  const confirmationRequest: ConfirmationRequest = confirmationRequestFromSecurityDecision({ request, decision });
  return {
    callId: request.callId,
    ...toolFactIdentity(request),
    toolName: request.toolName,
    input: request.input,
    output: undefined,
    status: "approval_required",
    durationMs: Date.now() - startedAt,
    confirmationRequest,
  };
}

function cancelledToolResult(
  request: ToolCallRequest,
  startedAt: number,
  errorFacts?: ToolErrorFacts,
): ToolCallResult & { readonly status: "cancelled" } {
  return {
    callId: request.callId,
    ...toolFactIdentity(request),
    toolName: request.toolName,
    input: request.input,
    output: undefined,
    status: "cancelled",
    error: "Tool execution cancelled.",
    errorFacts,
    durationMs: Date.now() - startedAt,
  };
}

function toolFactIdentity(
  request: ToolCallRequest,
): Pick<ToolCallRequest, "factId" | "parentToolCallFactId"> {
  return {
    ...(request.factId === undefined ? {} : { factId: request.factId }),
    ...(request.parentToolCallFactId === undefined
      ? {}
      : { parentToolCallFactId: request.parentToolCallFactId }),
  };
}

function cloneToolDefinition(definition: ToolDefinition): ToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: cloneToolInputSchema(definition.inputSchema),
    outputSchema:
      definition.outputSchema === undefined
        ? undefined
        : cloneToolJsonSchema(definition.outputSchema),
    metadata: normalizeToolMetadata(definition),
  };
}

function normalizeToolMetadata(definition: ToolDefinition): ToolDefinitionMetadata {
  if (definition.metadata === undefined) {
    throw new Error(`Tool ${definition.name} cannot enter ToolCenter without metadata.`);
  }
  return {
    ...definition.metadata,
    runtimeHints: cloneRuntimeHints(definition.metadata.runtimeHints),
  };
}

function cloneRuntimeHints(value: ToolDefinitionMetadata["runtimeHints"]): ToolDefinitionMetadata["runtimeHints"] {
  if (value === undefined) {
    return undefined;
  }
  return value.map((hint) => {
    if (hint.kind === "command_shell") {
      return {
        ...hint,
        invocation: [...hint.invocation],
        notes: [...hint.notes],
      };
    }
    return hint;
  });
}

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as { readonly name?: unknown; readonly code?: unknown };
  return record.name === "AbortError" || record.code === "ABORT_ERR";
}

type SanitizedToolError = {
  readonly message: string;
  readonly errorDomain: ToolErrorDomain;
  readonly facts?: ToolErrorFacts;
  readonly fullFacts?: ToolErrorFacts;
};

function sanitizeError(error: unknown, toolName: string): SanitizedToolError {
  if (error instanceof InvalidToolFactError) {
    const facts = { ...error.facts, code: "invalid_tool_output_fact", phase: "output" };
    return {
      message: normalizeToolErrorText(error.message),
      errorDomain: error.errorDomain,
      facts,
      fullFacts: facts,
    };
  }
  const message = normalizeToolErrorText(
    error instanceof Error ? error.message : "Tool execution failed.",
  );
  const fullFacts = toolErrorFactsFromUnknown(error, false);
  const facts = toolErrorFactsFromUnknown(error, true);
  return {
    message,
    errorDomain: toolErrorDomainFromUnknown(error) ?? defaultToolErrorDomain(toolName, facts),
    facts,
    fullFacts,
  };
}

function defaultToolErrorDomain(toolName: string, facts: ToolErrorFacts | undefined): ToolErrorDomain {
  if (toolName === "Shell" || toolName === "ProcessStop" || toolName === "ProcessRead") {
    return "process_error";
  }
  const code = typeof facts?.code === "string" ? facts.code.toLowerCase() : undefined;
  if (
    code !== undefined &&
    (code.includes("enoent") ||
      code.includes("spawn") ||
      code.includes("exit") ||
      code.includes("signal") ||
      code.includes("process"))
  ) {
    return "process_error";
  }
  return "tool_error";
}

function toolErrorDomainFromUnknown(value: unknown): ToolErrorDomain | undefined {
  const record = asRecord(value);
  return isToolErrorDomain(record.errorDomain) ? record.errorDomain : undefined;
}

function toolErrorFactsFromUnknown(value: unknown, compact: boolean): ToolErrorFacts | undefined {
  const record = asRecord(value);
  const compactString = compact
    ? (text: string) => compactToolErrorText(text, 500)
    : normalizeToolErrorText;
  const facts = normalizeToolErrorFacts(record.facts, { compactString });
  const code = normalizeToolErrorFactValue(record.code, { compactString });
  const name = typeof record.name === "string" && record.name.length > 0 ? record.name : undefined;
  const merged: Record<string, ToolErrorFacts[string]> = {};
  if (facts !== undefined) {
    for (const [key, fact] of Object.entries(facts)) {
      defineOwnFact(merged, key, fact);
    }
  }
  if (code !== undefined && merged.code === undefined) {
    merged.code = code;
  }
  if (name !== undefined && merged.name === undefined) {
    merged.name = name;
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function defineOwnFact(
  target: Record<string, ToolErrorFacts[string]>,
  key: string,
  value: ToolErrorFacts[string]
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function mergeToolErrorFacts(
  original: ToolErrorFacts | undefined,
  additions: Readonly<Record<string, ToolErrorFacts[string]>>,
): ToolErrorFacts {
  const merged: Record<string, ToolErrorFacts[string]> = {};
  for (const [key, value] of Object.entries(original ?? {})) {
    defineOwnFact(merged, key, value);
  }
  for (const [key, value] of Object.entries(additions)) {
    defineOwnFact(merged, key, value);
  }
  return merged;
}


function compactToolErrorText(value: string, maxLength: number): string {
  const normalized = normalizeToolErrorText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const suffix = maxLength >= 3 ? "..." : ".".repeat(Math.max(0, maxLength));
  const end = utf16SafePrefixLength(normalized, Math.max(0, maxLength - suffix.length));
  return `${normalized.slice(0, end).trimEnd()}${suffix}`;
}

function normalizeToolErrorText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}
