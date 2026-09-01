// 隐式长期记忆系统（Memory v2）公共 facade。
// Phase 1 切片 1：仅契约与可缺席 No-op 实现，尚未接线、未建 SQLite schema。
export {
  MEMORY_ERROR_CODES,
  MemoryError,
  type CheckpointRef,
  type ClearImplicitMemoryResult,
  type EffectiveMemoryAdmission,
  type EvidenceTurn,
  type EvidenceWindow,
  type MemoryAdminApplication,
  type MemoryCapabilityStatus,
  type MemoryCaptureAcceptance,
  type MemoryCaptureRuntime,
  type MemoryCaptureSignal,
  type MemoryConfirmation,
  type MemoryContextContribution,
  type MemoryContextEntry,
  type MemoryContextProvider,
  type MemoryContributeInput,
  type MemoryErrorCode,
  type MemoryEvidenceClass,
  type MemoryEvidenceRef,
  type MemoryLifecycle,
  type MemoryRecallInput,
  type MemoryRecallPort,
  type MemoryRecallSnapshot,
  type MemoryRecordKind,
  type MemoryRecordStatus,
  type MemoryRolloutMode,
  type MemoryRuntimeHealth,
  type OrdinaryEvidenceReader,
  type PolicyRevision,
  type RecalledMemory,
  type RemovalTicket,
} from "./contracts.js";
export {
  createNoopMemoryCaptureRuntime,
  createNoopMemoryContextProvider,
  createProvenAbsentMemoryLifecycle,
} from "./noop.js";
export {
  IMPLICIT_MEMORY_BLOCK_HEADER,
  renderImplicitMemoryBlock,
} from "./context/render-contribution.js";
export { createControlMemoryLifecycle } from "./lifecycle/control-lifecycle.js";
export { createMemoryRuntime, type MemoryRuntime } from "./memory-runtime.js";
export {
  ADMISSION_REASON,
  resolveEffectiveMemoryAdmission,
  type EffectiveAdmissionInput,
} from "./policy/effective-admission.js";
export {
  createSqliteMemoryControlRepository,
  MEMORY_MIGRATIONS,
  type EnqueueJobInput,
  type MemoryControlRepository,
  type SetPolicyInput,
} from "./store/control-repository.js";
export {
  createSqliteMemoryContentRepository,
  type CommitConsolidationInput,
  type CommitConsolidationResult,
  type ConsolidationRecordInput,
  type MemoryContentRepository,
} from "./store/content-repository.js";
export {
  type MemoryJobRow,
  type MemoryLifecycleRow,
  type MemoryPolicyRow,
  type PersistedFenceState,
  type PersistedJobStatus,
  type PersistedPolicyKind,
} from "./store/persistence-schema.js";
