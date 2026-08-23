import React, { useRef, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  ChartColumn,
  CircleHelp,
  Cpu,
  Database,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import type {
  UsageStatistics,
  UsageStatisticsDailyActivity,
  UsageStatisticsLatencySummary,
  UsageStatisticsModelBreakdown,
  UsageStatisticsTotals,
  UsageStatisticsToolBreakdown,
} from "../contracts/statistics";
import { resolveModelIconSvgForModel } from "../model-icons";
import { usageStatisticsQuery } from "../usage-statistics-query";
import "./usage-statistics-settings.css";

export { preloadUsageStatistics } from "../usage-statistics-query";

type HeatmapMetric = "messages" | "runs" | "tokens";
type LatencyTone = "is-fast" | "is-warning" | "is-danger" | "is-neutral";

export function UsageStatisticsSettings(): React.ReactElement {
  const [view, setView] = useState<"overview" | "details">("overview");
  const query = useQuery(usageStatisticsQuery);

  return <UsageStatisticsQueryBoundary query={query}>{(activeQuery, statistics) => (
    <UsageStatisticsContent query={activeQuery} statistics={statistics} view={view} onViewChange={setView} />
  )}</UsageStatisticsQueryBoundary>;
}

export function DeveloperToolStatistics(): React.ReactElement {
  const query = useQuery(usageStatisticsQuery);

  return <UsageStatisticsQueryBoundary query={query}>{(activeQuery, statistics) => (
    <div className="usage-v3-page">
      <div className="usage-v3-toolbar">
        <button
          type="button"
          className="usage-v3-icon-button"
          aria-label={activeQuery.isFetching ? "刷新中" : "刷新使用统计"}
          onClick={() => void activeQuery.refetch()}
          disabled={activeQuery.isFetching}
        >
          <RefreshCw size={16} className={activeQuery.isFetching ? "is-spinning" : undefined} />
        </button>
      </div>
      <ToolsView tools={statistics.toolBreakdown ?? []} dropped={statistics.metricsDroppedCount ?? 0} />
    </div>
  )}</UsageStatisticsQueryBoundary>;
}

function UsageStatisticsQueryBoundary(props: {
  readonly query: UseQueryResult<UsageStatistics>;
  readonly children: (query: UseQueryResult<UsageStatistics>, statistics: UsageStatistics) => React.ReactElement;
}): React.ReactElement {
  const { query } = props;

  if (query.isPending) {
    return <UsageStatisticsLoading />;
  }

  if (query.isError && query.data === undefined) {
    return (
      <div className="usage-v3-page">
        <div className="usage-v3-error" role="alert">
          <div>
            <strong>使用统计暂时不可用</strong>
            <p>{query.error instanceof Error ? query.error.message : "使用统计读取失败。"}</p>
          </div>
          <button type="button" className="usage-v3-action" onClick={() => void query.refetch()}>
            <RefreshCw size={15} />
            <span>重试</span>
          </button>
        </div>
      </div>
    );
  }

  const statistics = query.data;
  if (statistics === undefined) {
    return <UsageStatisticsLoading />;
  }

  return props.children(query, statistics);
}

function UsageStatisticsContent(props: {
  readonly query: UseQueryResult<UsageStatistics>;
  readonly statistics: UsageStatistics;
  readonly view: "overview" | "details";
  readonly onViewChange: (view: "overview" | "details") => void;
}): React.ReactElement {
  const { query, statistics, view } = props;
  return (
    <div className="usage-v3-page">
      <div className="usage-v3-toolbar">
        <div className="usage-v3-toolbar-actions">
          <div className="usage-v3-tabs" role="tablist" aria-label="使用统计视图">
            <button
              type="button"
              role="tab"
              aria-selected={view === "overview"}
              className={view === "overview" ? "is-active" : ""}
              onClick={() => props.onViewChange("overview")}
            >
              概览
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "details"}
              className={view === "details" ? "is-active" : ""}
              onClick={() => props.onViewChange("details")}
            >
              模型详情
            </button>
          </div>
          <button
            type="button"
            className="usage-v3-icon-button"
            aria-label={query.isFetching ? "刷新中" : "刷新使用统计"}
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw size={16} className={query.isFetching ? "is-spinning" : undefined} />
          </button>
        </div>
      </div>

      {view === "overview" ? (
        <OverviewView statistics={statistics} />
      ) : (
        <DetailsView statistics={statistics} />
      )}
    </div>
  );
}

