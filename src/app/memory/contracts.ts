/**
 * 隐式长期记忆系统（Memory v2）公开契约。
 *
 * 设计基线：`docs/architecture/架构决策记录.md`《隐式长期记忆系统（Memory v2）》ADR
 * （proposed）与 `docs/memory-system/README.md`《手册》。本文件只冻结稳定概念与 Port
 * 合同，不包含检索算法、SQL schema 或模型提示；实验参数不进契约。
 *
 * 根本边界（ADR /《手册》24 章不变量）：
 * - Memory 是可选 Context Provider，不是 Core 前提；缺席时 Core 完整运行。
 * - Memory 只拥有派生记录，不拥有原始 Conversation 或 owner 身份。
 * - 贡献恒为 advisory data：不能覆盖当前请求、显式规则、权限或可验证事实。
 * - Stored / Retrieved / Injected / Used 四态分离；Used 不可被系统观测。
 */

import type { MemoryOwner } from "../../domain/memory/index.js";

// ---------------------------------------------------------------------------
// 政策与控制状态（《手册》7.1：分账表达，不合并 mutation 入口）
// ---------------------------------------------------------------------------

/** 实验参与模式：只决定 Capture/Retrieve/Inject 是否参与，不是健康状态。 */
export type MemoryRolloutMode = "off" | "shadow" | "active";

/** 运行健康投影：只在运行时派生，禁止回写成用户策略。 */
export type MemoryRuntimeHealth = "ready" | "degraded" | "unavailable";

/** 政策/配置修订标识；任一权威事实变化都 bump 对应 revision 使旧结果失效。 */
export type PolicyRevision = string;

/**
 * 一次边界计算得到的有效准入结论。
 *
 * 四个边界（capture 接受 / 模型结果提交 / recall 返回 / injection freeze）
 * 必须各自重新计算，不得复用一次陈旧结果（《手册》7.1）。
 */
export type EffectiveMemoryAdmission = {
  readonly effective: "off" | "shadow" | "active";
  readonly policyRevision: PolicyRevision;
  readonly rolloutRevision: string;
  readonly generation: number;
  /** 结构原因码（global_consent / space_participation / conversation_exclusion / rollout / generation_fence）。 */
  readonly reasons: readonly string[];
};

// ---------------------------------------------------------------------------
// MemoryRecord 概念模型（最终 SQL schema 待离线评测后冻结，此处只定稳定概念）
// ---------------------------------------------------------------------------

/** 首版记录类型；新增类型必须先经评测证明，不按"框架应该有"预实现。 */
export type MemoryRecordKind =
  | "preference"
  | "goal"
  | "decision"
  | "constraint"
  | "open_loop"
  | "episode";

/** 来源形态陈述，不是事实正确性或 prompt 权威。 */
export type MemoryEvidenceClass = "quoted_user_evidence" | "observed_result" | "derived_synthesis";

/** 是否经过用户明确确认；同样不是权威级别。 */
export type MemoryConfirmation = "unconfirmed" | "user_confirmed";

/** 首版状态机仅 active/retired；superseded/resolved/retracted 待 Shadow 数据证明后另立 ADR。 */
export type MemoryRecordStatus = "active" | "retired";

/** 指向一条证据（Conversation/Run/Turn）的可回溯引用；provenance 不向模型渲染。 */
export type MemoryEvidenceRef = {
  readonly conversationId: string;
  readonly runId?: string;
  readonly turnId?: string;
  readonly fromOrdinal?: number;
  readonly toOrdinal?: number;
  readonly sourceRevision: number;
};

// ---------------------------------------------------------------------------
// Capture Port（《手册》6.1）
// ---------------------------------------------------------------------------

/**
 * Ordinary Run 稳定终结后发出的结构化信号。
 *
 * `stableThrough.sourceRevision` 类型对齐既有
 * `OrdinaryStableTerminalRunFacts.sourceRevision: number`（= document.revision）。
 */
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
  /** 连续游标；全部证据已读完时为 undefined。 */
  readonly nextCursor: CheckpointRef | undefined;
};

