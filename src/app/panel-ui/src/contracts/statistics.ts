export type UsageStatisticsResponse = {
  readonly ok: true;
  readonly status: "completed";
  readonly statistics: UsageStatistics;
};

export type UsageStatistics = {
  readonly generatedAt: string;
  readonly storageAvailable: boolean;
  readonly scope: "all_local";
  readonly heatmapWindowDays: 182;
  readonly firstActivityDate?: string;
  readonly lastActivityDate?: string;
  readonly totals: UsageStatisticsTotals;
  readonly modelBreakdown: readonly UsageStatisticsModelBreakdown[];
  readonly toolBreakdown?: readonly UsageStatisticsToolBreakdown[];
  readonly metricsDroppedCount?: number;
  readonly dailyActivity: readonly UsageStatisticsDailyActivity[];
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

export type UsageStatisticsLatencySummary = {
  readonly p50: number;
  readonly p75: number;
  readonly p95: number;
  readonly p99: number;
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

export type UsageStatisticsPercentiles = {
  readonly p50?: number;
  readonly p95?: number;
  readonly p99?: number;
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