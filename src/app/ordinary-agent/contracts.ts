import type { ConfirmationDecision, ConfirmationRequest } from "../../domain/confirmation/index.js";
import type { ConversationOwner } from "../../domain/execution-scope/index.js";
import type { MemoryContentKind, MemoryOwner } from "../../domain/memory/index.js";
import type {
  OrdinaryCapabilitySnapshot,
  ModelRunReasoningEffort,
  RunAgentDefinitionRef,
  RunCapabilityResolution,
  SanitizedInformationAccessConfig,
  SanitizedModelProviderConfig,
} from "../../domain/config/index.js";
import type { ModelUsage } from "../../domain/intelligence/index.js";
import type {
  ToolCallProgress,
  ToolCallRequest,
  ToolCallResult,
  ToolRunAccessPolicy,
} from "../../domain/tools/index.js";
import type { ModelRuntimeMode } from "../model-runtime/contracts.js";
import type {
  AgentSessionExecutionRefs,
  AgentSessionEntryRef,
  AgentSessionRef,
  AgentSessionWriteCheckpoint,
} from "../model-runtime/agent-session.js";
import type { OrdinaryRunContextInput } from "../../domain/ordinary/index.js";
import type { AgentNoteVersions } from "../agent-notes/contracts.js";
import type { OrdinaryToolMetricsSnapshot } from "./tool-runtime-metrics.js";
import type {
  CreateOrdinaryManagedAttachmentDraftResult,
  OrdinaryManagedAttachmentRecord,
} from "./managed-attachment-repository.js";

export const ORDINARY_RUN_SCHEMA_VERSION = "ordinary-run/v1" as const;
export const ORDINARY_CONVERSATION_SCHEMA_VERSION = "ordinary-conversation/v1" as const;

export type OrdinaryFeatureErrorCode =
  | "ordinary_feature_released"
  | "ordinary_run_not_found"
  | "ordinary_conversation_not_found"
  | "ordinary_conversation_owner_required"
  | "ordinary_conversation_deleted"
  | "ordinary_run_conflict"
  | "ordinary_revision_conflict"
  | "ordinary_run_state_conflict"
  | "ordinary_conversation_busy"
  | "ordinary_rollback_target_not_found"
  | "ordinary_confirmation_not_found"
  | "ordinary_confirmation_in_progress"
  | "ordinary_tool_result_conflict"
  | "ordinary_submission_conflict"
  | "ordinary_conversation_cleanup_pending"
  | "ordinary_managed_attachment_unavailable"
  | "ordinary_memory_scope_unavailable"
  | "ordinary_completion_commit_failed";

/** Expected command/query failures that protocol adapters may map without parsing messages. */
export class OrdinaryFeatureError extends Error {
  readonly name = "OrdinaryFeatureError";

