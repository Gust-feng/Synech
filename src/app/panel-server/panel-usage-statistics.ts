import type { ModelUsage } from "../../domain/intelligence/index.js";
import type {
  OrdinaryAgentFeature,
  OrdinaryConversationReadModel,
  OrdinaryRunState,
} from "../ordinary-agent/index.js";
import type { ToolMetricHistogramSnapshot } from "../ordinary-agent/tool-runtime-metrics.js";

export const USAGE_HEATMAP_WINDOW_DAYS = 182;
const ALL_LOCAL_RECORD_LIMIT = Number.MAX_SAFE_INTEGER;
const DAY_MS = 24 * 60 * 60 * 1_000;

export type UsageStatisticsResponse = {
  readonly ok: true;
  readonly status: "completed";
  readonly statistics: UsageStatistics;
};

export type UsageStatistics = {
  readonly generatedAt: string;
  readonly storageAvailable: boolean;
  readonly scope: "all_local";
  readonly heatmapWindowDays: typeof USAGE_HEATMAP_WINDOW_DAYS;
  readonly firstActivityDate?: string;
  readonly lastActivityDate?: string;
  readonly totals: UsageStatisticsTotals;
  readonly modelBreakdown: readonly UsageStatisticsModelBreakdown[];
  readonly toolBreakdown?: readonly UsageStatisticsToolBreakdown[];
  readonly metricsDroppedCount?: number;
  readonly dailyActivity: readonly UsageStatisticsDailyActivity[];
};

export type UsageStatisticsPercentiles = {
  readonly p50?: number;
  readonly p95?: number;
  readonly p99?: number;
};

export type UsageStatisticsLatencySummary = {
  readonly p50: number;
  readonly p75: number;
  readonly p95: number;
  readonly p99: number;
};

export type UsageStatisticsToolBreakdown = {
  readonly toolName: string;
  readonly operationType: string;
  readonly calls: number;
  readonly errorRate: number;
  readonly retainedRate: number;
  readonly continuationRate: number;
  readonly rawBodyTokens: UsageStatisticsPercentiles;
  readonly rawEnvelopeTokens: UsageStatisticsPercentiles;
  readonly finalEnvelopeTokens: UsageStatisticsPercentiles;
  readonly continuationPages: UsageStatisticsPercentiles;
  readonly queueWaitMs: UsageStatisticsPercentiles;
  readonly outputChars: number;
  readonly outputBytes: number;
  readonly maxActive: number;
  readonly retentionReasons: Readonly<Record<string, number>>;
};

export type UsageStatisticsTotals = {
  readonly conversationCount: number;
  readonly messageCount: number;
  readonly runCount: number;
  readonly requestCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheSavedTokens: number;
  readonly cacheHitRate: number;
  readonly firstTokenLatency?: UsageStatisticsLatencySummary;
};

export type UsageStatisticsModelBreakdown = {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly model: string;
  readonly requestCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheSavedTokens: number;
  readonly cacheHitRate: number;
  readonly averageFirstTokenLatencyMs?: number;
};

export type UsageStatisticsDailyActivity = {
  readonly date: string;
  readonly messageCount: number;
  readonly conversationCount: number;
  readonly runCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheSavedTokens: number;
  readonly level: 0 | 1 | 2 | 3 | 4 | 5;
};

export async function createPanelUsageStatistics(input: {
  readonly ordinaryAgentFeature: OrdinaryAgentFeature;
  readonly generatedAt?: string;
}): Promise<UsageStatisticsResponse> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const [conversations, summaries] = await Promise.all([
    input.ordinaryAgentFeature.queries.listConversations(ALL_LOCAL_RECORD_LIMIT),
    input.ordinaryAgentFeature.queries.listRuns(ALL_LOCAL_RECORD_LIMIT),
  ]);
  const runs = (await Promise.all(summaries.map((summary) =>
    input.ordinaryAgentFeature.queries.getRun(summary.runId))))
    .filter((run): run is OrdinaryRunState => run !== undefined);
  return {
    ok: true,
    status: "completed",
    statistics: createOrdinaryUsageStatistics({ generatedAt, conversations, runs }),
  };
}

