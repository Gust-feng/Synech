/**
 * 记忆系统文档产物（0.6.0 正式设计）公开契约。
 *
 * 设计基线：`docs/architecture/架构决策记录.md`"记忆系统文档产物重构"条与
 * `docs/memory-system/记忆系统正式设计.md` v0.6.0 及两份配套契约。本文件只冻结
 * 稳定概念与 Port 合同，不包含检索算法、SQL schema 或模型提示；实验参数不进契约。
 *
 * 根本边界：
 * - Memory 是可选背景供给方，不是 Core 前提；缺席时 Core 完整运行。
 * - Memory 只拥有派生文档产物，不拥有原始 Conversation 或 owner 身份。
 * - 背景恒为 advisory data：不能覆盖当前请求、显式规则、权限或可验证事实。
 * - 无新证据，模型不得触碰记忆；用户直接编辑是唯一无需新证据的编辑路径。
 * - Stored / Retrieved / Injected 可观测；Used 不可观测，工具调用率不是优化目标。
 */

import type { MemoryOwner } from "../../domain/memory/index.js";

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
  /** 结构原因码（global_consent / space_participation / rollout_off / generation_fence）。 */
  readonly reasons: readonly string[];
};

// ---------------------------------------------------------------------------
// Capture 信号与证据（沿用；Ordinary 窄口不变）
// ---------------------------------------------------------------------------

export type MemoryCaptureSignal = {
  readonly owner: MemoryOwner;
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
 * transcript 索引投影的增量覆盖（索引不依赖 consent，跟随信号推进）。
 */
export interface MemoryCaptureRuntime {
  acceptStableSignal(signal: MemoryCaptureSignal): Promise<MemoryCaptureAcceptance>;
  /** 进程关闭：停止接单并释放后台资源。 */
  release(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 背景供给（新会话绑定 + 每次冻结复核）
// ---------------------------------------------------------------------------

export type SpaceMemoryBackground = {
  readonly revisionId: string;
  readonly revision: number;
  readonly origin: "model" | "user_edit";
  readonly markdown: string;
  readonly generation: number;
  readonly updatedAt: number;
};

/**
 * 背景供给口：Context Assembler / Run Birth 唯一读取路径。
 * resolveSupplyableBackground 在每次 provider 请求冻结前复核 policy（effective=active）、
 * generation 与绑定 revision 的 validity；任一不满足返回 undefined（无贡献），不自动换绑。
 */
export interface MemoryBackgroundPort {
  getActiveSpaceMemoryHead(owner: MemoryOwner): Promise<SpaceMemoryBackground | undefined>;
  resolveSupplyableBackground(input: {
    readonly owner: MemoryOwner;
    readonly revisionId: string;
    readonly generation: number;
  }): Promise<SpaceMemoryBackground | undefined>;
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
  readonly owner: MemoryOwner;
  readonly query: string;
  readonly conversationId?: string;
  readonly sources: HistorySearchSource;
  readonly limit: number;
};

export type HistoryReadInput = {
  readonly owner: MemoryOwner;
  readonly conversationId: string;
  readonly source: "summary" | "transcript";
  readonly fromOrdinal?: number;
  /** 片段续读偏移（N01）：fromOrdinal 所指轮次 turn 流内的字符起点。 */
  readonly fragmentStart?: number;
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
    }
  | { readonly outcome: "unavailable"; readonly reason: string };

/**
 * 历史查询口：scope 由宿主从真实调用会话注入（调用方传 owner，不是模型选择）；
 * 检索保持中立，不携带原始分数/SQL/rowid。
 */
export interface HistoryQueryPort {
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
  generate(input: { readonly messages: readonly MaintenancePromptMessage[] }): Promise<MaintenanceModelOutcome>;
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

export interface MemoryLifecycle {
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
  readonly globalConsent: boolean;
  readonly rollout: MemoryRolloutMode;
  readonly health: MemoryRuntimeHealth;
  readonly effective: "off" | "shadow" | "active";
  /** Current Space participation, omitted outside a Space capability view. */
  readonly spaceParticipation?: boolean;
};

export type MemoryCapabilityQuery = {
  readonly owner?: MemoryOwner;
};

export type ClearImplicitMemoryResult = { readonly generation: number };

export type WriteSpaceMemoryResult = {
  readonly revisionId: string;
  readonly revision: number;
};

/**
 * 普通设置命令；Application 落 src/app/application（跨 Feature 编排层），
 * Route 只解析 HTTP 并调用其中一个命令。
 */
export interface MemoryAdminApplication {
  getCapabilityStatus(input?: MemoryCapabilityQuery): Promise<MemoryCapabilityStatus>;
  /** Developer-only rollout control; `off` is the immediate Memory kill switch. */
  setRollout(input: { rollout: MemoryRolloutMode }): Promise<{ policyRevision: PolicyRevision }>;
  setConsent(input: { globalConsent: boolean }): Promise<{ policyRevision: PolicyRevision }>;
  setSpaceParticipation(input: { spaceId: string; enabled: boolean }):
    Promise<{ policyRevision: PolicyRevision }>;
  clearImplicitMemory(input: { scope: MemoryOwner }): Promise<ClearImplicitMemoryResult>;
  /**
   * 用户直接编辑 Space 长期记忆（唯一无需新证据的编辑路径）：CAS 发布新版本并
   * 撤销被明确替换的旧版供给；不调用模型，空正文合法（不等于 clear）。
   */
  writeSpaceMemory(input: {
    readonly spaceId: string;
    readonly expectedRevisionId: string | null;
    readonly markdown: string;
    readonly requestId: string;
  }): Promise<WriteSpaceMemoryResult>;
  /** Memory Center 只读视图：当前文档、真实来源会话与最近整理时间。 */
  getSpaceMemoryView(input: { readonly spaceId: string }): Promise<{
    readonly document: SpaceMemoryBackground | undefined;
    /** 当前文档的来源会话范围（文档级保守依赖粒度，按会话聚合；含可识别信息）。 */
    readonly sources: readonly {
      readonly conversationId: string;
      readonly fromOrdinal: number;
      readonly toOrdinal: number;
      readonly title?: string;
      /** 来源会话最近更新时间（Ordinary 会话事实），不是事实发生时间。 */
      readonly sourceTime?: string;
    }[];
    readonly summaryCount: number;
    readonly lastMaintenanceAt: number | null;
  }>;
}

// ---------------------------------------------------------------------------
// Diagnostics（运行投影，不回写策略）
// ---------------------------------------------------------------------------

export type MemoryMaintenanceOutcomeTrace = {
  readonly at: number;
  readonly conversationId?: string;
  readonly ownerKey?: string;
  readonly outcome: "committed" | "discarded" | "failed" | "retry_queued" | "no_evidence";
  readonly reason?: string;
  readonly longTermUpdated: boolean;
};

export type MemoryDiagnosticSnapshot = {
  readonly enabled: boolean;
  readonly jobs: {
    readonly queued: number;
    readonly running: number;
    readonly done: number;
    readonly failed: number;
  };
  readonly recentOutcomes: readonly MemoryMaintenanceOutcomeTrace[];
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
