// 记忆系统文档产物（0.6.0）公共 facade。
// 对外只导出稳定契约与组合入口；SQL、索引和模型适配仍留在各自内部模块。
export {
  MEMORY_ERROR_CODES,
  MemoryError,
  type ClearImplicitMemoryResult,
  type EffectiveMemoryAdmission,
  type EvidenceTurn,
  type EvidenceWindow,
  type HistoryQueryPort,
  type HistoryReadInput,
  type HistoryReadResult,
  type HistorySearchInput,
  type HistorySearchResult,
  type HistorySourceCoverage,
  type MemoryAdminApplication,
  type MemoryBackgroundPort,
  type MemoryCapabilityQuery,
  type MemoryCapabilityStatus,
  type MemoryCaptureAcceptance,
  type MemoryCaptureRuntime,
  type MemoryCaptureSignal,
  type MemoryDiagnosticSnapshot,
  type MemoryLifecycle,
  type MemoryRolloutMode,
  type MemoryRuntimeHealth,
  type OrdinaryEvidenceReader,
  type PolicyRevision,
  type RemovalTicket,
  type SpaceMemoryBackground,
  type WriteSpaceMemoryResult,
} from "./contracts.js";
export {
  createNoopMemoryBackgroundPort,
  createNoopMemoryCaptureRuntime,
  createNoopMemoryHistoryQueryPort,
  createProvenAbsentMemoryLifecycle,
  createUnavailableMemoryLifecycle,
} from "./noop.js";
export {
  MEMORY_BACKGROUND_HEADER,
  renderMemoryBackgroundBlock,
} from "./context/render-background.js";
export { createControlMemoryLifecycle } from "./lifecycle/control-lifecycle.js";
export { createMemoryRuntime, type MemoryRuntime } from "./memory-runtime.js";
export { createMemoryRuntimeHealthTracker, type MemoryRuntimeHealthTracker } from "./runtime-health.js";
export {
  ADMISSION_REASON,
  resolveEffectiveMemoryAdmission,
  type EffectiveAdmissionInput,
} from "./policy/effective-admission.js";
export {
  POLICY_KEY,
  spaceParticipationKey,
} from "./policy/policy-snapshot.js";
export {
  createSqliteMemoryControlRepository,
  MEMORY_MIGRATIONS,
  type AcceptConversationSignalInput,
  type ClaimJobInput,
  type FinishJobInput,
  type MemoryControlRepository,
  type SetPolicyInput,
} from "./store/control-repository.js";
export {
  contentHashOf,
  createSqliteMemoryDocumentRepository,
  type CommitMaintenanceBatchInput,
  type CommitMaintenanceBatchResult,
  type MemoryDocumentRepository,
  type RecordUserEditInput,
  type TranscriptIndexEntry,
} from "./store/content-repository.js";
export { memoryOwnerFromKey } from "./store/owner-keys.js";
export {
  type MemoryJobRow,
  type MemoryLifecycleRow,
  type MemoryPolicyRow,
  type MemorySpaceDocRow,
  type MemorySummaryRow,
  type MemoryCaptureProgressRow,
  type MemoryTranscriptCoverageRow,
  type PersistedFenceState,
  type PersistedJobStatus,
  type PersistedPolicyKind,
} from "./store/persistence-schema.js";
export {
  createMemoryBackgroundPort,
} from "./background/background-port.js";
export {
  createMemoryHistoryQueryPort,
  HISTORY_READ_DEFAULT_TOKENS,
  HISTORY_READ_MAX_TOKENS,
  HISTORY_SEARCH_MAX_ITEMS,
  type HistoryConversationLookup,
} from "./history/history-query-port.js";
export {
  createMemoryCaptureRuntime,
  MAINTENANCE_IDLE_DELAY_MS,
} from "./capture/capture-runtime.js";
export {
  buildMaintenanceMessages,
  MAINTENANCE_BATCH_TOKEN_BUDGET,
  MAINTENANCE_MEMORY_MAX_TOKENS,
  MAINTENANCE_PROMPT_REF,
  MAINTENANCE_RETRY_DELAYS_MS,
  MAINTENANCE_SUMMARY_MAX_TOKENS,
  maintainConversationJob,
  defaultCountTokens,
  type MaintenanceDeps,
  type MaintenanceJobOutcome,
} from "./capture/consolidation.js";
export {
  createMemoryAdminApplication,
  type ConversationHighWaterQuery,
  type CreateMemoryAdminApplicationInput,
  type MemoryOwnerExistsQuery,
  type MemoryRuntimeHealthQuery,
} from "./admin/memory-admin-application.js";
export {
  createMemoryFeature,
  type MemoryFeature,
  type MemoryFeatureCommands,
  type MemoryFeatureQueries,
} from "./memory-feature.js";
