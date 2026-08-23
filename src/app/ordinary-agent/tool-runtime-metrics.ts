import type {
  ToolDefinitionMetricEvent,
  ToolExecutionMetricEvent,
  ToolExecutionMetricsSink,
  ToolOperationType,
  ToolResultMetricEvent,
  ToolSchedulingMetricEvent,
} from "../../domain/tools/index.js";

const TOKEN_BUCKETS = [0, 32, 64, 128, 256, 512, 1_024, 2_048, 4_096, 6_000, 8_192, 16_384, 32_768, 65_536, 131_072, 262_144] as const;
const COUNT_BUCKETS = [0, 1, 2, 3, 4, 5, 8, 12, 16, 24, 32, 64, 128, 256] as const;
const DURATION_BUCKETS = [0, 1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000] as const;

export type ToolMetricHistogramSnapshot = {
  readonly bounds: readonly number[];
  readonly counts: readonly number[];
  readonly count: number;
  readonly sum: number;
  readonly max: number;
};

export type OrdinaryToolMetricSnapshot = {
  readonly toolName: string;
  readonly operationType: ToolOperationType;
  readonly definitionHash?: string;
  readonly definitionTokens: ToolMetricHistogramSnapshot;
  readonly calls: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly approvalRequired: number;
  readonly retained: number;
  readonly retentionFailures: number;
  readonly retentionAvailability: Readonly<Record<string, number>>;
  readonly retentionMs: ToolMetricHistogramSnapshot;
  readonly continuationsOffered: number;
  readonly continuationsCompleted: number;
  readonly continuationReadFailures: number;
  readonly continuationExpired: number;
  readonly continuationChars: number;
  readonly inputTokens: ToolMetricHistogramSnapshot;
  readonly rawBodyTokens: ToolMetricHistogramSnapshot;
  readonly rawEnvelopeTokens: ToolMetricHistogramSnapshot;
  readonly finalEnvelopeTokens: ToolMetricHistogramSnapshot;
  readonly queueWaitMs: ToolMetricHistogramSnapshot;
  readonly executionMs: ToolMetricHistogramSnapshot;
  readonly continuationPages: ToolMetricHistogramSnapshot;
  readonly outputChars: number;
  readonly outputBytes: number;
  readonly maxActive: number;
  readonly queuedCancelled: number;
  readonly retentionReasons: Readonly<Record<string, number>>;
};

export type OrdinaryToolMetricsSnapshot = {
  readonly schemaVersion: "ordinary-tool-metrics/v1";
  readonly definitionRequestCount: number;
  readonly definitionToolCount: ToolMetricHistogramSnapshot;
  readonly totalDefinitionTokens: ToolMetricHistogramSnapshot;
  readonly metricsDroppedCount: number;
  readonly tools: readonly OrdinaryToolMetricSnapshot[];
};

type MutableToolMetric = {
  readonly toolName: string;
  operationType: ToolOperationType;
  definitionHash?: string;
  readonly definitionTokens: MutableHistogram;
  calls: number;
  completed: number;
  failed: number;
  cancelled: number;
  approvalRequired: number;
  retained: number;
  retentionFailures: number;
  readonly retentionAvailability: Map<string, number>;
  readonly retentionMs: MutableHistogram;
  continuationsOffered: number;
  continuationsCompleted: number;
  continuationReadFailures: number;
  continuationExpired: number;
  continuationChars: number;
  readonly inputTokens: MutableHistogram;
  readonly rawBodyTokens: MutableHistogram;
  readonly rawEnvelopeTokens: MutableHistogram;
  readonly finalEnvelopeTokens: MutableHistogram;
  readonly queueWaitMs: MutableHistogram;
  readonly executionMs: MutableHistogram;
  readonly continuationPages: MutableHistogram;
  outputChars: number;
  outputBytes: number;
  maxActive: number;
  queuedCancelled: number;
  readonly retentionReasons: Map<string, number>;
};

export class OrdinaryToolMetricsCollector implements ToolExecutionMetricsSink {
  private readonly tools = new Map<string, MutableToolMetric>();
  private readonly definitionToolCount = new MutableHistogram(COUNT_BUCKETS);
  private readonly totalDefinitionTokens = new MutableHistogram(TOKEN_BUCKETS);
  private definitionRequestCount = 0;
  private dropped = 0;
  private readonly continuationPageCounts = new Map<string, number>();

