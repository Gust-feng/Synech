/** Host composition entry. Not a business API or a route/UI dependency. */
export { createMemoryFeature } from "./memory-feature.js";
export { createMemoryRuntime } from "./memory-runtime.js";
export { createMemoryAdminApplication } from "./admin/memory-admin-application.js";
export { createMemoryDiagnostics } from "./diagnostics/diagnostic-query.js";
export { createMemoryRuntimeHealthTracker } from "./runtime-health.js";
export { createControlMemoryLifecycle } from "./lifecycle/control-lifecycle.js";
export { createMemoryBackgroundPort } from "./background/background-port.js";
export { createMemoryHistoryQueryPort } from "./history/history-query-port.js";
export { createMemoryCaptureRuntime } from "./capture/capture-runtime.js";
export { maintainConversationJob } from "./capture/consolidation.js";
export { createSqliteMemoryControlRepository } from "./store/control-repository.js";
export { createSqliteMemoryDocumentRepository } from "./store/content-repository.js";
export type { MemoryControlRepository } from "./store/control-repository.js";
export type { MemoryDocumentRepository } from "./store/content-repository.js";
export { POLICY_KEY } from "./policy/policy-snapshot.js";
export { ADMISSION_REASON, resolveEffectiveMemoryAdmission } from "./policy/effective-admission.js";
