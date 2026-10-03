/**
 * Current Memory facade contracts; ADR 0019 Accepted target entry contracts are
 * exported from entry-contracts.ts. Whole-document signatures below remain the
 * current implementation surface until workers integrate the target in one slice.
 * Memory owns published recognition and derived supply, never original Ordinary
 * conversations or owner identity. Background remains advisory data.
 */

import type { MemoryOwner } from "../../domain/memory/index.js";
import type { MemoryEntryAdminPort, MemoryEntryQueryPort, MemorySourceLifecyclePort, MemoryOverviewSourceState } from "./entry-contracts.js";
import type { ConversationOwner } from "../../domain/execution-scope/contracts.js";

// ---------------------------------------------------------------------------
// 政策与控制状态（沿用 Memory v2 分账）
// ---------------------------------------------------------------------------

/** 实验参与模式：只决定 Capture/Inject 是否参与，不是健康状态。 */
export type MemoryRolloutMode = "off" | "shadow" | "active";

/** 运行健康投影：只在运行时派生，禁止回写成用户策略。 */
export type MemoryRuntimeHealth = "ready" | "degraded" | "unavailable";

/** 政策/配置修订标识；任一权威事实变化都 bump 对应 revision 使旧结果失效。 */
export type PolicyRevision = string;

/**
 * 一次边界计算得到的有效准入结论。四个边界（信号接单 / 整理提交 / 背景供给 /
 * 注入冻结）必须各自重新计算，不得复用陈旧结果。
 */
export type EffectiveMemoryAdmission = {
  readonly effective: "off" | "shadow" | "active";
  readonly policyRevision: PolicyRevision;
  readonly rolloutRevision: string;
  readonly generation: number;
  /** 结构原因码（memory_disabled / rollout_off / generation_fence）。 */
  readonly reasons: readonly string[];
};

// ---------------------------------------------------------------------------
// Capture 信号与证据（沿用；Ordinary 窄口不变）
// ---------------------------------------------------------------------------

export type MemoryCaptureSignal = {
  readonly owner: ConversationOwner;
  readonly conversationId: string;
  readonly stableThrough: {
    readonly turnId: string;
    readonly ordinal: number;
    readonly sourceRevision: number;
  };
};

/** EvidenceReader 返回的单个稳定 Turn；ordinal 权威值来自 run 层 OrdinaryRunTurn.ordinal。 */
export type EvidenceTurn = {
  readonly turnId: string;
  readonly ordinal: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly runId: string;
  readonly occurredAt: string;
  readonly sourceRevision: number;
};

export type EvidenceWindow = {
  readonly turns: readonly EvidenceTurn[];
  /** 连续证据块的末端；无连续证据时为 undefined。 */
  readonly nextCursor: {
    readonly conversationId: string;
    readonly coveredThroughOrdinal: number;
    readonly sourceFingerprint: string;
  } | undefined;
};

/**
 * 窄证据读取口：契约在 Memory 侧，实现/适配由 Ordinary 只读 queries 与
 * panel-server 装配承担；Memory Feature 永不直接 import Ordinary Repository。
 */
export interface OrdinaryEvidenceReader {
  readTurnWindow(input: {
    conversationId: string;
    fromOrdinal: number;
    through: MemoryCaptureSignal["stableThrough"];
  }): Promise<EvidenceWindow>;
}

export type MemoryCaptureAcceptance =
  | { readonly status: "accepted"; readonly conversationId: string; readonly eligibleAt: number }
  | { readonly status: "skipped"; readonly reason: string };

/**
 * Capture 运行时（可缺席）。accepted 表示 eligibleAt 之前不整理；本层同时维护
 * 已授权 transcript 索引投影的增量覆盖；关闭/清除排除区间不会回填，
 * 索引与任务发布均在仓储事务内复核准入和世代。
 */