  record(event: ToolExecutionMetricEvent): void {
    try {
      if (event.kind === "definition") this.recordDefinition(event);
      else if (event.kind === "execution") this.recordExecution(event);
      else this.recordScheduling(event);
    } catch {
      this.dropped += 1;
    }
  }

  recordDefinitionRequest(toolCount: number, totalTokens: number): void {
    try {
      this.definitionRequestCount += 1;
      this.definitionToolCount.observe(toolCount);
      this.totalDefinitionTokens.observe(totalTokens);
    } catch {
      this.dropped += 1;
    }
  }

  recordDropped(count = 1): void {
    this.dropped += Math.max(1, nonNegative(count));
  }

  snapshot(): OrdinaryToolMetricsSnapshot {
    return {
      schemaVersion: "ordinary-tool-metrics/v1",
      definitionRequestCount: this.definitionRequestCount,
      definitionToolCount: this.definitionToolCount.snapshot(),
      totalDefinitionTokens: this.totalDefinitionTokens.snapshot(),
      metricsDroppedCount: this.dropped,
      tools: [...this.tools.values()].map(snapshotTool).sort((left, right) => left.toolName.localeCompare(right.toolName)),
    };
  }

  private recordDefinition(event: ToolDefinitionMetricEvent): void {
    const tool = this.tool(event.toolName, event.operationType);
    tool.definitionHash = event.definitionHash;
    tool.definitionTokens.observe(event.definitionTokens);
  }

  private recordExecution(event: ToolResultMetricEvent): void {
    const tool = this.tool(event.toolName, event.operationType);
    tool.calls += 1;
    if (event.status === "completed") tool.completed += 1;
    else if (event.status === "failed") tool.failed += 1;
    else if (event.status === "cancelled") tool.cancelled += 1;
    else tool.approvalRequired += 1;
    tool.inputTokens.observeOptional(event.inputTokens);
    tool.rawBodyTokens.observeOptional(event.rawBodyTokens);
    tool.rawEnvelopeTokens.observeOptional(event.rawEnvelopeTokens);
    tool.finalEnvelopeTokens.observeOptional(event.finalEnvelopeTokens);
    tool.outputChars += nonNegative(event.outputChars);
    tool.outputBytes += nonNegative(event.outputBytes);
    if (event.retained !== undefined) {
      tool.retained += 1;
      tool.retentionReasons.set(event.retained.reason, (tool.retentionReasons.get(event.retained.reason) ?? 0) + 1);
      const availability = event.retained.availability ?? "unknown";
      tool.retentionAvailability.set(availability, (tool.retentionAvailability.get(availability) ?? 0) + 1);
    }
    if (event.retentionFailure !== undefined) {
      tool.retentionFailures += 1;
      tool.retentionReasons.set(event.retentionFailure, (tool.retentionReasons.get(event.retentionFailure) ?? 0) + 1);
    }
    tool.retentionMs.observeOptional(event.retentionMs);
    if (event.continuation?.offered === true) tool.continuationsOffered += 1;
    if (event.continuation?.completed === true) tool.continuationsCompleted += 1;
    tool.continuationChars += nonNegative(event.continuation?.pageChars);
    if (event.continuation?.failure === "expired") tool.continuationExpired += 1;
    else if (event.continuation?.failure === "read_failed") tool.continuationReadFailures += 1;
    if (event.continuation?.chainHash !== undefined) {
      const key = `${event.toolName}:${event.continuation.chainHash}`;
      const pages = (this.continuationPageCounts.get(key) ?? 0) + 1;
      if (event.continuation.completed) {
        tool.continuationPages.observe(pages);
        this.continuationPageCounts.delete(key);
      } else {
        this.continuationPageCounts.set(key, pages);
      }
    }
  }

  private recordScheduling(event: ToolSchedulingMetricEvent): void {
    const tool = this.tool(event.toolName, event.operationType);
    tool.queueWaitMs.observe(event.queueWaitMs);
    tool.executionMs.observe(event.executionMs);
    tool.maxActive = Math.max(tool.maxActive, event.activeCount);
    if (event.cancelledWhileQueued === true) tool.queuedCancelled += 1;
  }