function createOrdinaryUsageStatistics(input: {
  readonly generatedAt: string;
  readonly conversations: readonly OrdinaryConversationReadModel[];
  readonly runs: readonly OrdinaryRunState[];
}): UsageStatistics {
  const daily = createDailyBuckets(input.generatedAt);
  const activityDates: string[] = [];
  const modelBreakdown = new Map<string, MutableUsageStatisticsModelBreakdown>();
  const totals: MutableUsageStatisticsTotals = {
    conversationCount: input.conversations.length,
    messageCount: 0,
    runCount: input.runs.length,
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheSavedTokens: 0,
    cacheHitRate: 0,
  };
  const firstTokenLatency = new LatencyAccumulator();
  const toolBreakdown = new Map<string, MutableUsageStatisticsToolBreakdown>();
  let metricsDroppedCount = 0;
  for (const conversation of input.conversations) {
    addActivityDate(activityDates, conversation.createdAt);
    addActivityDate(activityDates, conversation.updatedAt);
    addDailyCount(daily, conversation.createdAt, "conversationCount", 1);
    totals.messageCount += conversation.turns.length;
    for (const turn of conversation.turns) {
      addActivityDate(activityDates, turn.createdAt);
      addActivityDate(activityDates, turn.updatedAt);
      addDailyCount(daily, turn.createdAt, "messageCount", 1);
    }
  }

  for (const run of input.runs) {
    addActivityDate(activityDates, run.timestamps.createdAt);
    addActivityDate(activityDates, run.timestamps.updatedAt);
    addDailyCount(daily, run.timestamps.createdAt, "runCount", 1);
    if (run.toolMetrics !== undefined) {
      metricsDroppedCount += run.toolMetrics.metricsDroppedCount;
      mergeToolMetrics(toolBreakdown, run.toolMetrics);
    }
    const usage = normalizedUsage(run.usage);
    if (usage === undefined) continue;
    const model = modelBreakdownForRun(modelBreakdown, run);
    totals.requestCount += usage.requestCount;
    model.requestCount += usage.requestCount;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.totalTokens += usage.totalTokens;
    totals.cacheSavedTokens += usage.cacheSavedTokens;
    addUsageToModelBreakdown(model, usage);
    if (usage.firstTokenLatencyMs !== undefined) firstTokenLatency.add(usage.firstTokenLatencyMs);
    const usageAt = run.timestamps.terminalAt ?? run.timestamps.updatedAt;
    addDailyCount(daily, usageAt, "inputTokens", usage.inputTokens);
    addDailyCount(daily, usageAt, "outputTokens", usage.outputTokens);
    addDailyCount(daily, usageAt, "cacheSavedTokens", usage.cacheSavedTokens);
  }

  totals.cacheHitRate = cacheHitRate(totals.cacheSavedTokens, totals.inputTokens);
  const firstTokenLatencySummary = firstTokenLatency.summary();

  return {
    generatedAt: input.generatedAt,
    storageAvailable: true,
    scope: "all_local",
    heatmapWindowDays: USAGE_HEATMAP_WINDOW_DAYS,
    firstActivityDate: minDate(activityDates),
    lastActivityDate: maxDate(activityDates),
    totals: {
      ...totals,
      ...(firstTokenLatencySummary === undefined ? {} : {
        firstTokenLatency: firstTokenLatencySummary,
      }),
    },
    modelBreakdown: finalizeModelBreakdown(modelBreakdown),
    toolBreakdown: finalizeToolBreakdown(toolBreakdown),
    metricsDroppedCount,
    dailyActivity: finalizeDailyActivity(daily),
  };
}

type MutableUsageStatisticsToolBreakdown = {
  readonly toolName: string;
  readonly operationType: string;
  calls: number;
  failed: number;
  retained: number;
  continuations: number;
  readonly rawBodyTokens: HistogramAccumulator;
  readonly rawEnvelopeTokens: HistogramAccumulator;
  readonly finalEnvelopeTokens: HistogramAccumulator;
  readonly continuationPages: HistogramAccumulator;
  readonly queueWaitMs: HistogramAccumulator;
  outputChars: number;
  outputBytes: number;
  maxActive: number;
  readonly retentionReasons: Map<string, number>;
};