export interface MemoryCaptureRuntime {
  acceptStableSignal(signal: MemoryCaptureSignal): Promise<MemoryCaptureAcceptance>;
  /** 宿主在关闭前停止稳定信号订阅；释放当前 Capture 所拥有的资源。 */
  release(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 背景供给（新会话绑定 + 每次冻结复核）
// ---------------------------------------------------------------------------

export type OwnerMemoryBackground = {
  readonly revisionId: string;
  readonly revision: number;
  readonly origin: "model" | "user_edit";
  readonly markdown: string;
  readonly generation: number;
  readonly updatedAt: number;
  /** Current source observations; not frozen in overview markdown or conversation binding. */
  readonly sourceStates?: readonly MemoryOverviewSourceState[];
};

/**
 * 背景供给口：Context Assembler / Run Birth 唯一读取路径。
 * resolveSupplyableBackground 在每次 provider 请求冻结前复核 policy（effective=active）、
 * generation 与绑定 revision 的 validity；任一不满足返回 undefined（无贡献），不自动换绑。
 */
export interface MemoryBackgroundPort {
  getActiveOwnerMemoryHead(owner: ConversationOwner): Promise<OwnerMemoryBackground | undefined>;
  resolveSupplyableBackground(input: {
    readonly owner: ConversationOwner;
    readonly revisionId: string;
    readonly generation: number;
  }): Promise<OwnerMemoryBackground | undefined>;
}

// ---------------------------------------------------------------------------
// 历史查询（search_history / read_history 的窄端口）
// ---------------------------------------------------------------------------

export type HistorySearchSource = "summary" | "transcript" | "all";

export type HistorySearchOutcome = "ok" | "no_hit" | "degraded";

export type HistorySourceCoverage = "available" | "partial" | "disabled" | "unavailable";

export type HistorySearchItem = {
  readonly type: "conversation_summary" | "raw_excerpt";
  readonly conversationId: string;
  readonly conversationTitle?: string;
  readonly occurredAt?: string;
  readonly coveredThroughTime?: string;
  readonly text: string;
  readonly sourceRef: string;
  readonly summaryRevision?: number;
  readonly truncated: boolean;
};

export type HistorySearchResult = {
  readonly outcome: HistorySearchOutcome;
  readonly coverage: Readonly<Record<"summary" | "transcript", HistorySourceCoverage>>;
  readonly items: readonly HistorySearchItem[];
};

export type HistorySearchInput = {
  readonly owner: ConversationOwner;
  readonly query: string;
  readonly conversationId?: string;
  readonly sources: HistorySearchSource;
  readonly limit: number;
};

export type HistoryReadInput = {
  readonly owner: ConversationOwner;
  readonly conversationId: string;
  readonly source: "summary" | "transcript";
  readonly fromOrdinal?: number;
  /** 片段续读偏移（N01）：fromOrdinal 所指轮次 turn 流内的字符起点。 */
  readonly fragmentStart?: number;
  /** Opaque continuation for a fixed summary revision. */
  readonly cursor?: string;
  readonly limitTokens: number;
};

export type HistoryReadResult =
  | {
      readonly outcome: "ok";
      readonly text: string;
      readonly truncated: boolean;
      /** summary 来源时的覆盖信息；transcript 来源时为 undefined。 */
      readonly coveredThroughOrdinal?: number;
      readonly hasUnsummarizedMessages?: boolean;
      /**
       * 续读位置（N01）：truncated 且片段进行中时指向同一 ordinal（配合
       * nextFragmentStart）；完整轮次边界推进时无 fragment。
       */
      readonly nextFromOrdinal?: number;
      readonly nextFragmentStart?: number;
      readonly nextCursor?: string;
    }
  | { readonly outcome: "unavailable"; readonly reason: string };

/**
 * 历史查询口：scope 由宿主从真实调用会话注入（调用方传 owner，不是模型选择）；
 * 检索保持中立，不携带原始分数/SQL/rowid。
 */
export interface HistoryQueryPort extends MemoryEntryQueryPort {
  search(input: HistorySearchInput): Promise<HistorySearchResult>;
  read(input: HistoryReadInput): Promise<HistoryReadResult>;
}

// ---------------------------------------------------------------------------
// 后台整理模型口（一次有界请求双输出）
// ---------------------------------------------------------------------------

export type MaintenancePromptMessage = {
  readonly role: "system" | "user";
  readonly content: string;
};

export type MaintenanceModelOutcome =
  | { readonly status: "completed"; readonly text: string }
  | { readonly status: "unavailable"; readonly reason: string };

export interface MemoryMaintenanceModelPort {
  /** 一次有界、无工具的 JSON 生成请求；失败返回 unavailable，绝不伪造输出。 */
  generate(input: { readonly messages: readonly MaintenancePromptMessage[]; readonly maxLatencyMs?: number }): Promise<MaintenanceModelOutcome>;
}

// ---------------------------------------------------------------------------
// Lifecycle Port（两阶段，只供 WorkbenchCoordination 与 Admin）
// ---------------------------------------------------------------------------

export type RemovalTicket = {
  readonly ticketId: string;
  readonly scope:
    | { readonly kind: "owner"; readonly owner: MemoryOwner }
    | { readonly kind: "conversation"; readonly conversationId: string };
  readonly fencedGeneration: number;
  readonly preparedAt: string;
};

export interface MemoryLifecycle extends MemorySourceLifecyclePort {
  prepareOwnerRemoval(owner: MemoryOwner): Promise<RemovalTicket>;
  finalizeOwnerRemoval(ticket: RemovalTicket): Promise<void>;
  /** 清除 owner 派生内容后恢复可参与状态；排除边界由 Admin 在 fence 前写入。 */
  clearOwnerMemory(owner: MemoryOwner): Promise<{ readonly generation: number }>;
  prepareConversationRemoval(conversationId: string): Promise<RemovalTicket>;
  finalizeConversationRemoval(ticket: RemovalTicket): Promise<void>;
}

// ---------------------------------------------------------------------------
// Admin Port
// ---------------------------------------------------------------------------

export type MemoryCapabilityStatus = {
  /** Whether the queried scope contains published, nonempty memory content. */
  readonly hasContent: boolean;
  /** 用户唯一可见的全局开关（默认关闭）；所有 Space 共享同一全局开关，不提供逐 owner opt-in。 */
  readonly enabled: boolean;
  readonly rollout: MemoryRolloutMode;
  readonly health: MemoryRuntimeHealth;
  readonly effective: "off" | "shadow" | "active";
};

export type MemoryCapabilityQuery = {
  readonly owner?: MemoryOwner;
};

export type ClearMemoryResult = { readonly generation: number };

export type UpdateMemoryResult = import("./entry-contracts.js").UpdateMemoryEntryResult;

/**
 * 普通设置命令；Application 落 src/app/application（跨 Feature 编排层），
 * Route 只解析 HTTP 并调用其中一个命令。
 */
export interface MemoryAdminApplication extends MemoryEntryAdminPort {
  getStatus(input?: MemoryCapabilityQuery): Promise<MemoryCapabilityStatus>;
  /** Developer-only rollout control; `off` is the immediate Memory kill switch. */
  setRollout(input: { rollout: MemoryRolloutMode }): Promise<{ policyRevision: PolicyRevision }>;
  /** 用户唯一可见的全局开关；同值重复设置是幂等 no-op，不重新排除、不 bump revision。 */
  setEnabled(input: { enabled: boolean }): Promise<{ policyRevision: PolicyRevision }>;
  clearMemory(input: { scope: MemoryOwner }): Promise<ClearMemoryResult>;
}

// ---------------------------------------------------------------------------
// Diagnostics（运行投影，不回写策略）
// ---------------------------------------------------------------------------

export type MemoryMaintenanceOutcomeTrace = {
  readonly jobId?: string;
  readonly durationMs?: number;
  readonly at: number;
  readonly conversationId?: string;
  readonly ownerKey?: string;
  readonly outcome: "committed" | "discarded" | "failed" | "retry_queued" | "no_evidence";
  readonly reason?: string;
  readonly longTermUpdated: boolean;
};

export type MemoryDiagnosticSnapshot = {
  readonly enabled: boolean;
  readonly generatedAt: number;
  readonly capability: MemoryCapabilityStatus | null;
  readonly jobs: {
    readonly queued: number;
    readonly running: number;
    readonly done: number;
    readonly failed: number;
  };
  readonly recentOutcomes: readonly MemoryMaintenanceOutcomeTrace[];
  readonly jobRows: readonly MemoryDiagnosticJob[];
  readonly jobRowsTruncated: boolean;
  readonly context: MemoryDiagnosticContext | null;
  readonly limits: {
    readonly idleDelayMs: number;
    readonly requestTokens: number;
    readonly outputReserveTokens: number;
    readonly memoryTokens: number;
    readonly summaryTokens: number;
  } | null;
};

export type MemoryDiagnosticQuery = {
  /** 结构化 owner；缺省表示全局（只读总量视图，无 per-owner 上下文）。 */
  readonly owner?: ConversationOwner;
  readonly conversationId?: string;
};

export type MemoryDiagnosticJob = {
  readonly jobId: string;
  readonly conversationId: string;
  readonly title: string;
  readonly ownerKey: string;
  readonly status: "queued" | "running" | "done" | "failed";
  readonly waitReason: "active_conversation" | "policy_blocked" | "retry_backoff" | "idle_delay" | "ready" | null;
  readonly requestedThrough: number;
  readonly processedThrough: number;
  readonly excludedThrough: number;
  readonly fragment: { readonly ordinal: number; readonly end: number } | null;
  readonly eligibleAt: number;
  readonly nextAttemptAt: number | null;
  readonly attempt: number;
  readonly lastFailure: string | null;
  readonly updatedAt: number;
};

export type MemoryDiagnosticBinding =
  | { readonly kind: "none"; readonly boundAt: string }
  | { readonly kind: "revision"; readonly boundAt: string; readonly revisionId: string; readonly revision: number; readonly generation: number };

export type MemoryDiagnosticContext = {
  readonly owner: ConversationOwner;
  readonly ownerTitle: string;
  readonly conversation: { readonly id: string; readonly title: string; readonly active: boolean } | null;
  readonly capability: MemoryCapabilityStatus;
  readonly blockingReasons: readonly string[];
  readonly memory: OwnerMemoryBackground | null;
  readonly summary: {
    readonly revision: number;
    readonly markdown: string;
    readonly updatedAt: number;
    readonly coveredThroughOrdinal: number;
  } | null;
  readonly binding: {
    readonly state: "unbound" | "none" | "available" | "unavailable";
    readonly reference: MemoryDiagnosticBinding | null;
    readonly differsFromHead: boolean;
    readonly markdown: string | null;
  } | null;
};

export type MemoryDiagnosticSearchInput = {
  readonly owner: ConversationOwner;
  readonly conversationId?: string;
  readonly query: string;
  readonly source: "summary" | "transcript" | "all";
};

// ---------------------------------------------------------------------------
// 错误（结构 code 负责程序分支；展示文案不在此层）
// ---------------------------------------------------------------------------

export const MEMORY_ERROR_CODES = [
  "memory_policy_revision_stale",
  "memory_revision_stale",
  "memory_capacity_exceeded",
  "memory_generation_fenced",
  "memory_owner_deleted",
  "memory_store_failure",
  "memory_model_unavailable",
  "memory_invalid_owner",
  "memory_entry_not_found",
  "memory_source_unavailable",
  "memory_invalid_edit",
  "memory_request_conflict",
] as const;

export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

export class MemoryError extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MemoryError";
  }
}