  constructor(
    readonly code: OrdinaryFeatureErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Failures that never rewrite committed run facts but must not stay invisible.
 * They surface through the feature's optional `onDiagnostic` hook only.
 */
export type OrdinaryFeatureDiagnostic =
  | {
      /** Session finalize failed; the queue stays paused until a later explicit scheduling event succeeds. */
      readonly kind: "session_finalization_failed";
      readonly runId: string;
      readonly error: unknown;
    }
  | {
      /** Startup recovery could not project this conversation; its data stays on disk for diagnosis. */
      readonly kind: "conversation_unavailable";
      readonly conversationId: string;
      readonly error?: unknown;
    }
  | {
      /** A repository-wide startup enumeration failed; live new conversations may still be created. */
      readonly kind: "startup_recovery_failed";
      readonly source: "conversation_repository" | "run_repository";
      readonly error: unknown;
    }
  | {
      /** A successor activation attempt failed; the queued successor remains available. */
      readonly kind: "successor_activation_failed";
      readonly conversationId: string;
      readonly predecessorRunId?: string;
      readonly error: unknown;
    }
  | {
      /** Post-commit cancellation cleanup failed without changing the durable cancelled fact. */
      readonly kind: "cancellation_cleanup_failed";
      readonly runId: string;
      readonly phase: "continuation_release" | "terminal_settlement";
      readonly error: unknown;
    }
  | {
      /** Durable deletion remains authoritative while cleanup is incomplete. */
      readonly kind: "conversation_cleanup_failed";
      readonly conversationId: string;
    readonly phase: "run_enumeration" | "tool_evidence" | "memory_facts" | "run_snapshot" | "session" | "terminal_settlement" | "conversation_control";
      readonly runId?: string;
      readonly error: unknown;
    }
  | {
      /** A tombstoned conversation still owns managed attachments after cleanup failed. */
      readonly kind: "managed_attachment_cleanup_failed";
      readonly conversationId: string;
      readonly error: unknown;
    }
  | {
      /** One damaged managed attachment was isolated while unrelated recovery continued. */
      readonly kind: "managed_attachment_recovery_issue";
      readonly identity?: string;
      readonly error: unknown;
    }
  | {
      /** Run birth failed after claim and attachment rollback also failed. */
      readonly kind: "managed_attachment_claim_rollback_failed";
      readonly runId: string;
      readonly conversationId: string;
      readonly attachmentIds: readonly string[];
      readonly error: unknown;
    }
  | {
      /** Model execution completed, but the terminal Ordinary snapshot could not be committed. */
      readonly kind: "completion_commit_failed";
      readonly runId: string;
      readonly error: unknown;
    }
  | {
      /** 会话标题模型生成失败；列表继续使用首条消息截断回退，不阻塞对话。 */
      readonly kind: "conversation_title_generation_failed";
      readonly conversationId: string;
      readonly error: unknown;
    };

export type OrdinaryRunBirth = {
  readonly instructions: string;
  readonly aiMode: ModelRuntimeMode;
  readonly config: SanitizedModelProviderConfig;
  readonly reasoningEffort?: ModelRunReasoningEffort;
  readonly agentDefinitionRef: RunAgentDefinitionRef;
  readonly capabilitySnapshot: OrdinaryCapabilitySnapshot;
  /** Versions of the Agent Notes text frozen into this run's instructions. */
  readonly agentNoteVersions?: AgentNoteVersions;
  /** Stable non-global memory owner frozen with this run; never derived from cwd. */
  readonly memoryOwner: ConversationOwner;
  /** 模型可见的 Owner 与环境上下文，随 Run 出生事实冻结。 */
  readonly ownerContext?: string;
  readonly informationAccess: SanitizedInformationAccessConfig;
  readonly accessPolicy: ToolRunAccessPolicy;
};

export type OrdinaryRunInput = {
  readonly userMessage: string;
  /**
   * Canonical Ordinary context input persisted by the first run format.
   */
  readonly context?: OrdinaryRunContextInput;
};

export type OrdinaryRunTurn = {
  readonly conversationId: string;
  readonly ordinal: number;
  readonly userTurnId: string;
  readonly assistantTurnId: string;
  readonly predecessorRunId?: string;
};

export type OrdinaryConversationControlState = {
  readonly conversationId: string;
  readonly createdAt: string;
  /** Pi Session owns the transcript tree and active branch. */
  readonly sessionRef: AgentSessionRef;
  /** Canonical Conversation owner captured at creation. */
  readonly owner: ConversationOwner;
  readonly titleOverride?: string;
  readonly titleEditedAt?: string;
  /**
   * 模型生成的会话标题（ADR 口径：UI 摘要字段的运行时事实）。用户手动
   * 重命名（titleOverride）优先；生成失败或未接线时回退到首条消息截断。
   */
  readonly autoTitle?: string;
  readonly autoTitleAt?: string;
  readonly pinnedAt?: string;
  readonly deletedAt?: string;
};

export type OrdinaryConversationControlDocument = {
  readonly schemaVersion: typeof ORDINARY_CONVERSATION_SCHEMA_VERSION;
  readonly revision: number;
  readonly savedAt: string;
  readonly state: OrdinaryConversationControlState;
};

export type OrdinaryConversationControlSummary = {
  readonly conversationId: string;
  readonly updatedAt: string;
  readonly deleted: boolean;
};

export interface OrdinaryConversationControlRepository {
  save(state: OrdinaryConversationControlState, expectedRevision: number, savedAt: string): Promise<OrdinaryConversationControlDocument>;
  /** Removes a control document that never became user-visible and still has the expected revision. */
  delete(conversationId: string, expectedRevision: number): Promise<void>;
  get(conversationId: string): Promise<OrdinaryConversationControlDocument | undefined>;
  list(limit?: number): Promise<readonly OrdinaryConversationControlSummary[]>;
}

export type OrdinaryRunStatus =
  | { readonly kind: "queued" }
  | { readonly kind: "running" }
  | {
      readonly kind: "awaiting_approval";
      readonly confirmationRequests: readonly ConfirmationRequest[];
      readonly continuationAvailability: "live_only";
    }
  | { readonly kind: "completed" }
  | {
      readonly kind: "failed";
      readonly error: { readonly code: string; readonly message: string };
    }
  | { readonly kind: "cancelled"; readonly reason: string }
  | {
      readonly kind: "blocked";
      readonly reason: { readonly code: string; readonly message: string };
      readonly continueBy: "new_turn";
    };

export type OrdinaryPendingToolRound = {
  /** Pi Session entry containing the provider-ordered root tool calls. */
  readonly assistantEntryRef: AgentSessionEntryRef;
  /** Provider call identities in the exact assistant-message order. */
  readonly providerCallIds: readonly string[];
  /** Synech invocation identities of the root tool calls in provider order. */
  readonly invocationIds: readonly string[];
};

/** Durable positions for one run without copying Pi's transcript or branch tree. */
export type OrdinaryRunSessionPhase =
  | { readonly phase: "not_started" }
  | {
      readonly phase: "started";
      readonly startLeafRef: AgentSessionEntryRef | null;
      readonly compactionEntryRefs: readonly AgentSessionEntryRef[];
    }
  | {
      readonly phase: "rollbackable";
      readonly startLeafRef: AgentSessionEntryRef | null;
      readonly endLeafRef: AgentSessionEntryRef;
      readonly compactionEntryRefs: readonly AgentSessionEntryRef[];
    }
  | {
      readonly phase: "completion_candidate";
      readonly startLeafRef: AgentSessionEntryRef | null;
      readonly rollbackLeafRef: AgentSessionEntryRef;
      readonly assistantEntryRef: AgentSessionEntryRef;
      readonly compactionEntryRefs: readonly AgentSessionEntryRef[];
    };

type OrdinaryRunEventBase = {
  readonly eventId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly recordedAt: string;
};

export type OrdinaryRunEvent = OrdinaryRunEventBase & (
  | { readonly type: "run.created" | "run.started" }
  | {
      readonly type: "model.output.completed";
      readonly modelRequestId: string;
      readonly assistantEntryRef: AgentSessionEntryRef;
    }
  | { readonly type: "model.reasoning.completed"; readonly modelRequestId: string; readonly contentIndex: number; readonly content: string }
  | {
      readonly type: "context.compaction.completed";
      readonly compactionEntryRef: AgentSessionEntryRef;
      readonly tokensBefore: number;
    }
  | { readonly type: "run.approval_requested"; readonly confirmationRequests: readonly ConfirmationRequest[]; readonly invocationIds: readonly string[] }
  | { readonly type: "run.approval_decided"; readonly decision: ConfirmationDecision }
  | { readonly type: "run.completed"; readonly invocationIds: readonly string[] }
  | { readonly type: "run.failed"; readonly code: string; readonly invocationIds: readonly string[] }
  | { readonly type: "run.cancelled"; readonly reason: string; readonly invocationIds: readonly string[] }
  | { readonly type: "run.blocked"; readonly code: string }
);

export type OrdinaryRunState = {
  readonly runId: string;
  readonly sessionRef: AgentSessionRef;
  readonly turn: OrdinaryRunTurn;
  readonly input: OrdinaryRunInput;
  readonly birth: OrdinaryRunBirth;
  readonly status: OrdinaryRunStatus;
  readonly session: OrdinaryRunSessionPhase;
  /**
   * Durable checkpoint of assistant text that was already visible while the
   * run was live. It restores the conversation surface after interruption but
   * is never a completed answer or canonical model history.
   */
  readonly visibleAssistantText?: string;
  /** Durable write-ahead fact until every root call has a resolved tool result. */
  readonly pendingToolRound?: OrdinaryPendingToolRound;
  /** Nested requests accepted before execution and not yet closed by a terminal fact. */
  readonly pendingNestedToolCalls?: readonly OrdinaryPendingNestedToolCall[];
  readonly toolCalls: readonly ToolCallResult[];
  /** Durable occurrence time keyed by the stable tool result identity. */
  readonly toolResultRecordedAt: Readonly<Record<string, string>>;
  /** Cumulative provider usage for this run, including every live approval continuation segment. */
  readonly usage: ModelUsage;
  readonly toolMetrics?: OrdinaryToolMetricsSnapshot;
  /** Effective capability boundary resolved from the frozen birth snapshot and executable Host tools. */
  readonly capabilityResolution?: RunCapabilityResolution;
  readonly timeline: readonly OrdinaryRunEvent[];
  readonly timestamps: {
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly terminalAt?: string;
  };
};

export type OrdinaryPendingNestedToolCall = ToolCallRequest & {
  readonly invocationId: string;
  readonly parentInvocationId: string;
};

export type OrdinaryRunSnapshotDocument = {
  readonly schemaVersion: typeof ORDINARY_RUN_SCHEMA_VERSION;
  readonly revision: number;
  readonly savedAt: string;
  readonly state: OrdinaryRunState;
};

export type OrdinaryRunSummary = {
  readonly runId: string;
  readonly conversationId: string;
  readonly userTurnId: string;
  readonly assistantTurnId: string;
  readonly status: OrdinaryRunStatus["kind"];
  readonly createdAt: string;
  readonly updatedAt: string;
};

/**
 * Ordinary owns these facts because only it can truthfully bind a memory read
 * or explicit adoption to a specific run. The memory feature never increments
 * usage counters by itself.
 */
export type OrdinaryMemoryFact = {
  readonly factId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly kind: "read" | "applied";
  readonly memoryId: string;
  readonly memoryKind: MemoryContentKind;
  readonly owner: MemoryOwner;
  readonly revision: number;
  readonly title: string;
  readonly recordedAt: string;
  readonly note?: string;
};

export interface OrdinaryMemoryFactRepository {
  append(fact: OrdinaryMemoryFact): Promise<"recorded" | "already_recorded">;
  list(query?: { readonly runId?: string; readonly memoryId?: string }): Promise<readonly OrdinaryMemoryFact[]>;
  deleteByRunIds(runIds: readonly string[]): Promise<void>;
}

export type OrdinaryRunRecoveryInventory = {
  readonly summaries: readonly OrdinaryRunSummary[];
  readonly issues: readonly {
    readonly runId: string;
    readonly error: unknown;
  }[];
};

export interface OrdinaryRunRepository {
  save(state: OrdinaryRunState, expectedRevision: number): Promise<OrdinaryRunSnapshotDocument>;
  get(runId: string): Promise<OrdinaryRunSnapshotDocument | undefined>;
  list(limit?: number): Promise<readonly OrdinaryRunSummary[]>;
  /** Full startup inventory; any issue makes absence-based cleanup unsafe. */
  inspectRecoveryInventory(): Promise<OrdinaryRunRecoveryInventory>;
  delete(runId: string): Promise<void>;
}

export type OrdinaryExecutionFacts = {
  readonly toolCalls: readonly ToolCallResult[];
  /** Cumulative usage for the whole live execution/continuation chain. */
  readonly usage: ModelUsage;
  readonly toolMetrics?: OrdinaryToolMetricsSnapshot;
  readonly capabilityResolution?: RunCapabilityResolution;
};

export type OrdinaryExecutionOutcome =
  | (OrdinaryExecutionFacts & {
      readonly status: "completed";
      readonly answer: string;
      readonly session: AgentSessionExecutionRefs;
    })
  | (OrdinaryExecutionFacts & {
      readonly status: "approval_required";
      readonly session?: AgentSessionExecutionRefs;
      readonly confirmationRequests: readonly ConfirmationRequest[];
      readonly continuation: OrdinaryExecutionContinuation;
    })
  | (OrdinaryExecutionFacts & {
      readonly status: "cancelled";
      readonly reason: string;
      readonly session?: AgentSessionExecutionRefs;
    })
  | (OrdinaryExecutionFacts & {
      readonly status: "failed";
      readonly session?: AgentSessionExecutionRefs;
      readonly error: { readonly code: string; readonly message: string };
    });

export interface OrdinaryExecutionContinuation {
  readonly availability: "live_only";
  decide(input: {
    readonly decision: ConfirmationDecision;
    readonly abortSignal: AbortSignal;
  }): Promise<OrdinaryExecutionOutcome>;
  /** Releases the live-only model/tool continuation without deciding it. */
  release(): Promise<void>;
}

export type OrdinaryExecutionInput = {
  readonly runId: string;
  readonly conversationId: string;
  readonly sessionRef: AgentSessionRef;
  readonly birth: OrdinaryRunBirth;
  /** Durable user input, including attachment refs that must be resolved per request. */
  readonly runInput: OrdinaryRunInput;
  readonly abortSignal: AbortSignal;
  readonly onModelContent?: (event: import("../model-runtime/agent-loop.js").ModelContentBlockEvent) => void | Promise<void>;
  /**
   * Owner identity binding for one root tool batch. Ordinary mints the
   * authoritative invocationId for each provider-issued call; the model
   * adapter must not invent its own.
   */
  readonly acceptToolInvocations: (
    calls: readonly import("../model-runtime/agent-loop.js").ProviderToolCall[],
  ) => Promise<readonly import("../model-runtime/agent-loop.js").AcceptedToolInvocation[]>;
  /**
   * Owner identity binding for one provider-emitted nested tool batch. Each
   * nested call gets a fresh invocationId whose parent is the delegated
   * AgentTool invocation already accepted by Ordinary.
   */
  readonly acceptNestedToolInvocations: (
    calls: readonly import("../model-runtime/agent-loop.js").ProviderToolCall[],
  ) => Promise<readonly import("../model-runtime/agent-loop.js").AcceptedToolInvocation[]>;
  readonly onToolRequested?: (request: ToolCallRequest) => void;
  /** Must settle before a provider-emitted nested tool batch can preflight or execute. */
  readonly onNestedToolRequestsAccepted?: (requests: readonly ToolCallRequest[]) => Promise<void>;
  readonly onToolProgress?: (progress: ToolCallProgress) => void;
  readonly onSessionWriteCheckpoint?: (checkpoint: AgentSessionWriteCheckpoint) => Promise<void>;
  /** Must settle before the executed result is returned to the model. */
  readonly onToolResult?: (result: ToolCallResult) => Promise<void>;
};

export type OrdinaryRunActivityCursor = {
  /** Changes whenever live-only activity memory is recreated, including after restart. */
  readonly streamId: string;
  readonly sequence: number;
};

type OrdinaryRunActivityBase = {
  readonly activityId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly recordedAt: string;
};

export type OrdinaryRunActivity = OrdinaryRunActivityBase & (
  | { readonly type: "run.transition"; readonly durability: "durable"; readonly event: OrdinaryRunEvent }
  | {
      readonly type: "model.output.completed";
      readonly durability: "durable";
      readonly modelRequestId: string;
      readonly assistantEntryRef: AgentSessionEntryRef;
      readonly content: string;
    }
  | { readonly type: "model.request"; readonly durability: "live_only"; readonly reason: "initial" | "after_tool" | "after_approval" }
  | {
      readonly type: "model.output.delta";
      readonly durability: "live_only";
      readonly modelRequestId: string;
      readonly contentIndex: number;
      readonly delta: string;
    }
  | {
      readonly type: "model.reasoning.delta";
      readonly durability: "live_only";
      readonly modelRequestId: string;
      readonly contentIndex: number;
      readonly delta: string;
    }
  | { readonly type: "tool.requested"; readonly durability: "live_only"; readonly request: ToolCallRequest }
  | {
      readonly type: "tool.progress";
      readonly durability: "live_only";
      readonly request: ToolCallRequest;
      readonly progress: ToolCallProgress["progress"];
    }
  | { readonly type: "tool.result"; readonly durability: "live_only" | "durable"; readonly result: ToolCallResult }
);

export type OrdinaryRunActivityReplay = {
  readonly cursor: OrdinaryRunActivityCursor;
  /** True when the supplied cursor belonged to a previous in-memory stream generation. */
  readonly reset: boolean;
  readonly activities: readonly OrdinaryRunActivity[];
};

/** Missing live control is an idempotent outcome, not an error classified by message text. */
export type OrdinarySessionFinalizationResult =
  | { readonly status: "finalized" }
  | { readonly status: "no_session" };

export interface OrdinaryExecutionPort {
  execute(input: OrdinaryExecutionInput): Promise<OrdinaryExecutionOutcome>;
  /** Finalizes an active Session writer after Ordinary durably commits terminal state. */
  finalizeSession?(
    runId: string,
    target?: import("../model-runtime/agent-session.js").AgentSessionEntryRef | null,
  ): Promise<OrdinarySessionFinalizationResult>;
}

export type StartOrdinaryRunInput = {
  readonly runId: string;
  readonly sessionRef: AgentSessionRef;
  readonly turn: OrdinaryRunTurn;
  readonly input: OrdinaryRunInput;
  readonly birth: OrdinaryRunBirth;
};

export type SubmitOrdinaryTurnInput = {
  readonly conversationId?: string;
  /** Host-selected identity for a new conversation; mutually exclusive with conversationId. */
  readonly newConversationId?: string;
  /** Canonical owner for a new conversation. Required when creating a conversation. */
  readonly owner?: ConversationOwner;
  readonly submissionId?: string;
  readonly input: OrdinaryRunInput;
  readonly birth: OrdinaryRunBirth;
  readonly abortSignal?: AbortSignal;
};

/** Ordinary owns the business run; the neutral decision owns only confirmation semantics. */
export type DecideOrdinaryApprovalInput = {
  readonly ownerRunId: string;
  readonly confirmationId: string;
  readonly decision: ConfirmationDecision["decision"];
  readonly guidance?: string;
  readonly decidedAt: string;
};

export type OrdinaryConversationTurnReadModel =
  | {
      readonly role: "user";
      readonly turnId: string;
      readonly runId: string;
      readonly content: string;
      readonly input: OrdinaryRunInput;
      readonly status: "pending" | "completed";
      readonly createdAt: string;
      readonly updatedAt: string;
    }
  | {
      readonly role: "assistant";
      readonly turnId: string;
      readonly runId: string;
      readonly content: string;
      readonly status: OrdinaryRunStatus["kind"];
      readonly failure?: { readonly code: string; readonly message: string };
      /** Quiet product treatment for a terminal run whose live continuation cannot resume. */
      readonly interruption?: "user_cancelled" | "runtime_stopped";
      readonly model: SanitizedModelProviderConfig;
      readonly createdAt: string;
      readonly updatedAt: string;
    };

export type OrdinaryConversationReadModel = {
  readonly conversationId: string;
  readonly title: string;
  readonly titleEditedAt?: string;
  readonly pinnedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activeRunId?: string;
  readonly latestRunId?: string;
  readonly queuedRunIds: readonly string[];
  readonly turns: readonly OrdinaryConversationTurnReadModel[];
};

/**
 * Host 提供的模型标题生成能力（中性端口）。生成与持久化事实归 Ordinary
 * 拥有；Host 负责用与 run 相同的冻结 provider 配置发起一次无工具模型调用。
 * 返回 undefined 表示无法生成，列表继续使用首条消息截断回退。
 */
export type OrdinaryConversationTitleGenerationInput = {
  readonly conversationId: string;
  /** 会话第一条用户消息；生成器据此提炼简短标题。 */
  readonly userMessage: string;
  /** 冻结的 run birth，Host 据此重建 provider 绑定。 */
  readonly birth: OrdinaryRunBirth;
};

export type OrdinaryConversationTitleGenerator = (
  input: OrdinaryConversationTitleGenerationInput,
) => Promise<string | undefined>;

export type SubmitOrdinaryTurnResult = {
  readonly conversation: OrdinaryConversationReadModel;
  readonly run: OrdinaryRunState;
};

/**
 * Narrow public projection of one run whose terminal facts are stable: the
 * terminal snapshot and every accepted tool result are durably persisted and
 * the live execution has settled. This is an Ordinary-owned source contract
 * for read-only consumers such as audits and diagnostic projections. Long-term
 * memory capture is intentionally not part of this production owner graph.
 */
export type OrdinaryStableTerminalRunFacts = {
  readonly runId: string;
  /** Persisted snapshot revision backing these facts. */
  readonly sourceRevision: number;
  readonly turn: OrdinaryRunTurn;
  readonly userMessage: string;
  readonly taskContextRefs: readonly string[];
  readonly workspaceRoot: string;
  readonly executionStarted: boolean;
  readonly toolFacts: readonly {
    readonly toolFactId: string;
    readonly parentToolFactId?: string;
    readonly toolName: string;
    readonly status: "completed" | "failed" | "cancelled";
    readonly durationMs: number;
    readonly error?: {
      readonly domain?: string;
      readonly code?: string;
      readonly message: string;
    };
  }[];
  readonly status: Extract<
    OrdinaryRunStatus,
    { readonly kind: "completed" | "failed" | "cancelled" | "blocked" }
  >;
  readonly createdAt: string;
  readonly terminalAt: string;
};

export interface OrdinaryAgentFeature {
  readonly commands: {
    start(input: StartOrdinaryRunInput): Promise<OrdinaryRunState>;
    submitTurn(input: SubmitOrdinaryTurnInput): Promise<SubmitOrdinaryTurnResult>;
    renameConversation(conversationId: string, title: string): Promise<OrdinaryConversationReadModel>;
    setConversationPinned(conversationId: string, pinned: boolean): Promise<OrdinaryConversationReadModel>;
    rollbackConversation(input: { readonly conversationId: string; readonly targetRunId?: string; readonly stepsBack?: number }): Promise<OrdinaryConversationReadModel>;
    deleteConversation(conversationId: string): Promise<void>;
    createManagedAttachmentDraft(input: {
      readonly originalName: string;
      readonly mimeType?: string;
      readonly content: Uint8Array;
      readonly uploadRequestId?: string;
      readonly uploadFileIndex?: number;
    }): Promise<CreateOrdinaryManagedAttachmentDraftResult>;
    discardManagedAttachmentDraft(attachmentId: string): Promise<void>;
    cancel(runId: string, reason?: string): Promise<OrdinaryRunState>;
    decideApproval(input: DecideOrdinaryApprovalInput): Promise<OrdinaryRunState>;
    recordMemoryRead(input: Omit<OrdinaryMemoryFact, "kind" | "memoryKind" | "recordedAt" | "conversationId">): Promise<void>;
    recordMemoryReference(input: Omit<OrdinaryMemoryFact, "kind" | "memoryKind" | "recordedAt" | "conversationId">): Promise<"recorded" | "already_recorded" | "not_read">;
  };
  readonly queries: {
    getRun(runId: string): Promise<OrdinaryRunState | undefined>;
    listRuns(limit?: number): Promise<readonly OrdinaryRunSummary[]>;
    getConversation(conversationId: string): Promise<OrdinaryConversationReadModel | undefined>;
    listConversations(limit?: number): Promise<readonly OrdinaryConversationReadModel[]>;
    /** Canonical owner captured by the conversation workflow. */
    getConversationOwner(conversationId: string): Promise<ConversationOwner | undefined>;
    /** Owner 视角的对话列表，供删除协调与资源页 read-model 使用。 */
    listConversationsByOwner(owner: ConversationOwner): Promise<readonly OrdinaryConversationReadModel[]>;
    getManagedAttachment(attachmentId: string): Promise<OrdinaryManagedAttachmentRecord | undefined>;
    listMemoryFacts(query?: { readonly runId?: string; readonly memoryId?: string }): Promise<readonly OrdinaryMemoryFact[]>;
    /** Releases cached terminal run snapshots after bulk reads so full-history scans do not pin them in memory. */
    releaseTerminalRunCaches(runIds: readonly string[]): Promise<void>;
    /** Returns undefined until the run's terminal facts are durably settled. */
    getStableTerminalRunFacts(runId: string): Promise<OrdinaryStableTerminalRunFacts | undefined>;
  };
  readonly events: {
    replay(runId: string, cursor?: OrdinaryRunActivityCursor): Promise<OrdinaryRunActivityReplay | undefined>;
    subscribe(runId: string, listener: (activity: OrdinaryRunActivity) => void): () => void;
    /** Notifies once terminal facts are stable; the same run may notify again and consumers must be idempotent. */
    subscribeStableTerminalRuns(listener: (runId: string) => void): () => void;
  };
  release(): Promise<void>;
}