function OverviewView(props: { readonly statistics: UsageStatistics }): React.ReactElement {
  const [heatmapMetric, setHeatmapMetric] = useState<HeatmapMetric>("messages");
  const totals = props.statistics.totals;
  const days = projectHeatmapDays(heatmapDays(props.statistics.dailyActivity), heatmapMetric);
  return (
    <div className="usage-v3-overview">
      <div className="usage-v3-heatmap-layout">
        <section className="usage-v3-heatmap" aria-label="最近 182 天使用热力图">
          <div className="usage-v3-heatmap-chart">
            <UsageHeatmap days={days} />
          </div>
        </section>
        <HeatmapControlsCard metric={heatmapMetric} onMetricChange={setHeatmapMetric} />
      </div>

      <div className="usage-v3-card-grid" aria-label="使用统计汇总">
        <ActivityCard totals={totals} days={props.statistics.dailyActivity} />
        <RequestCard totals={totals} models={props.statistics.modelBreakdown} />
        <LatencyCard summary={totals.firstTokenLatency} />
        <TokenCard totals={totals} />
      </div>
    </div>
  );
}

function HeatmapControlsCard(props: {
  readonly metric: HeatmapMetric;
  readonly onMetricChange: (metric: HeatmapMetric) => void;
}): React.ReactElement {
  return (
    <section className="usage-v3-rhythm-card">
      <div className="usage-v3-card-heading">
        <span className="usage-v3-card-icon usage-v3-card-icon--quiet"><SlidersHorizontal size={18} /></span>
        <h4>热力视图</h4>
      </div>
      <span className="usage-v3-heatmap-control-label">着色依据</span>
      <div className="usage-v3-heatmap-modes" role="radiogroup" aria-label="热力图着色依据">
        {HEATMAP_METRICS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={props.metric === option.id}
            className={props.metric === option.id ? "is-active" : ""}
            onClick={() => props.onMetricChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="usage-v3-control-legend" aria-label="活跃度图例">
        <span>少</span>
        {[0, 1, 2, 3, 4, 5].map((level) => (
          <i key={level} className="usage-v3-heatmap-cell" data-level={level} aria-hidden="true" />
        ))}
        <span>多</span>
      </div>
    </section>
  );
}

const HEATMAP_METRICS: readonly { readonly id: HeatmapMetric; readonly label: string }[] = [
  { id: "messages", label: "消息" },
  { id: "runs", label: "运行" },
  { id: "tokens", label: "Token" },
];

function UsageHeatmap(props: { readonly days: readonly UsageStatisticsDailyActivity[] }): React.ReactElement {
  const visualRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<{ readonly day: UsageStatisticsDailyActivity; readonly left: number; readonly top: number; readonly placement: "above" | "below" }>();

  const showTooltip = (event: { readonly currentTarget: HTMLElement }, day: UsageStatisticsDailyActivity): void => {
    if (!hasDayActivity(day) || visualRef.current === null) return;
    const target = event.currentTarget.getBoundingClientRect();
    const visual = visualRef.current.getBoundingClientRect();
    const top = target.top - visual.top;
    const above = top > 58;
    setHovered({
      day,
      left: target.left - visual.left + target.width / 2,
      top: above ? top - 8 : target.bottom - visual.top + 8,
      placement: above ? "above" : "below",
    });
  };

  return (
    <div ref={visualRef} className="usage-v3-heatmap-visual" onMouseLeave={() => setHovered(undefined)}>
      <div className="usage-v3-heatmap-months" aria-hidden="true">
        {heatmapMonthLabels(props.days).map((month) => (
          <span key={`${month.label}-${month.left}`} style={{ left: `${month.left}%` }}>{month.label}</span>
        ))}
      </div>
      <div className="usage-v3-heatmap-grid" aria-label="每日使用量">
        {props.days.map((day) => (
          <i
            key={day.date}
            className="usage-v3-heatmap-cell"
            data-level={day.level}
            aria-label={`${day.date}，${day.messageCount} 条消息`}
            onMouseEnter={(event) => showTooltip(event, day)}
            onFocus={(event) => showTooltip(event, day)}
            onBlur={() => setHovered(undefined)}
            tabIndex={hasDayActivity(day) ? 0 : -1}
          />
        ))}
      </div>
      {hovered !== undefined && (
        <div className={`usage-v3-heatmap-tooltip ${hovered.placement}`} style={{ left: hovered.left, top: hovered.top }} role="status">
          <strong>{hovered.day.date}</strong>
          <span>消息 {formatCompactNumber(hovered.day.messageCount)} · 运行 {formatCompactNumber(hovered.day.runCount)}</span>
          <span>Token {formatCompactNumber(hovered.day.inputTokens + hovered.day.outputTokens)}</span>
        </div>
      )}
    </div>
  );
}

function ActivityCard(props: {
  readonly totals: UsageStatisticsTotals;
  readonly days: readonly UsageStatisticsDailyActivity[];
}): React.ReactElement {
  const trend = activityTrend(props.days);
  return (
    <section className="usage-v3-summary-card usage-v3-activity-card">
      <div className="usage-v3-card-heading">
        <span className="usage-v3-card-icon"><ChartColumn size={18} /></span>
        <h4>活动</h4>
        <span className="usage-v3-card-context">最近 14 天</span>
      </div>
      <div className="usage-v3-card-body-row">
        <div className="usage-v3-primary-metrics">
          <MetricPair label="对话" value={formatCompactNumber(props.totals.conversationCount)} />
          <MetricPair label="消息" value={formatCompactNumber(props.totals.messageCount)} />
        </div>
        <div className="usage-v3-mini-trend-wrap">
          <div className="usage-v3-mini-trend" aria-label="最近 14 天消息趋势">
            {trend.map((value, index) => (
              <i key={index} style={{ height: `${miniBarHeight(value, trend)}%` }} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function RequestCard(props: {
  readonly totals: UsageStatisticsTotals;
  readonly models: readonly UsageStatisticsModelBreakdown[];
}): React.ReactElement {
  const perRun = props.totals.runCount === 0 ? 0 : props.totals.requestCount / props.totals.runCount;
  const primaryModel = mostRequestedModel(props.models);
  const primaryShare = primaryModel === undefined || props.totals.requestCount === 0
    ? 0
    : Math.round((primaryModel.requestCount / props.totals.requestCount) * 100);
  const primaryModelIcon = primaryModel === undefined
    ? undefined
    : resolveModelIconSvgForModel({ modelId: primaryModel.model, displayName: primaryModel.model });
  return (
    <section className="usage-v3-summary-card usage-v3-request-card">
      <div className="usage-v3-card-heading">
        <span className="usage-v3-card-icon"><Cpu size={18} /></span>
        <h4>模型调用</h4>
        <strong className="usage-v3-card-total">{formatCompactNumber(props.totals.requestCount)}</strong>
      </div>
      <div className="usage-v3-request-breakdown">
        <MetricPair label="运行" value={formatCompactNumber(props.totals.runCount)} />
        <MetricPair label="平均 / 运行" value={formatDecimal(perRun)} />
      </div>
      {primaryModel !== undefined && (
        <div className="usage-v3-primary-model">
          <div className="usage-v3-primary-model-row">
            <span className="usage-v3-primary-model-identity">
              <span className="usage-v3-primary-model-icon" aria-hidden="true">
                {primaryModelIcon === undefined ? <Cpu size={13} /> : <span dangerouslySetInnerHTML={{ __html: primaryModelIcon }} />}
              </span>
              <span>{primaryModel.model}</span>
            </span>
            <strong>{primaryShare}%</strong>
          </div>
          <div className="usage-v3-primary-model-track" aria-label={`${primaryModel.model} 调用占比 ${primaryShare}%`}>
            <span style={{ width: `${primaryShare}%` }} />
          </div>
        </div>
      )}
    </section>
  );
}

function LatencyCard(props: {
  readonly summary: UsageStatisticsLatencySummary | undefined;
}): React.ReactElement {
  const primary = props.summary?.p95;
  const metrics = props.summary === undefined
    ? []
    : [
      { label: "P50", value: props.summary.p50 },
      { label: "P75", value: props.summary.p75 },
      { label: "P99", value: props.summary.p99 },
    ];
  return (
    <section className={`usage-v3-summary-card usage-v3-latency-card${props.summary === undefined ? " is-empty" : ""}`}>
      <div className="usage-v3-card-heading usage-v3-latency-heading">
        <h4>TTFT</h4>
        <span className="usage-v3-latency-help">
          <button type="button" aria-label="TTFT 说明">
            <CircleHelp size={16} />
          </button>
          <span role="tooltip">首 Token 延迟（Time To First Token），衡量流式响应的首 Token 返回速度。</span>
        </span>
        <span className="usage-v3-latency-percentile">P95</span>
      </div>
      <div className={`usage-v3-latency-primary ${latencyTone(primary)}`}>
        <strong>{formatDuration(primary)}</strong>
      </div>
      {metrics.length > 0 && (
        <div className="usage-v3-latency-metrics" aria-label="首 Token 延迟分布">
          {metrics.map((metric) => (
            <div key={metric.label} className={`usage-v3-latency-metric ${latencyTone(metric.value)}`}>
              <MetricPair label={metric.label} value={formatDuration(metric.value)} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function DetailsView(props: { readonly statistics: UsageStatistics }): React.ReactElement {
  return (
    <div className="usage-v3-details">
      {props.statistics.modelBreakdown.length === 0 ? (
        <div className="usage-v3-empty">暂无模型请求记录</div>
      ) : (
        <div className="usage-v3-model-providers">
          {groupModelsByProvider(props.statistics.modelBreakdown).map((group) => (
            <section key={group.providerId} className="usage-v3-model-provider" aria-labelledby={`usage-provider-${group.providerId}`}>
              <div className="usage-v3-model-provider-heading">
                <h5 id={`usage-provider-${group.providerId}`}>{group.providerLabel}</h5>
                <span>{formatCompactNumber(group.models.length)} 个模型</span>
              </div>
              <div className="usage-v3-model-list">
                {group.models.map((model) => (
                  <ModelUsageCard key={`${model.providerId}:${model.model}`} model={model} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolsView(props: { readonly tools: readonly UsageStatisticsToolBreakdown[]; readonly dropped: number }): React.ReactElement {
  return (
    <div className="usage-v3-details">
      <div className="usage-v3-details-intro">
        <div><h4>工具详情</h4><p>模型可见包络、保留和继续读取的聚合统计。</p></div>
        <div className="usage-v3-details-total"><div><span>指标丢弃</span><strong>{formatCompactNumber(props.dropped)}</strong></div></div>
      </div>
      {props.tools.length === 0 ? <div className="usage-v3-empty">暂无工具执行统计</div> : (
        <div className="usage-v3-model-table-wrap">
          <table className="usage-v3-model-table">
            <thead><tr><th>工具</th><th>调用</th><th>错误率</th><th>保留率</th><th>继续率</th><th>最终包络 P95</th><th>原始正文 P95</th><th>排队 P95</th><th>最大并发</th></tr></thead>
            <tbody>{props.tools.map((tool) => <ToolRow key={`${tool.toolName}:${tool.operationType}`} tool={tool} />)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ToolRow(props: { readonly tool: UsageStatisticsToolBreakdown }): React.ReactElement {
  return <tr>
    <td><strong>{props.tool.toolName}</strong><small>{props.tool.operationType}</small></td>
    <td>{formatCompactNumber(props.tool.calls)}</td>
    <td>{formatPercentage(props.tool.errorRate)}</td>
    <td>{formatPercentage(props.tool.retainedRate)}</td>
    <td>{formatPercentage(props.tool.continuationRate)}</td>
    <td>{formatTokenMetric(props.tool.finalEnvelopeTokens.p95)}</td>
    <td>{formatTokenMetric(props.tool.rawBodyTokens.p95)}</td>
    <td>{formatDuration(props.tool.queueWaitMs.p95)}</td>
    <td>{formatCompactNumber(props.tool.maxActive)}</td>
  </tr>;
}

function ModelUsageCard(props: { readonly model: UsageStatisticsModelBreakdown }): React.ReactElement {
  const model = props.model;
  const iconSvg = resolveModelIconSvgForModel({ modelId: model.model, displayName: model.model });
  return (
    <article className="usage-v3-model-card" aria-label={`${model.model} 模型用量`}>
      <header className="usage-v3-model-card-heading">
        <span className="usage-v3-model-identity">
          <span className="usage-v3-model-icon" aria-hidden="true">
            {iconSvg === undefined ? <Cpu size={16} /> : <span dangerouslySetInnerHTML={{ __html: iconSvg }} />}
          </span>
          <strong>{model.model}</strong>
        </span>
        <span className="usage-v3-model-token-total">
          <strong>{formatCompactNumber(model.totalTokens)}</strong>
          <span>Token</span>
        </span>
      </header>
      <div className="usage-v3-model-highlights">
        <MetricPair label="调用" value={formatCompactNumber(model.requestCount)} />
        <MetricPair label="首 Token" value={formatDuration(model.averageFirstTokenLatencyMs)} />
        <MetricPair label="缓存命中" value={formatPercentage(model.cacheHitRate)} />
      </div>
      <div className="usage-v3-model-token-breakdown" aria-label="Token 构成">
        <span>输入 <strong>{formatCompactNumber(model.inputTokens)}</strong></span>
        <span>输出 <strong>{formatCompactNumber(model.outputTokens)}</strong></span>
        <span>缓存 <strong>{formatCompactNumber(model.cacheSavedTokens)}</strong></span>
      </div>
    </article>
  );
}

function TokenCard(props: { readonly totals: UsageStatisticsTotals }): React.ReactElement {
  const totals = props.totals;
  return (
    <section className="usage-v3-summary-card usage-v3-token-card">
      <div className="usage-v3-card-heading">
        <span className="usage-v3-card-icon usage-v3-card-icon--mint"><Database size={18} /></span>
        <div>
          <h4>Token 用量</h4>
        </div>
        <strong className="usage-v3-token-total">{formatCompactNumber(totals.totalTokens)}</strong>
      </div>
      <div className="usage-v3-token-breakdown">
        <MetricPair label="输入 Token" value={formatCompactNumber(totals.inputTokens)} />
        <MetricPair label="输出 Token" value={formatCompactNumber(totals.outputTokens)} />
        <MetricPair label="缓存命中 Token" value={formatCompactNumber(totals.cacheSavedTokens)} />
      </div>
      <div className="usage-v3-cache-meter">
        <div className="usage-v3-cache-label">
          <span>缓存命中率</span>
          <strong>{formatPercentage(totals.cacheHitRate)}</strong>
        </div>
        <div className="usage-v3-progress usage-v3-progress--animated" aria-label={`缓存命中率 ${formatPercentage(totals.cacheHitRate)}`}>
          <span style={{ width: `${percentageValue(totals.cacheHitRate)}%` }} />
        </div>
      </div>
    </section>
  );
}

function groupModelsByProvider(models: readonly UsageStatisticsModelBreakdown[]): readonly {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly models: readonly UsageStatisticsModelBreakdown[];
}[] {
  const groups = new Map<string, { providerLabel: string; models: UsageStatisticsModelBreakdown[] }>();
  for (const model of models) {
    const group = groups.get(model.providerId);
    if (group === undefined) {
      groups.set(model.providerId, { providerLabel: model.providerLabel, models: [model] });
    } else {
      group.models.push(model);
    }
  }
  return [...groups].map(([providerId, group]) => ({ providerId, ...group }));
}

function mostRequestedModel(models: readonly UsageStatisticsModelBreakdown[]): UsageStatisticsModelBreakdown | undefined {
  return models.reduce<UsageStatisticsModelBreakdown | undefined>((selected, model) => (
    selected === undefined || model.requestCount > selected.requestCount ? model : selected
  ), undefined);
}

function MetricPair(props: { readonly label: string; readonly value: string }): React.ReactElement {
  return <div className="usage-v3-metric-pair"><strong>{props.value}</strong><span>{props.label}</span></div>;
}

function activityTrend(days: readonly UsageStatisticsDailyActivity[]): readonly number[] {
  const recent = days.slice(-14).map((day) => day.messageCount);
  return [...Array.from({ length: Math.max(0, 14 - recent.length) }, () => 0), ...recent];
}

function hasDayActivity(day: UsageStatisticsDailyActivity): boolean {
  return day.messageCount > 0 || day.runCount > 0 || day.inputTokens > 0 || day.outputTokens > 0 || day.cacheSavedTokens > 0;
}

function miniBarHeight(value: number, values: readonly number[]): number {
  const maximum = Math.max(1, ...values);
  return value === 0 ? 8 : Math.max(18, Math.round((value / maximum) * 100));
}

function latencyTone(value: number | undefined): LatencyTone {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "is-neutral";
  if (value < 3_000) return "is-fast";
  if (value <= 10_000) return "is-warning";
  return "is-danger";
}

function formatDecimal(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return value.toFixed(1).replace(/\.0$/u, "");
}

function UsageStatisticsLoading(): React.ReactElement {
  return (
    <div className="usage-v3-page" aria-busy="true">
      <div className="usage-v3-toolbar usage-v3-skeleton-toolbar" />
      <div className="usage-v3-heatmap-layout">
        <div className="usage-v3-skeleton usage-v3-skeleton-heatmap" />
        <div className="usage-v3-skeleton usage-v3-skeleton-rhythm" />
      </div>
      <div className="usage-v3-card-grid">
        {Array.from({ length: 4 }, (_, index) => <div key={index} className="usage-v3-skeleton usage-v3-skeleton-card" />)}
      </div>
    </div>
  );
}

function heatmapDays(days: readonly UsageStatisticsDailyActivity[]): readonly UsageStatisticsDailyActivity[] {
  if (days.length > 0) return days;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: 182 }, (_, index) => ({
    date: localDateKey(new Date(today.getTime() - (181 - index) * 86_400_000)),
    messageCount: 0,
    conversationCount: 0,
    runCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheSavedTokens: 0,
    level: 0 as const,
  }));
}

function projectHeatmapDays(
  days: readonly UsageStatisticsDailyActivity[],
  metric: HeatmapMetric,
): readonly UsageStatisticsDailyActivity[] {
  const values = days.map((day) => heatmapMetricValue(day, metric));
  const positiveValues = values.filter((value) => value > 0).sort((left, right) => left - right);
  return days.map((day, index) => ({
    ...day,
    level: heatmapLevel(values[index] ?? 0, positiveValues),
  }));
}

function heatmapMetricValue(day: UsageStatisticsDailyActivity, metric: HeatmapMetric): number {
  if (metric === "runs") return day.runCount;
  if (metric === "tokens") return day.inputTokens + day.outputTokens;
  return day.messageCount;
}

function heatmapLevel(value: number, positiveValues: readonly number[]): 0 | 1 | 2 | 3 | 4 | 5 {
  if (value <= 0 || positiveValues.length === 0) return 0;
  let rank = 0;
  for (const candidate of positiveValues) {
    if (candidate > value) break;
    rank += 1;
  }
  return Math.min(5, Math.max(1, Math.ceil((rank / positiveValues.length) * 5))) as 1 | 2 | 3 | 4 | 5;
}

function heatmapMonthLabels(days: readonly UsageStatisticsDailyActivity[]): readonly {
  readonly label: string;
  readonly left: number;
}[] {
  const labels: { label: string; left: number }[] = [];
  let previousMonth = "";
  for (const [index, day] of days.entries()) {
    const date = new Date(`${day.date}T00:00:00`);
    if (Number.isNaN(date.getTime())) continue;
    const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
    if (monthKey === previousMonth) continue;
    previousMonth = monthKey;
    labels.push({ label: `${date.getMonth() + 1}月`, left: days.length <= 1 ? 0 : (index / (days.length - 1)) * 100 });
  }
  return labels;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${trimCompact(value / 1_000_000, value < 10_000_000 ? 2 : 1)}M`;
  if (value >= 1_000) return `${trimCompact(value / 1_000, value < 100_000 ? 1 : 0)}K`;
  return String(Math.floor(value));
}

function trimCompact(value: number, fractionDigits: number): string {
  return value.toFixed(fractionDigits).replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1");
}

function formatPercentage(value: number): string {
  return `${percentageValue(value)}%`;
}

function percentageValue(value: number): number {
  return Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) * 100);
}

function formatDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2).replace(/\.0+$/u, "")} s`;
}

function formatTokenMetric(value: number | undefined): string {
  return value === undefined ? "—" : `${formatCompactNumber(value)} tok`;
}