function mergeToolMetrics(
  target: Map<string, MutableUsageStatisticsToolBreakdown>,
  snapshot: import("../ordinary-agent/tool-runtime-metrics.js").OrdinaryToolMetricsSnapshot,
): void {
  for (const tool of snapshot.tools) {
    const key = `${tool.toolName}\u0000${tool.operationType}`;
    const existing = target.get(key) ?? {
      toolName: tool.toolName,
      operationType: tool.operationType,
      calls: 0,
      failed: 0,
      retained: 0,
      continuations: 0,
      rawBodyTokens: new HistogramAccumulator(),
      rawEnvelopeTokens: new HistogramAccumulator(),
      finalEnvelopeTokens: new HistogramAccumulator(),
      continuationPages: new HistogramAccumulator(),
      queueWaitMs: new HistogramAccumulator(),
      outputChars: 0,
      outputBytes: 0,
      maxActive: 0,
      retentionReasons: new Map(),
    };
    existing.calls += tool.calls;
    existing.failed += tool.failed;
    existing.retained += tool.retained;
    existing.continuations += tool.continuationsOffered;
    existing.rawBodyTokens.merge(tool.rawBodyTokens);
    existing.rawEnvelopeTokens.merge(tool.rawEnvelopeTokens);
    existing.finalEnvelopeTokens.merge(tool.finalEnvelopeTokens);
    existing.continuationPages.merge(tool.continuationPages);
    existing.queueWaitMs.merge(tool.queueWaitMs);
    existing.outputChars += tool.outputChars;
    existing.outputBytes += tool.outputBytes;
    existing.maxActive = Math.max(existing.maxActive, tool.maxActive);
    for (const [reason, count] of Object.entries(tool.retentionReasons)) {
      existing.retentionReasons.set(reason, (existing.retentionReasons.get(reason) ?? 0) + count);
    }
    target.set(key, existing);
  }
}

function finalizeToolBreakdown(
  values: Map<string, MutableUsageStatisticsToolBreakdown>,
): readonly UsageStatisticsToolBreakdown[] {
  return [...values.values()].map((tool) => ({
    toolName: tool.toolName,
    operationType: tool.operationType,
    calls: tool.calls,
    errorRate: ratio(tool.failed, tool.calls),
    retainedRate: ratio(tool.retained, tool.calls),
    continuationRate: ratio(tool.continuations, tool.calls),
    rawBodyTokens: tool.rawBodyTokens.percentiles(),
    rawEnvelopeTokens: tool.rawEnvelopeTokens.percentiles(),
    finalEnvelopeTokens: tool.finalEnvelopeTokens.percentiles(),
    continuationPages: tool.continuationPages.percentiles(),
    queueWaitMs: tool.queueWaitMs.percentiles(),
    outputChars: tool.outputChars,
    outputBytes: tool.outputBytes,
    maxActive: tool.maxActive,
    retentionReasons: Object.fromEntries(tool.retentionReasons),
  })).sort((left, right) => (right.finalEnvelopeTokens.p95 ?? 0) - (left.finalEnvelopeTokens.p95 ?? 0));
}

class HistogramAccumulator {
  private bounds: number[] = [];
  private counts: number[] = [];
  private count = 0;
  private sum = 0;
  private max = 0;

  merge(snapshot: ToolMetricHistogramSnapshot): void {
    if (this.bounds.length === 0) {
      this.bounds = [...snapshot.bounds];
      this.counts = Array.from({ length: this.bounds.length + 1 }, () => 0);
    }
    snapshot.counts.forEach((value, index) => { this.counts[index] = (this.counts[index] ?? 0) + value; });
    this.count += snapshot.count;
    this.sum += snapshot.sum;
    this.max = Math.max(this.max, snapshot.max);
  }

  percentiles(): UsageStatisticsPercentiles {
    if (this.count === 0) return {};
    return {
      p50: this.quantile(0.5),
      p95: this.quantile(0.95),
      p99: this.quantile(0.99),
    };
  }