/** 处理游标（Checkpoint/Job 的稳定概念，《手册》8.5）。 */
export type CheckpointRef = {
  readonly conversationId: string;
  readonly coveredThroughOrdinal: number;
  readonly sourceFingerprint: string;
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
  | { readonly status: "accepted"; readonly checkpoint: CheckpointRef }
  | { readonly status: "skipped"; readonly reason: string };

/**
 * Capture 运行时（可缺席）。accepted 只表示 durable job/checkpoint 与待处理边界
 * 已落盘（进程随后退出也不丢证据段），不保证一定形成长期 Memory。
 */
export interface MemoryCaptureRuntime {
  acceptStableSignal(signal: MemoryCaptureSignal): Promise<MemoryCaptureAcceptance>;
  /** Run birth 时补扫重启遗留缺口；实现必须不阻塞、不抛出到主链路。 */
  noteActivity(input: { conversationId: string; owner: MemoryOwner }): Promise<void>;
  /** 停止接单并释放后台资源（进程关闭）。 */
  release(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Recall Port（《手册》6.2）
// ---------------------------------------------------------------------------

export type MemoryRecallInput = {
  readonly owner: MemoryOwner;
  readonly conversationId?: string;
  readonly currentUserText: string;
  readonly recentContext?: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
  readonly candidateLimit: number;
  readonly deadlineAt: number;
};

/** 通过 scope/状态/eligibility 检查的有界候选；禁止携带原始分数/SQL/rowid/prompt。 */
export type RecalledMemory = {
  readonly ref: { readonly id: string; readonly revision: number };
  readonly scope: MemoryOwner;
  readonly kind: MemoryRecordKind;
  readonly text: string;
  readonly provenance: readonly MemoryEvidenceRef[];
  readonly evidenceClass: MemoryEvidenceClass;
  readonly confirmation: MemoryConfirmation;
  readonly updatedAt: number;
};

export type MemoryRecallSnapshot = {
  readonly recallId: string;
  readonly sourceRevision: string;
  readonly policyRevision: PolicyRevision;
  readonly generation: number;
  readonly scope: MemoryOwner;
  readonly candidates: readonly RecalledMemory[];
  /** failure 与 no-hit 必须可区分：无候选是 no-hit，检索失败要带结构化原因。 */
  readonly outcome: "no_hit" | "degraded" | "ok";
};

export interface MemoryRecallPort {
  recall(input: MemoryRecallInput): Promise<MemoryRecallSnapshot>;
}

// ---------------------------------------------------------------------------
// Context Contribution（《手册》6.3）
// ---------------------------------------------------------------------------

export type MemoryContextEntry = {
  readonly ref: { readonly id: string; readonly revision: number };
  readonly kind: MemoryRecordKind;
  readonly evidenceClass: MemoryEvidenceClass;
  readonly confirmation: MemoryConfirmation;
  readonly updatedAt: number;
  /** 唯一允许进入 Prompt 的字段。 */
  readonly modelText: string;
  readonly internalRefs: readonly MemoryEvidenceRef[];
};

/**
 * Assembler 可消费的通用贡献；source 固定为 implicit_memory，
 * Assembler 据此固定视为 advisory_data，Memory 不能提高自身权限。
 */
export type MemoryContextContribution = {
  readonly source: "implicit_memory";
  readonly snapshot: {
    readonly recallId: string;
    readonly sourceRevision: string;
    readonly policyRevision: PolicyRevision;
    readonly generation: number;
    readonly ownerKey: string;
  };
  readonly entries: readonly MemoryContextEntry[];
};

export type MemoryContributeInput = {
  readonly owner: MemoryOwner;
  readonly conversationId?: string;
  readonly currentUserText: string;
  readonly deadlineAt: number;
};

/**
 * 上下文提供口：返回贡献前必须完成 scope、policy revision、generation、
 * record revision 与 eligibility 的最终复核；Assembler 不再回调 Store。
 */
export interface MemoryContextProvider {
  contribute(input: MemoryContributeInput): Promise<MemoryContextContribution>;
}

// ---------------------------------------------------------------------------
// Lifecycle Port（《手册》6.4 / 12.5 / 12.6，两阶段，只供 WorkbenchCoordination）
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
  prepareConversationRemoval(conversationId: string): Promise<RemovalTicket>;
  finalizeConversationRemoval(ticket: RemovalTicket): Promise<void>;
}

// ---------------------------------------------------------------------------
// Admin Port（《手册》6.5）
// ---------------------------------------------------------------------------

export type MemoryCapabilityStatus = {
  readonly globalConsent: boolean;
  readonly rollout: MemoryRolloutMode;
  readonly health: MemoryRuntimeHealth;
  readonly effective: "off" | "shadow" | "active";
};

/** 用户清除结果：内部自完成 fence/generation 与 purge。 */
export type ClearImplicitMemoryResult = { readonly generation: number };

/**
 * 普通设置命令；Application 落 src/app/application（跨 Feature 编排层），
 * Route 只解析 HTTP 并调用其中一个命令。
 */
export interface MemoryAdminApplication {
  getCapabilityStatus(): Promise<MemoryCapabilityStatus>;
  setConsent(input: { globalConsent: boolean }): Promise<{ policyRevision: PolicyRevision }>;
  setSpaceParticipation(input: { spaceId: string; enabled: boolean }):
    Promise<{ policyRevision: PolicyRevision }>;
  setConversationParticipation(input: { conversationId: string; excluded: boolean }):
    Promise<{ policyRevision: PolicyRevision }>;
  clearImplicitMemory(input: { scope: MemoryOwner }): Promise<ClearImplicitMemoryResult>;
}

// ---------------------------------------------------------------------------
// 错误（结构 code 负责程序分支；展示文案不在此层）
// ---------------------------------------------------------------------------

export const MEMORY_ERROR_CODES = [
  "memory_policy_revision_stale",
  "memory_generation_fenced",
  "memory_owner_deleted",
  "memory_store_failure",
  "memory_model_unavailable",
  "memory_index_degraded",
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
