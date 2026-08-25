import type { ModelUsage } from "../../domain/intelligence/index.js";

type ProviderRequestTiming = {
  readonly startedAtMs: number;
  firstVisibleOutputAtMs?: number;
};

/** Run-local provider timing facts observed from root Harness events. */
export class AgentSessionProviderTiming {
  private latencyTotalMs = 0;
  private latencySampleCount = 0;
  private firstTokenLatencyTotalMs = 0;
  private firstTokenLatencySampleCount = 0;
  private outputDurationTotalMs = 0;
  private outputDurationSampleCount = 0;
  private visibleOutputTokens = 0;
  private visibleOutputDurationMs = 0;
  private activeRequest: ProviderRequestTiming | undefined;

  constructor(private readonly now: () => number) {}

  startRequest(): void {
    this.activeRequest = { startedAtMs: this.now() };
  }

  observeVisibleOutput(): void {
    if (this.activeRequest === undefined || this.activeRequest.firstVisibleOutputAtMs !== undefined) return;
    this.activeRequest.firstVisibleOutputAtMs = this.now();
  }

  completeUsage(current: ModelUsage, outputTokens: number): ModelUsage {
    const request = this.activeRequest;
    this.activeRequest = undefined;
    if (request === undefined) return current;

    const completedAtMs = this.now();
    const latencyMs = elapsedMs(request.startedAtMs, completedAtMs);
    this.latencyTotalMs += latencyMs;
    this.latencySampleCount += 1;

    if (request.firstVisibleOutputAtMs !== undefined) {
      const firstTokenLatencyMs = elapsedMs(request.startedAtMs, request.firstVisibleOutputAtMs);
      const outputDurationMs = elapsedMs(request.firstVisibleOutputAtMs, completedAtMs);
      this.firstTokenLatencyTotalMs += firstTokenLatencyMs;
      this.firstTokenLatencySampleCount += 1;
      this.outputDurationTotalMs += outputDurationMs;
      this.outputDurationSampleCount += 1;
      if (Number.isFinite(outputTokens) && outputTokens > 0 && outputDurationMs > 0) {
        this.visibleOutputTokens += Math.floor(outputTokens);
        this.visibleOutputDurationMs += outputDurationMs;
      }
    }

    return {
      ...current,
      latencyMs: averageDuration(this.latencyTotalMs, this.latencySampleCount),
      ...(this.firstTokenLatencySampleCount === 0 ? {} : {
        firstTokenLatencyMs: averageDuration(
          this.firstTokenLatencyTotalMs,
          this.firstTokenLatencySampleCount,
        ),
        outputDurationMs: averageDuration(
          this.outputDurationTotalMs,
          this.outputDurationSampleCount,
        ),
      }),
      ...(this.visibleOutputDurationMs === 0 ? {} : {
        outputTokensPerSecond: Number((
          this.visibleOutputTokens / (this.visibleOutputDurationMs / 1_000)
        ).toFixed(2)),
      }),
    };
  }
}

export function mergeModelUsage(
  current: ModelUsage,
  next: ModelUsage | undefined,
  options: { readonly preserveLatestAgentRequest?: boolean } = {},
): ModelUsage {
  if (next === undefined) return current;
  return {
    requestCount: (current.requestCount ?? 0) + (next.requestCount ?? 0),
    inputTokens: (current.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (current.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (current.totalTokens ?? 0) + (next.totalTokens ?? 0),
    cachedInputTokens: (current.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
    cacheWriteInputTokens: (current.cacheWriteInputTokens ?? 0) + (next.cacheWriteInputTokens ?? 0),
    uncachedInputTokens: (current.uncachedInputTokens ?? 0) + (next.uncachedInputTokens ?? 0),
    reasoningOutputTokens: (current.reasoningOutputTokens ?? 0) + (next.reasoningOutputTokens ?? 0),
    estimatedCostUsd: (current.estimatedCostUsd ?? 0) + (next.estimatedCostUsd ?? 0),
    ...(current.latencyMs === undefined ? {} : { latencyMs: current.latencyMs }),
    ...(current.firstTokenLatencyMs === undefined ? {} : { firstTokenLatencyMs: current.firstTokenLatencyMs }),
    ...(current.outputDurationMs === undefined ? {} : { outputDurationMs: current.outputDurationMs }),
    ...(current.outputTokensPerSecond === undefined ? {} : { outputTokensPerSecond: current.outputTokensPerSecond }),
    latestAgentRequest: options.preserveLatestAgentRequest
      ? current.latestAgentRequest
      : next.latestAgentRequest ?? current.latestAgentRequest,
  };
}

function elapsedMs(startedAtMs: number, completedAtMs: number): number {
  return Math.max(0, Math.round(completedAtMs - startedAtMs));
}

function averageDuration(totalMs: number, sampleCount: number): number {
  return Math.round(totalMs / sampleCount);
}
