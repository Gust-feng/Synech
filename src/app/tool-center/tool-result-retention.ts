import type { ToolCallResult, ToolErrorDomain, ToolErrorFacts } from "../../domain/tools/index.js";
import {
  copyToolModelAttachments,
  normalizeToolErrorFacts,
  toolCallFactId,
} from "../../domain/tools/index.js";
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

export const TOOL_OUTPUT_READER_NAME = "ReadOutput";

const RETAINED_TOOL_OUTPUT_PREVIEW_CHARS = 4_000;
const MAX_INLINE_APPROVAL_PARTIAL_OUTPUT_CHARS = 24_000;

export type ToolResultRetentionOptions = {
  readonly outputStore?: ToolOutputStore;
  readonly maxInlineOutputChars?: number;
  readonly outputTokenCounter?: ToolOutputTokenCounter;
  readonly maxInlineOutputTokens?: number;
  readonly targetInlineBodyTokens?: number;
};

export type RetainableToolError = {
  readonly message: string;
  readonly errorDomain: ToolErrorDomain;
  readonly facts?: ToolErrorFacts;
  readonly fullFacts?: ToolErrorFacts;
};

type DeliveryContext = {
  readonly readerAvailable: boolean;
  readonly ownerId: string;
};

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

export class ToolResultRetention {
  readonly maxInlineOutputChars: number;
  readonly maxInlineOutputTokens: number;

  private readonly outputStore: ToolOutputStore | undefined;
  private readonly outputTokenCounter: ToolOutputTokenCounter | undefined;
  private readonly targetInlineBodyTokens: number;

  constructor(options: ToolResultRetentionOptions = {}) {
    this.outputStore = options.outputStore;
    this.maxInlineOutputChars = positiveLimit(
      options.maxInlineOutputChars,
      DEFAULT_MAX_INLINE_TOOL_OUTPUT_CHARS,
      "maxInlineOutputChars",
    );
    this.outputTokenCounter = options.outputTokenCounter;
    this.maxInlineOutputTokens = positiveLimit(
      options.maxInlineOutputTokens,
      DEFAULT_MAX_INLINE_TOOL_RESULT_TOKENS,
      "maxInlineOutputTokens",
    );
    this.targetInlineBodyTokens = positiveLimit(
      options.targetInlineBodyTokens,
      DEFAULT_TARGET_INLINE_TOOL_BODY_TOKENS,
      "targetInlineBodyTokens",
    );
  }

  textTokens(text: string): number | undefined {
    return this.outputTokenCounter?.countText(text);
  }

  envelopeTokens(result: ToolCallResult): number | undefined {
    return this.outputTokenCounter?.countText(JSON.stringify(toolResultMessage(result)));
  }