  private tool(toolName: string, operationType: ToolOperationType): MutableToolMetric {
    const existing = this.tools.get(toolName);
    if (existing !== undefined) return existing;
    const created = createToolMetric(toolName, operationType);
    this.tools.set(toolName, created);
    return created;
  }
}

class MutableHistogram {
  private readonly counts: number[];
  private count = 0;
  private sum = 0;
  private max = 0;

  constructor(private readonly bounds: readonly number[]) {
    this.counts = Array.from({ length: bounds.length + 1 }, () => 0);
  }

  observeOptional(value: number | undefined): void {
    if (value !== undefined) this.observe(value);
  }

  observe(value: number): void {
    const normalized = nonNegative(value);
    const index = this.bounds.findIndex((bound) => normalized <= bound);
    this.counts[index < 0 ? this.bounds.length : index] += 1;
    this.count += 1;
    this.sum += normalized;
    this.max = Math.max(this.max, normalized);
  }

  snapshot(): ToolMetricHistogramSnapshot {
    return { bounds: [...this.bounds], counts: [...this.counts], count: this.count, sum: this.sum, max: this.max };
  }
}

function createToolMetric(toolName: string, operationType: ToolOperationType): MutableToolMetric {
  return {
    toolName,
    operationType,
    definitionTokens: new MutableHistogram(TOKEN_BUCKETS),
    calls: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    approvalRequired: 0,
    retained: 0,
    retentionFailures: 0,
    retentionAvailability: new Map(),
    retentionMs: new MutableHistogram(DURATION_BUCKETS),
    continuationsOffered: 0,
    continuationsCompleted: 0,
    continuationReadFailures: 0,
    continuationExpired: 0,
    continuationChars: 0,
    inputTokens: new MutableHistogram(TOKEN_BUCKETS),
    rawBodyTokens: new MutableHistogram(TOKEN_BUCKETS),
    rawEnvelopeTokens: new MutableHistogram(TOKEN_BUCKETS),
    finalEnvelopeTokens: new MutableHistogram(TOKEN_BUCKETS),
    queueWaitMs: new MutableHistogram(DURATION_BUCKETS),
    executionMs: new MutableHistogram(DURATION_BUCKETS),
    continuationPages: new MutableHistogram(COUNT_BUCKETS),
    outputChars: 0,
    outputBytes: 0,
    maxActive: 0,
    queuedCancelled: 0,
    retentionReasons: new Map(),
  };
}

function snapshotTool(tool: MutableToolMetric): OrdinaryToolMetricSnapshot {
  return {
    toolName: tool.toolName,
    operationType: tool.operationType,
    ...(tool.definitionHash === undefined ? {} : { definitionHash: tool.definitionHash }),
    definitionTokens: tool.definitionTokens.snapshot(),
    calls: tool.calls,
    completed: tool.completed,
    failed: tool.failed,
    cancelled: tool.cancelled,
    approvalRequired: tool.approvalRequired,
    retained: tool.retained,
    retentionFailures: tool.retentionFailures,
    retentionAvailability: Object.fromEntries(tool.retentionAvailability),
    retentionMs: tool.retentionMs.snapshot(),
    continuationsOffered: tool.continuationsOffered,
    continuationsCompleted: tool.continuationsCompleted,
    continuationReadFailures: tool.continuationReadFailures,
    continuationExpired: tool.continuationExpired,
    continuationChars: tool.continuationChars,
    inputTokens: tool.inputTokens.snapshot(),
    rawBodyTokens: tool.rawBodyTokens.snapshot(),
    rawEnvelopeTokens: tool.rawEnvelopeTokens.snapshot(),
    finalEnvelopeTokens: tool.finalEnvelopeTokens.snapshot(),
    queueWaitMs: tool.queueWaitMs.snapshot(),
    executionMs: tool.executionMs.snapshot(),
    continuationPages: tool.continuationPages.snapshot(),
    outputChars: tool.outputChars,
    outputBytes: tool.outputBytes,
    maxActive: tool.maxActive,
    queuedCancelled: tool.queuedCancelled,
    retentionReasons: Object.fromEntries(tool.retentionReasons),
  };
}

function nonNegative(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) || value < 0 ? 0 : Math.floor(value);
}
