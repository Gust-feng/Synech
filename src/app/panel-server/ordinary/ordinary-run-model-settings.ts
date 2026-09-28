import type {
  OrdinaryCapabilitySnapshot,
  ModelRunReasoningEffort,
  ResolvedModelCapabilities,
  SanitizedModelProviderConfig,
} from "../../../domain/config/index.js";
import { isConfirmedModelFacts, resolvedSupportsParallelToolCalls, resolvedSupportsReasoningEffort } from "../../../domain/config/index.js";
import { PanelHttpError } from "../http-utils.js";

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
    resolvedSupportsReasoningEffort(snapshot.modelCapabilities) ? reasoningEffort : undefined
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
  modelCapabilities: ResolvedModelCapabilities,
  reasoningEffort: ModelRunReasoningEffort | undefined
): SanitizedModelProviderConfig {
  const {
    reasoningEffort: _profileReasoningEffort,
    reasoningSummary: profileReasoningSummary,
    parallelToolCalls: profileParallelToolCalls,
    ...baseOpenAI
  } = activeModel.openAI ?? {};
  // 只有「已知模型的已确认能力」与请求矛盾时才拒绝；未确认模型不得被运行阻断。
  if (reasoningEffort !== undefined &&
    !resolvedSupportsReasoningEffort(modelCapabilities) &&
    isConfirmedModelFacts(modelCapabilities.facts)) {
    throw new PanelHttpError(
      400,
      "unsupported_model_reasoning_effort",
      "当前模型不支持调节思考强度。"
    );
  }
  const supportsReasoningEffort = resolvedSupportsReasoningEffort(modelCapabilities);
  const supportsParallelToolCalls = resolvedSupportsParallelToolCalls(modelCapabilities);
  const openAI = removeUndefinedOpenAISettings({
    ...baseOpenAI,
    ...(supportsReasoningEffort && profileReasoningSummary !== undefined
      ? { reasoningSummary: profileReasoningSummary }
      : {}),
    ...(supportsParallelToolCalls && profileParallelToolCalls !== undefined
      ? { parallelToolCalls: profileParallelToolCalls }
      : {}),
    ...(reasoningEffort === undefined || !supportsReasoningEffort ? {} : { reasoningEffort }),
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