  private quantile(ratioValue: number): number {
    const target = Math.max(1, Math.ceil(this.count * ratioValue));
    let seen = 0;
    for (let index = 0; index < this.counts.length; index += 1) {
      seen += this.counts[index] ?? 0;
      if (seen >= target) return this.bounds[index] ?? this.max;
    }
    return this.max;
  }
}

class LatencyAccumulator {
  private readonly values: number[] = [];

  add(value: number): void {
    this.values.push(value);
  }

  summary(): UsageStatisticsLatencySummary | undefined {
    if (this.values.length === 0) return undefined;
    const sorted = [...this.values].sort((left, right) => left - right);
    return {
      p50: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75),
      p95: quantile(sorted, 0.95),
      p99: quantile(sorted, 0.99),
    };
  }
}

function quantile(sorted: readonly number[], ratioValue: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratioValue) - 1)]!;
}

function ratio(value: number, total: number): number {
  return total <= 0 ? 0 : Number((value / total).toFixed(4));
}

type MutableUsageStatisticsTotals = {
  -readonly [K in keyof UsageStatisticsTotals]: UsageStatisticsTotals[K];
};

type MutableDailyActivity = Omit<UsageStatisticsDailyActivity, "level"> & {
  level?: UsageStatisticsDailyActivity["level"];
};

type MutableUsageStatisticsModelBreakdown = {
  -readonly [K in keyof Omit<
    UsageStatisticsModelBreakdown,
    "cacheHitRate" | "averageFirstTokenLatencyMs"
  >]: UsageStatisticsModelBreakdown[K];
} & {
  firstTokenLatencyTotalMs: number;
  firstTokenLatencySampleCount: number;
};

function normalizedUsage(usage: ModelUsage | undefined): {
  readonly requestCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheSavedTokens: number;
  readonly firstTokenLatencyMs?: number;
} | undefined {
  if (usage === undefined) {
    return undefined;
  }
  const inputTokens = nonNegativeAmount(usage.inputTokens);
  const outputTokens = nonNegativeAmount(usage.outputTokens);
  const totalTokens = usage.totalTokens === undefined
    ? inputTokens + outputTokens
    : nonNegativeAmount(usage.totalTokens);
  const cacheSavedTokens = nonNegativeAmount(usage.cachedInputTokens);
  const usageEvidence = inputTokens + outputTokens + totalTokens + cacheSavedTokens +
    nonNegativeAmount(usage.uncachedInputTokens);
  const requestCount = usage.requestCount === undefined
    ? (usageEvidence > 0 ? 1 : 0)
    : nonNegativeInteger(usage.requestCount);
  if (usageEvidence === 0 && requestCount === 0) {
    return undefined;
  }
  return {
    requestCount,
    inputTokens,
    outputTokens,
    totalTokens,
    cacheSavedTokens,
    firstTokenLatencyMs: nonNegativeOptionalAmount(usage.firstTokenLatencyMs),
  };
}

function modelBreakdownForRun(
  breakdown: Map<string, MutableUsageStatisticsModelBreakdown>,
  run: OrdinaryRunState,
): MutableUsageStatisticsModelBreakdown {
  const providerId = run.birth?.config.profileId ?? "unknown-provider";
  const providerLabel = run.birth?.config.label?.trim() || providerId;
  const model = run.birth?.config.model?.trim() || "默认模型";
  const key = `${providerId}\u0000${model}`;
  const existing = breakdown.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created: MutableUsageStatisticsModelBreakdown = {
    providerId,
    providerLabel,
    model,
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheSavedTokens: 0,
    firstTokenLatencyTotalMs: 0,
    firstTokenLatencySampleCount: 0,
  };
  breakdown.set(key, created);
  return created;
}

function addUsageToModelBreakdown(
  target: MutableUsageStatisticsModelBreakdown,
  usage: NonNullable<ReturnType<typeof normalizedUsage>>,
): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.totalTokens += usage.totalTokens;
  target.cacheSavedTokens += usage.cacheSavedTokens;
  if (usage.firstTokenLatencyMs !== undefined) {
    target.firstTokenLatencyTotalMs += usage.firstTokenLatencyMs;
    target.firstTokenLatencySampleCount += 1;
  }
}

