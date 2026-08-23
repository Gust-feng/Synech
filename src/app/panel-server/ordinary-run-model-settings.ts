import type {
  OrdinaryCapabilitySnapshot,
  ModelCapabilities,
  ModelRunReasoningEffort,
  SanitizedModelProviderConfig,
} from "../../domain/config/index.js";
import { PanelHttpError } from "./http-utils.js";

/**
 * Applies request-level model controls to the capability facts frozen for an
 * Ordinary run. This is a run-boundary operation, not a Host feature.
 */
export function ordinaryCapabilitySnapshotForRunStart(
  snapshot: OrdinaryCapabilitySnapshot,
  reasoningEffort: ModelRunReasoningEffort | undefined
): OrdinaryCapabilitySnapshot {
  return effectiveOrdinaryCapabilitySnapshotForRun(
    snapshot,
    snapshot.modelCapabilities.supportsReasoningEffort ? reasoningEffort : undefined
  );
}

export function effectiveOrdinaryCapabilitySnapshotForRun(
  snapshot: OrdinaryCapabilitySnapshot,
  reasoningEffort: ModelRunReasoningEffort | undefined
): OrdinaryCapabilitySnapshot {
  const activeModel = activeModelWithRunOpenAISettings(
    snapshot.activeModel,
    snapshot.modelCapabilities,
    reasoningEffort
  );
  return activeModel === snapshot.activeModel ? snapshot : { ...snapshot, activeModel };
}

function activeModelWithRunOpenAISettings(
  activeModel: SanitizedModelProviderConfig,
  modelCapabilities: ModelCapabilities,
  reasoningEffort: ModelRunReasoningEffort | undefined
): SanitizedModelProviderConfig {
  const {
    reasoningEffort: _profileReasoningEffort,
    reasoningSummary: profileReasoningSummary,
    parallelToolCalls: profileParallelToolCalls,
    stream: profileStream,
    ...baseOpenAI
  } = activeModel.openAI ?? {};
  if (reasoningEffort !== undefined && !modelCapabilities.supportsReasoningEffort) {
    throw new PanelHttpError(
      400,
      "unsupported_model_reasoning_effort",
      "当前模型不支持调节思考强度。"
    );
  }
  const openAI = removeUndefinedOpenAISettings({
    ...baseOpenAI,
    ...(modelCapabilities.supportsReasoningEffort && profileReasoningSummary !== undefined
      ? { reasoningSummary: profileReasoningSummary }
      : {}),
    ...(modelCapabilities.supportsParallelToolCalls && profileParallelToolCalls !== undefined
      ? { parallelToolCalls: profileParallelToolCalls }
      : {}),
    ...(profileStream !== undefined || !modelCapabilities.supportsStreaming
      ? { stream: modelCapabilities.supportsStreaming ? profileStream : false }
      : {}),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  });
  return {
    ...activeModel,
    openAI: Object.keys(openAI).length === 0 ? undefined : openAI,
  };
}

function removeUndefinedOpenAISettings<T extends Record<string, unknown>>(settings: T): T {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined)
  ) as T;
}