  async prepareResult(result: ToolCallResult, context: DeliveryContext): Promise<ToolCallResult> {
    if (result.toolName === TOOL_OUTPUT_READER_NAME) return result;

    const failureCandidate = oversizedExplicitFailureCandidate(
      result,
      this.maxInlineOutputChars,
      this.exceedsTokenEnvelope(result),
    );
    if (failureCandidate !== undefined) {
      return this.prepareExplicitFailure(result, failureCandidate, context);
    }

    const inlineOutputLimit = result.status === "approval_required"
      ? Math.min(this.maxInlineOutputChars, MAX_INLINE_APPROVAL_PARTIAL_OUTPUT_CHARS)
      : this.maxInlineOutputChars;
    const candidate = oversizedOutputCandidate(
      result.output,
      inlineOutputLimit,
      this.exceedsTokenEnvelope(result),
    );
    if (candidate === undefined) return result;

    const preview = retainedOutputPreview(candidate.content);
    if (this.outputStore === undefined || !context.readerAvailable) {
      return outputRetentionFailure(result, candidate, preview, {
        code: "tool_output_reader_unavailable",
        message: "Tool output exceeded the model transport budget, but read_output is not available in this run.",
      });
    }

    try {
      const retained = await this.outputStore.retain(retentionInput(result, candidate, context.ownerId));
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

  async prepareThrownError(
    result: ToolCallResult,
    error: RetainableToolError,
    context: DeliveryContext,
  ): Promise<ToolCallResult> {
    const completeErrorResult = { ...result, errorFacts: error.fullFacts };
    const candidate = oversizedThrownErrorCandidate(
      error,
      this.maxInlineOutputChars,
      this.exceedsTokenEnvelope(completeErrorResult),
    );
    if (candidate === undefined) return completeErrorResult;

    const preview = retainedOutputPreview(candidate.content);
    const deliveryResult = { ...result, error: retainedErrorMessage(result.error) };
    if (this.outputStore === undefined || !context.readerAvailable) {
      return errorRetentionFailure(deliveryResult, candidate, preview, {
        code: "tool_error_reader_unavailable",
        message: "Tool error evidence exceeded the model transport budget, but read_output is not available in this run.",
      });
    }

    try {
      const retained = await this.outputStore.retain(retentionInput(result, candidate, context.ownerId));
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

  private async prepareExplicitFailure(
    result: ToolCallResult,
    candidate: OversizedOutputCandidate,
    context: DeliveryContext,
  ): Promise<ToolCallResult> {
    const preview = retainedOutputPreview(candidate.content);
    if (this.outputStore === undefined || !context.readerAvailable) {
      return explicitFailureRetentionFailure(result, candidate, preview, {
        code: "tool_error_reader_unavailable",
        message: "Tool failure evidence exceeded the model transport budget, but read_output is not available in this run.",
      });
    }

    try {
      const retained = await this.outputStore.retain(retentionInput(result, candidate, context.ownerId));
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
    const envelopeTokens = this.envelopeTokens(result);
    return envelopeTokens !== undefined && envelopeTokens > this.maxInlineOutputTokens;
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
      const candidate = { ...result, output: { ...output, contentPreview: preview } };
      const fits = this.outputTokenCounter.countText(preview) <= this.targetInlineBodyTokens &&
        (this.envelopeTokens(candidate) ?? 0) <= this.maxInlineOutputTokens;
      if (fits) {
        best = preview;
        low = requestedLength + 1;
      } else {
        high = requestedLength - 1;
      }
    }
    return { ...result, output: { ...output, contentPreview: best } };
  }
}

function retentionInput(
  result: ToolCallResult,
  candidate: OversizedOutputCandidate,
  ownerId: string,
) {
  return {
    mediaType: candidate.mediaType,
    content: candidate.content,
    sourceToolName: result.toolName,
    sourceCallId: result.callId,
    sourceFactId: toolCallFactId(result),
    ownerId,
  };
}

function oversizedOutputCandidate(
  output: ToolCallResult["output"],
  maxInlineChars: number,
  exceedsTokenEnvelope: boolean,
): OversizedOutputCandidate | undefined {
  if (output === undefined) return undefined;
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
  exceedsTokenEnvelope: boolean,
): OversizedOutputCandidate | undefined {
  if (result.status !== "failed" && result.status !== "cancelled") return undefined;
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

function oversizedThrownErrorCandidate(
  error: RetainableToolError,
  maxInlineChars: number,
  exceedsTokenEnvelope: boolean,
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

function retainedOutputPreview(content: string): string {
  if (content.length <= RETAINED_TOOL_OUTPUT_PREVIEW_CHARS) return content;
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
        maxChars: MAX_TOOL_OUTPUT_READ_CHARS,
      },
      note: "Call read_output with nextInput to read the retained result without executing the original tool again.",
    },
  };
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
  failure: RetentionFailure,
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
  failure: RetentionFailure,
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
  failure: RetentionFailure,
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

type RetentionFailure = {
  readonly code: string;
  readonly message: string;
  readonly facts?: Readonly<Record<string, string | number>>;
};

function compactErrorFactsForDelivery(facts: ToolErrorFacts | undefined): ToolErrorFacts | undefined {
  return normalizeToolErrorFacts(facts, {
    compactString: (value) => compactRetentionText(value, 500),
  });
}

function mergeToolErrorFacts(
  original: ToolErrorFacts | undefined,
  additions: Readonly<Record<string, ToolErrorFacts[string]>>,
): ToolErrorFacts {
  const merged: Record<string, ToolErrorFacts[string]> = {};
  for (const [key, value] of Object.entries(original ?? {})) defineOwnFact(merged, key, value);
  for (const [key, value] of Object.entries(additions)) defineOwnFact(merged, key, value);
  return merged;
}

function defineOwnFact(
  target: Record<string, ToolErrorFacts[string]>,
  key: string,
  value: ToolErrorFacts[string],
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function compactRetentionText(value: string, maxLength: number): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length <= maxLength) return normalized;
  const suffix = maxLength >= 3 ? "..." : ".".repeat(Math.max(0, maxLength));
  const end = utf16SafePrefixLength(normalized, Math.max(0, maxLength - suffix.length));
  return `${normalized.slice(0, end).trimEnd()}${suffix}`;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`ToolCenter ${name} must be a positive safe integer.`);
  }
  return resolved;
}