function finalizeModelBreakdown(
  breakdown: ReadonlyMap<string, MutableUsageStatisticsModelBreakdown>,
): readonly UsageStatisticsModelBreakdown[] {
  return [...breakdown.values()]
    .map((item) => {
      const averageFirstTokenLatencyMs = averageDuration(
        item.firstTokenLatencyTotalMs,
        item.firstTokenLatencySampleCount,
      );
      return {
        providerId: item.providerId,
        providerLabel: item.providerLabel,
        model: item.model,
        requestCount: item.requestCount,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
        totalTokens: item.totalTokens,
        cacheSavedTokens: item.cacheSavedTokens,
        cacheHitRate: cacheHitRate(item.cacheSavedTokens, item.inputTokens),
        ...(averageFirstTokenLatencyMs === undefined ? {} : { averageFirstTokenLatencyMs }),
      };
    })
    .sort((left, right) =>
      right.totalTokens - left.totalTokens ||
      left.providerLabel.localeCompare(right.providerLabel) ||
      left.model.localeCompare(right.model));
}

function cacheHitRate(cachedInputTokens: number, inputTokens: number): number {
  return inputTokens <= 0 ? 0 : Math.min(1, cachedInputTokens / inputTokens);
}

function averageDuration(totalMs: number, sampleCount: number): number | undefined {
  return sampleCount <= 0 ? undefined : totalMs / sampleCount;
}

function createDailyBuckets(generatedAt: string): Map<string, MutableDailyActivity> {
  const buckets = new Map<string, MutableDailyActivity>();
  const end = parseIsoDay(generatedAt) ?? parseIsoDay(new Date().toISOString())!;
  const start = new Date(end.getTime() - (USAGE_HEATMAP_WINDOW_DAYS - 1) * DAY_MS);
  for (let index = 0; index < USAGE_HEATMAP_WINDOW_DAYS; index += 1) {
    const date = isoDay(new Date(start.getTime() + index * DAY_MS));
    buckets.set(date, {
      date,
      messageCount: 0,
      conversationCount: 0,
      runCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheSavedTokens: 0,
    });
  }
  return buckets;
}

function addDailyCount<K extends keyof Omit<UsageStatisticsDailyActivity, "date" | "level">>(
  daily: Map<string, MutableDailyActivity>,
  timestamp: string | undefined,
  key: K,
  amount: number
): void {
  const day = dayString(timestamp);
  if (day === undefined || amount <= 0) {
    return;
  }
  const bucket = daily.get(day);
  if (bucket === undefined) {
    return;
  }
  bucket[key] += amount;
}

function finalizeDailyActivity(daily: Map<string, MutableDailyActivity>): readonly UsageStatisticsDailyActivity[] {
  const items = [...daily.values()];
  const maxMessages = Math.max(0, ...items.map((item) => item.messageCount));
  return items.map((item) => ({
    ...item,
    level: activityLevel(item.messageCount, maxMessages),
  }));
}

function activityLevel(value: number, maxValue: number): UsageStatisticsDailyActivity["level"] {
  if (value <= 0 || maxValue <= 0) {
    return 0;
  }
  return Math.max(1, Math.min(5, Math.ceil((value / maxValue) * 5))) as UsageStatisticsDailyActivity["level"];
}

function addActivityDate(dates: string[], timestamp: string | undefined): void {
  const date = dayString(timestamp);
  if (date !== undefined) {
    dates.push(date);
  }
}

function minDate(values: readonly string[]): string | undefined {
  return values.length === 0 ? undefined : [...values].sort()[0];
}

function maxDate(values: readonly string[]): string | undefined {
  return values.length === 0 ? undefined : [...values].sort().at(-1);
}

function dayString(timestamp: string | undefined): string | undefined {
  if (timestamp === undefined) {
    return undefined;
  }
  return parseIsoDay(timestamp) === undefined ? undefined : timestamp.slice(0, 10);
}

function parseIsoDay(timestamp: string): Date | undefined {
  const day = timestamp.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) {
    return undefined;
  }
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function nonNegativeAmount(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) || value < 0 ? 0 : value;
}

function nonNegativeOptionalAmount(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) || value < 0 ? undefined : value;
}

function nonNegativeInteger(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) || value < 0 ? 0 : Math.floor(value);
}
