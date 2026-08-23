import type { SkillDefinition } from "./contracts.js";
import type {
  IntelligenceChannel,
  ModelBudget,
  ModelCallRef,
  ModelOutputValidationResult,
  ModelRequest,
  ModelResponse,
} from "../../domain/intelligence/index.js";
import { createId, nowIso } from "../../kernel/id.js";
import type { SkillCandidateContext } from "./skill-loader.js";

export type SkillRouterCatalogSkill = SkillDefinition & {
  readonly loadError?: string;
  readonly validationStatus?: "valid" | "invalid" | "load_error";
  readonly validationErrors?: readonly string[];
  readonly contentHash?: string;
  readonly bodyHash?: string;
};

export type SkillRouterExplicitRef = {
  readonly token: string;
  readonly skillId?: string;
};

export type SkillRouterSelectionReasonCode =
  | "explicit_invocation"
  | "model_selected"
  | "fallback_keyword_candidate";

export type SkillRouterSelectionReason = {
  readonly code: SkillRouterSelectionReasonCode;
  readonly skillId: string;
  readonly message: string;
  readonly confidence: number;
  readonly token?: string;
};

export type SkillRouterOmittedReasonCode =
  | "disabled"
  | "invalid"
  | "model_invocation_disabled"
  | "missing_from_catalog"
  | "duplicate_catalog_id"
  | "duplicate_model_selection"
  | "missing_candidate_context"
  | "model_not_selected"
  | "fallback_not_selected"
  | "selection_limit";

export type SkillRouterOmittedReason = {
  readonly code: SkillRouterOmittedReasonCode;
  readonly skillId: string;
  readonly message: string;
  readonly token?: string;
};

export type SkillRouterFallbackCode =
  | "model_request_failed"
  | "model_response_failed"
  | "model_output_invalid";

export type SkillRouterRequestRef = {
  readonly requestId: string;
  readonly traceId: string;
  readonly callerRef: string;
};

export type SkillRouterResultSource = "model" | "fallback" | "explicit_only" | "empty";

export type SkillRouterResult = {
  readonly source: SkillRouterResultSource;
  readonly selectedSkillIds: readonly string[];
  readonly selectionReasons: readonly SkillRouterSelectionReason[];
  readonly omittedReasons: readonly SkillRouterOmittedReason[];
  readonly confidence: number;
  readonly fallback: boolean;
  readonly fallbackReason?: SkillRouterFallbackCode;
  readonly modelRequestRef?: SkillRouterRequestRef;
  readonly modelCallRef?: ModelCallRef;
  readonly validationIssues: readonly SkillRouterValidationIssue[];
};

export type SkillRouterValidationIssue = {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
};

export type SkillRouterInput = {
  readonly goal: string;
  readonly historySummary?: string;
  readonly catalog: readonly SkillRouterCatalogSkill[];
  readonly candidateContexts: readonly SkillCandidateContext[];
  readonly explicitRefs?: readonly SkillRouterExplicitRef[];
  readonly explicitSkillIds?: readonly string[];
  readonly keywordCandidateSkillIds?: readonly string[];
  readonly limit?: number;
  readonly intelligenceChannel: IntelligenceChannel;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly callerRef?: string;
  readonly requestedAt?: string;
  readonly budget?: ModelBudget;
  readonly abortSignal?: AbortSignal;
};

type CatalogRecord = {
  readonly skill: SkillRouterCatalogSkill;
  readonly index: number;
};

type ExplicitSelection = {
  readonly skillId: string;
  readonly token?: string;
};

type ParsedModelRouterOutput = {
  readonly selectedSkillIds: readonly string[];
  readonly reasons: ReadonlyMap<string, ParsedModelRouterReason>;
  readonly confidence?: number;
};

type ParsedModelRouterReason = {
  readonly reason?: string;
  readonly confidence?: number;
};

type ModelRoutingAttempt =
  | {
      readonly ok: true;
      readonly requestRef: SkillRouterRequestRef;
      readonly callRef: ModelCallRef;
      readonly output: ParsedModelRouterOutput;
    }
  | {
      readonly ok: false;
      readonly requestRef: SkillRouterRequestRef;
      readonly callRef?: ModelCallRef;
      readonly fallbackReason: SkillRouterFallbackCode;
      readonly issues: readonly SkillRouterValidationIssue[];
    };

const DEFAULT_SKILL_SELECTION_LIMIT = 4;
const DEFAULT_ROUTER_BUDGET: ModelBudget = {
  maxOutputTokens: 600,
  maxLatencyMs: 30_000,
};

export async function routeSkillsWithModel(input: SkillRouterInput): Promise<SkillRouterResult> {
  const limit = normalizeLimit(input.limit ?? DEFAULT_SKILL_SELECTION_LIMIT);
  const catalog = buildCatalog(input.catalog);
  const candidateContexts = filterCandidateContexts(input.candidateContexts, catalog);
  const explicitSelections = resolveExplicitSelections(input, catalog);
  const explicitAvailable = explicitSelections.filter((selection) => isSelectable(catalog.recordsById.get(selection.skillId)));
  const omittedReasons: SkillRouterOmittedReason[] = [
    ...catalog.omittedReasons,
    ...unavailableExplicitReasons(explicitSelections, catalog),
    ...unavailableCandidateContextReasons(input.candidateContexts, catalog),
  ];

  const explicitAvailableIds = new Set(explicitAvailable.map((selection) => selection.skillId));
  const modelCandidateContexts = candidateContexts.filter((context) => {
    const record = catalog.recordsById.get(context.skillId);
    const explicit = explicitAvailableIds.has(context.skillId);
    if (record === undefined || !isSelectable(record)) {
      return false;
    }
    if (!explicit && record.skill.disableModelInvocation === true) {
      omittedReasons.push({
        code: "model_invocation_disabled",
        skillId: record.skill.id,
        message: `Skill "${record.skill.id}" disables model invocation and was not sent to the router.`,
      });
      return false;
    }
    return true;
  });
  const candidateContextIds = new Set(modelCandidateContexts.map((context) => context.skillId));
  if (modelCandidateContexts.length === 0) {
    return finalizeSelection({
      source: explicitAvailable.length > 0 ? "explicit_only" : "empty",
      selected: explicitAvailable.map((selection) => explicitReason(selection, 1)),
      omittedReasons,
      limit,
      candidateContextIds,
      modelSelectedIds: [],
      fallback: false,
      validationIssues: [],
    });
  }

  const attempt = await requestModelRouting({
    input,
    limit,
    explicitSkillIds: explicitAvailable.map((selection) => selection.skillId),
    candidateContexts: modelCandidateContexts,
  });

  if (!attempt.ok) {
    return finalizeSelection({
      source: "fallback",
      selected: [
        ...explicitAvailable.map((selection) => explicitReason(selection, 1)),
        ...fallbackKeywordReasons(input, catalog, explicitAvailable.map((selection) => selection.skillId)),
      ],
      omittedReasons,
      limit,
      candidateContextIds,
      modelSelectedIds: [],
      fallback: true,
      fallbackReason: attempt.fallbackReason,
      modelRequestRef: attempt.requestRef,
      modelCallRef: attempt.callRef,
      validationIssues: attempt.issues,
    });
  }

  const modelReasons = modelSelectionReasons({
    modelOutput: attempt.output,
    catalog,
    candidateContextIds,
    explicitSkillIds: new Set(explicitAvailable.map((selection) => selection.skillId)),
    omittedReasons,
  });

  const selectedReasons = [
    ...explicitAvailable.map((selection) => explicitReason(selection, 1)),
    ...modelReasons,
  ];

  return finalizeSelection({
    source: selectedReasons.length > 0 ? "model" : "empty",
    selected: selectedReasons,
    omittedReasons,
    limit,
    candidateContextIds,
    modelSelectedIds: attempt.output.selectedSkillIds,
    fallback: false,
    modelRequestRef: attempt.requestRef,
    modelCallRef: attempt.callRef,
    validationIssues: [],
    modelConfidence: attempt.output.confidence,
  });
}

function buildCatalog(catalog: readonly SkillRouterCatalogSkill[]): {
  readonly recordsById: ReadonlyMap<string, CatalogRecord>;
  readonly omittedReasons: readonly SkillRouterOmittedReason[];
} {
  const recordsById = new Map<string, CatalogRecord>();
  const omittedReasons: SkillRouterOmittedReason[] = [];
  const sorted = catalog
    .map((skill, index) => ({ skill, index }))
    .sort(compareCatalogRecords);
  for (const record of sorted) {
    const previous = recordsById.get(record.skill.id);
    if (previous !== undefined) {
      omittedReasons.push({
        code: "duplicate_catalog_id",
        skillId: record.skill.id,
        message: `Skill "${record.skill.id}" duplicates frozen catalog id "${previous.skill.id}" and was ignored by source precedence.`,
      });
      continue;
    }
    recordsById.set(record.skill.id, record);
    if (!record.skill.enabled) {
      omittedReasons.push({
        code: "disabled",
        skillId: record.skill.id,
        message: `Skill "${record.skill.id}" is disabled in the frozen catalog.`,
      });
      continue;
    }
    if (!isValidSkill(record.skill)) {
      omittedReasons.push({
        code: "invalid",
        skillId: record.skill.id,
        message: `Skill "${record.skill.id}" is invalid in the frozen catalog.`,
      });
    }
  }
  return { recordsById, omittedReasons };
}

function compareCatalogRecords(left: CatalogRecord, right: CatalogRecord): number {
  return skillSourcePrecedence(right.skill) - skillSourcePrecedence(left.skill) ||
    left.skill.id.localeCompare(right.skill.id) ||
    left.index - right.index;
}

function skillSourcePrecedence(skill: SkillRouterCatalogSkill): number {
  return typeof skill.sourcePrecedence === "number" && Number.isFinite(skill.sourcePrecedence)
    ? skill.sourcePrecedence
    : 0;
}

function filterCandidateContexts(
  contexts: readonly SkillCandidateContext[],
  catalog: ReturnType<typeof buildCatalog>
): readonly SkillCandidateContext[] {
  const seen = new Set<string>();
  const result: SkillCandidateContext[] = [];
  for (const context of contexts) {
    if (seen.has(context.skillId)) {
      continue;
    }
    seen.add(context.skillId);
    const record = catalog.recordsById.get(context.skillId);
    if (isSelectable(record)) {
      result.push(context);
    }
  }
  return result;
}

function unavailableCandidateContextReasons(
  contexts: readonly SkillCandidateContext[],
  catalog: ReturnType<typeof buildCatalog>
): readonly SkillRouterOmittedReason[] {
  const reasons: SkillRouterOmittedReason[] = [];
  const seen = new Set<string>();
  for (const context of contexts) {
    if (seen.has(context.skillId)) {
      continue;
    }
    seen.add(context.skillId);
    const record = catalog.recordsById.get(context.skillId);
    if (record === undefined) {
      reasons.push({
        code: "missing_from_catalog",
        skillId: context.skillId,
        message: `Skill candidate "${context.skillId}" is not in the frozen catalog.`,
      });
      continue;
    }
    if (!isSelectable(record)) {
      reasons.push(unavailableReason(record.skill));
    }
  }
  return reasons;
}

function resolveExplicitSelections(
  input: Pick<SkillRouterInput, "goal" | "catalog" | "candidateContexts" | "explicitRefs" | "explicitSkillIds">,
  catalog: ReturnType<typeof buildCatalog>
): readonly ExplicitSelection[] {
  const selections: ExplicitSelection[] = [];
  const explicitRefs = [
    ...extractExplicitRefs(input.goal),
    ...(input.explicitRefs ?? []),
    ...input.candidateContexts
      .filter((context) => context.explicit)
      .map((context) => ({ token: context.skillId, skillId: context.skillId })),
    ...(input.explicitSkillIds ?? []).map((skillId) => ({ token: skillId, skillId })),
  ];

  for (const ref of explicitRefs) {
    const skillId = ref.skillId ?? matchExplicitToken(ref.token, input.catalog);
    if (skillId !== undefined) {
      selections.push({ skillId, token: ref.token });
    } else {
      selections.push({ skillId: ref.token, token: ref.token });
    }
  }
  return dedupeExplicitSelections(selections, catalog);
}

function dedupeExplicitSelections(
  selections: readonly ExplicitSelection[],
  catalog: ReturnType<typeof buildCatalog>
): readonly ExplicitSelection[] {
  const result: ExplicitSelection[] = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    const skillId = catalog.recordsById.get(selection.skillId)?.skill.id ?? selection.skillId;
    if (seen.has(skillId)) {
      continue;
    }
    seen.add(skillId);
    result.push({ skillId, token: selection.token });
  }
  return result;
}

function unavailableExplicitReasons(
  selections: readonly ExplicitSelection[],
  catalog: ReturnType<typeof buildCatalog>
): readonly SkillRouterOmittedReason[] {
  return selections.flatMap((selection) => {
    const record = catalog.recordsById.get(selection.skillId);
    if (record === undefined) {
      return [{
        code: "missing_from_catalog" as const,
        skillId: selection.skillId,
        token: selection.token,
        message: `Explicit skill reference "$${selection.token ?? selection.skillId}" is not in the frozen catalog.`,
      }];
    }
    return isSelectable(record) ? [] : [{ ...unavailableReason(record.skill), token: selection.token }];
  });
}

async function requestModelRouting(input: {
  readonly input: SkillRouterInput;
  readonly limit: number;
  readonly explicitSkillIds: readonly string[];
  readonly candidateContexts: readonly SkillCandidateContext[];
}): Promise<ModelRoutingAttempt> {
  const request = createSkillRouterModelRequest(input);
  const requestRef: SkillRouterRequestRef = {
    requestId: request.requestId,
    traceId: request.traceId,
    callerRef: String(request.callerRef),
  };

  let response: ModelResponse;
  try {
    response = await input.input.intelligenceChannel.request(request, {
      abortSignal: input.input.abortSignal,
    });
  } catch (error) {
    return {
      ok: false,
      requestRef,
      fallbackReason: "model_request_failed",
      issues: [{
        code: "SKILL_ROUTER_MODEL_REQUEST_FAILED",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }

  const callRef = modelCallRef(response);
  if (response.status !== "completed" || response.validation.status !== "passed") {
    return {
      ok: false,
      requestRef,
      callRef,
      fallbackReason: "model_response_failed",
      issues: validationIssues(response.validation, response.failure?.message ?? "Skill router model response failed."),
    };
  }

  const parsed = parseModelRouterOutput(response.structuredOutput ?? response.textOutput);
  if (parsed.issues.length > 0 || parsed.output === undefined) {
    return {
      ok: false,
      requestRef,
      callRef,
      fallbackReason: "model_output_invalid",
      issues: parsed.issues,
    };
  }

  return {
    ok: true,
    requestRef,
    callRef,
    output: parsed.output,
  };
}

function createSkillRouterModelRequest(input: {
  readonly input: SkillRouterInput;
  readonly limit: number;
  readonly explicitSkillIds: readonly string[];
  readonly candidateContexts: readonly SkillCandidateContext[];
}): ModelRequest {
  return {
    requestId: input.input.requestId ?? createId("skill-router-request"),
    traceId: input.input.traceId ?? createId("skill-router-trace"),
    callerRef: input.input.callerRef ?? "skill-router",
    purpose: "skill_routing",
    inputRefs: [],
    sanitizedMessages: [
      {
        role: "system",
        content: [
          "Select skill ids for an Ordinary Agent run.",
          "Use only candidate skill ids listed in the user message.",
          "Do not request tools. Return a JSON object with selectedSkillIds, reasons, and confidence.",
          "selectedSkillIds must be a string array. reasons may include { skillId, reason, confidence }.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          goal: input.input.goal,
          historySummary: input.input.historySummary,
          selectionLimit: input.limit,
          explicitSkillIds: input.explicitSkillIds,
          remainingSelectionSlots: Math.max(0, input.limit - input.explicitSkillIds.length),
          candidates: input.candidateContexts.map((context) => safeCandidateMetadataForModel(context, input.input.catalog)),
        }),
      },
    ],
    tools: [],
    toolChoice: "none",
    outputContract: {
      contractId: "skill-router.selection.v1",
      outputKind: "candidate",
      format: "json_object",
      requiredFields: ["selectedSkillIds"],
    },
    budget: input.input.budget ?? DEFAULT_ROUTER_BUDGET,
    sensitivity: "internal",
    requestedAt: input.input.requestedAt ?? nowIso(),
  };
}

function safeCandidateMetadataForModel(
  context: SkillCandidateContext,
  catalog: readonly SkillRouterCatalogSkill[]
): Readonly<Record<string, unknown>> {
  const skill = bestCatalogSkillForModel(context.skillId, catalog);
  return {
    skillId: context.skillId,
    skillName: context.skillName,
    description: skill?.description ?? "",
    whenToUse: skill?.whenToUse,
    summary: skill?.summary,
    category: skill?.category,
    sourceKind: skill?.sourceKind ?? context.sourceKind,
    sourceRootId: skill?.sourceRootId ?? context.sourceRootId,
    sourcePrecedence: skill?.sourcePrecedence ?? context.sourcePrecedence,
    disableModelInvocation: skill?.disableModelInvocation === true,
    userInvocable: skill?.userInvocable !== false,
    triggers: skill?.triggers ?? [],
    explicit: context.explicit,
    keywordScore: context.keywordScore,
    descriptionTruncated: context.descriptionTruncated,
  };
}

function bestCatalogSkillForModel(
  skillId: string,
  catalog: readonly SkillRouterCatalogSkill[]
): SkillRouterCatalogSkill | undefined {
  let best: SkillRouterCatalogSkill | undefined;
  for (const skill of catalog) {
    if (skill.id !== skillId) {
      continue;
    }
    if (best === undefined || skillSourcePrecedence(skill) > skillSourcePrecedence(best)) {
      best = skill;
    }
  }
  return best;
}

function modelSelectionReasons(input: {
  readonly modelOutput: ParsedModelRouterOutput;
  readonly catalog: ReturnType<typeof buildCatalog>;
  readonly candidateContextIds: ReadonlySet<string>;
  readonly explicitSkillIds: ReadonlySet<string>;
  readonly omittedReasons: SkillRouterOmittedReason[];
}): readonly SkillRouterSelectionReason[] {
  const selected: SkillRouterSelectionReason[] = [];
  const seen = new Set<string>();
  for (const skillId of input.modelOutput.selectedSkillIds) {
    const record = input.catalog.recordsById.get(skillId);
    if (record === undefined) {
      input.omittedReasons.push({
        code: "missing_from_catalog",
        skillId,
        message: `Model selected skill "${skillId}", but it is not in the frozen catalog.`,
      });
      continue;
    }
    if (seen.has(skillId)) {
      input.omittedReasons.push({
        code: "duplicate_model_selection",
        skillId,
        message: `Model selected skill "${skillId}" more than once.`,
      });
      continue;
    }
    seen.add(skillId);
    if (!isSelectable(record)) {
      input.omittedReasons.push(unavailableReason(record.skill));
      continue;
    }
    if (!input.candidateContextIds.has(skillId) && !input.explicitSkillIds.has(skillId)) {
      input.omittedReasons.push({
        code: "missing_candidate_context",
        skillId,
        message: `Model selected skill "${skillId}", but no safe candidate context was provided.`,
      });
      continue;
    }
    if (input.explicitSkillIds.has(skillId)) {
      continue;
    }
    const reason = input.modelOutput.reasons.get(skillId);
    selected.push({
      code: "model_selected",
      skillId,
      message: reason?.reason ?? `Model selected skill "${skillId}".`,
      confidence: clampConfidence(reason?.confidence ?? input.modelOutput.confidence ?? 0.6),
    });
  }
  return selected;
}

function fallbackKeywordReasons(
  input: Pick<SkillRouterInput, "keywordCandidateSkillIds" | "candidateContexts">,
  catalog: ReturnType<typeof buildCatalog>,
  alreadySelectedIds: readonly string[]
): readonly SkillRouterSelectionReason[] {
  const alreadySelected = new Set(alreadySelectedIds);
  return keywordCandidateIds(input, catalog)
    .filter((skillId) => !alreadySelected.has(skillId))
    .map((skillId) => ({
      code: "fallback_keyword_candidate" as const,
      skillId,
      message: `Fallback selected keyword candidate skill "${skillId}".`,
      confidence: 0.45,
    }));
}

function keywordCandidateIds(
  input: Pick<SkillRouterInput, "keywordCandidateSkillIds" | "candidateContexts">,
  catalog: ReturnType<typeof buildCatalog>
): readonly string[] {
  const explicit = new Set(input.keywordCandidateSkillIds ?? []);
  const scored = input.candidateContexts
    .filter((context) => context.keywordScore > 0 || explicit.has(context.skillId))
    .filter((context) => isAutomaticFallbackSelectable(catalog.recordsById.get(context.skillId)))
    .sort((left, right) =>
      right.keywordScore - left.keywordScore ||
      (catalog.recordsById.get(left.skillId)?.index ?? 0) - (catalog.recordsById.get(right.skillId)?.index ?? 0)
    )
    .map((context) => context.skillId);
  return [...new Set([...(input.keywordCandidateSkillIds ?? []), ...scored])]
    .filter((skillId) => isAutomaticFallbackSelectable(catalog.recordsById.get(skillId)));
}

function isAutomaticFallbackSelectable(record: CatalogRecord | undefined): boolean {
  return record !== undefined && isSelectable(record) && record.skill.disableModelInvocation !== true;
}

function finalizeSelection(input: {
  readonly source: SkillRouterResultSource;
  readonly selected: readonly SkillRouterSelectionReason[];
  readonly omittedReasons: readonly SkillRouterOmittedReason[];
  readonly limit: number;
  readonly candidateContextIds: ReadonlySet<string>;
  readonly modelSelectedIds: readonly string[];
  readonly fallback: boolean;
  readonly fallbackReason?: SkillRouterFallbackCode;
  readonly modelRequestRef?: SkillRouterRequestRef;
  readonly modelCallRef?: ModelCallRef;
  readonly validationIssues: readonly SkillRouterValidationIssue[];
  readonly modelConfidence?: number;
}): SkillRouterResult {
  const deduped = dedupeSelectionReasons(input.selected);
  const selected = deduped.slice(0, input.limit);
  const selectedIds = new Set(selected.map((reason) => reason.skillId));
  const attemptedSelectedIds = new Set(deduped.map((reason) => reason.skillId));
  const omittedReasons = [
    ...input.omittedReasons,
    ...deduped.slice(input.limit).map((reason): SkillRouterOmittedReason => ({
      code: "selection_limit",
      skillId: reason.skillId,
      token: reason.token,
      message: `Skill "${reason.skillId}" was omitted by the selection limit.`,
    })),
    ...notSelectedCandidateReasons({
      source: input.fallback ? "fallback" : "model",
      candidateContextIds: input.candidateContextIds,
      selectedIds,
      attemptedSelectedIds,
      modelSelectedIds: input.modelSelectedIds,
    }),
  ];
  const source = selected.length === 0 && input.source !== "fallback" ? "empty" : input.source;
  return {
    source,
    selectedSkillIds: selected.map((reason) => reason.skillId),
    selectionReasons: selected,
    omittedReasons: dedupeOmittedReasons(omittedReasons),
    confidence: confidenceForSelection(selected, input),
    fallback: input.fallback,
    fallbackReason: input.fallbackReason,
    modelRequestRef: input.modelRequestRef,
    modelCallRef: input.modelCallRef,
    validationIssues: input.validationIssues,
  };
}

function notSelectedCandidateReasons(input: {
  readonly source: "model" | "fallback";
  readonly candidateContextIds: ReadonlySet<string>;
  readonly selectedIds: ReadonlySet<string>;
  readonly attemptedSelectedIds: ReadonlySet<string>;
  readonly modelSelectedIds: readonly string[];
}): readonly SkillRouterOmittedReason[] {
  const modelSelected = new Set(input.modelSelectedIds);
  const code = input.source === "model" ? "model_not_selected" : "fallback_not_selected";
  const result: SkillRouterOmittedReason[] = [];
  for (const skillId of input.candidateContextIds) {
    if (input.selectedIds.has(skillId) || input.attemptedSelectedIds.has(skillId) || modelSelected.has(skillId)) {
      continue;
    }
    result.push({
      code,
      skillId,
      message: input.source === "model"
        ? `Model did not select skill "${skillId}".`
        : `Fallback did not select skill "${skillId}".`,
    });
  }
  return result;
}

function parseModelRouterOutput(output: unknown): {
  readonly output?: ParsedModelRouterOutput;
  readonly issues: readonly SkillRouterValidationIssue[];
} {
  const record = typeof output === "string" ? parseJsonObject(output) : asRecord(output);
  if (record === undefined) {
    return {
      issues: [{
        code: "SKILL_ROUTER_OUTPUT_NOT_OBJECT",
        message: "Skill router model output must be a JSON object.",
        path: "$",
      }],
    };
  }
  const rawIds = record.selectedSkillIds;
  if (!Array.isArray(rawIds)) {
    return {
      issues: [{
        code: "SKILL_ROUTER_SELECTED_IDS_NOT_ARRAY",
        message: "Skill router model output selectedSkillIds must be an array.",
        path: "selectedSkillIds",
      }],
    };
  }
  const selectedSkillIds = rawIds
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  const reasons = new Map<string, ParsedModelRouterReason>();
  if (Array.isArray(record.reasons)) {
    for (const item of record.reasons) {
      const reasonRecord = asRecord(item);
      const skillId = typeof reasonRecord?.skillId === "string" ? reasonRecord.skillId.trim() : "";
      if (skillId.length === 0) {
        continue;
      }
      reasons.set(skillId, {
        reason: typeof reasonRecord?.reason === "string" ? reasonRecord.reason.trim() : undefined,
        confidence: typeof reasonRecord?.confidence === "number" && Number.isFinite(reasonRecord.confidence)
          ? reasonRecord.confidence
          : undefined,
      });
    }
  }
  return {
    output: {
      selectedSkillIds,
      reasons,
      confidence: typeof record.confidence === "number" && Number.isFinite(record.confidence)
        ? clampConfidence(record.confidence)
        : undefined,
    },
    issues: [],
  };
}

function extractExplicitRefs(goal: string): readonly SkillRouterExplicitRef[] {
  const refs: SkillRouterExplicitRef[] = [];
  for (const match of goal.matchAll(/\$([A-Za-z0-9][A-Za-z0-9_-]*)/g)) {
    const token = match[1]?.trim();
    if (token !== undefined && token.length > 0) {
      refs.push({ token });
    }
  }
  return refs;
}

function matchExplicitToken(token: string, catalog: readonly SkillRouterCatalogSkill[]): string | undefined {
  const key = normalizeSkillId(token);
  const match = catalog.find((skill) => normalizeSkillId(skill.id) === key || normalizeSkillId(skill.name) === key);
  return match?.id;
}

function explicitReason(selection: ExplicitSelection, confidence: number): SkillRouterSelectionReason {
  return {
    code: "explicit_invocation",
    skillId: selection.skillId,
    token: selection.token,
    message: selection.token === undefined
      ? `Skill "${selection.skillId}" was explicitly requested.`
      : `Skill "${selection.skillId}" was explicitly requested with $${selection.token}.`,
    confidence,
  };
}

function unavailableReason(skill: SkillRouterCatalogSkill): SkillRouterOmittedReason {
  if (!skill.enabled) {
    return {
      code: "disabled",
      skillId: skill.id,
      message: `Skill "${skill.id}" is disabled in the frozen catalog.`,
    };
  }
  return {
    code: "invalid",
    skillId: skill.id,
    message: `Skill "${skill.id}" is invalid in the frozen catalog.`,
  };
}

function isSelectable(record: CatalogRecord | undefined): boolean {
  return record !== undefined && record.skill.enabled && isValidSkill(record.skill);
}

function isValidSkill(skill: SkillRouterCatalogSkill): boolean {
  if (skill.validationStatus === "invalid" || skill.validationStatus === "load_error") {
    return false;
  }
  if (typeof skill.loadError === "string" && skill.loadError.trim().length > 0) {
    return false;
  }
  return (skill.validationErrors?.length ?? 0) === 0;
}

function normalizeLimit(value: number): number {
  if (value === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function confidenceForSelection(
  selected: readonly SkillRouterSelectionReason[],
  input: Pick<Parameters<typeof finalizeSelection>[0], "fallback" | "modelConfidence">
): number {
  if (selected.length === 0) {
    return 0;
  }
  if (!input.fallback && input.modelConfidence !== undefined) {
    return clampConfidence(input.modelConfidence);
  }
  const average = selected.reduce((sum, reason) => sum + reason.confidence, 0) / selected.length;
  return clampConfidence(average);
}

function modelCallRef(response: ModelResponse): ModelCallRef {
  return {
    requestId: response.requestId,
    responseId: response.responseId,
    providerId: response.providerId,
    model: response.model,
    outputKind: response.outputKind,
    eventRefs: [],
    validationStatus: response.validation.status,
  };
}

function validationIssues(
  validation: ModelOutputValidationResult,
  fallbackMessage: string
): readonly SkillRouterValidationIssue[] {
  if (validation.issues.length > 0) {
    return validation.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path,
    }));
  }
  return [{
    code: "SKILL_ROUTER_MODEL_RESPONSE_FAILED",
    message: fallbackMessage,
  }];
}

function dedupeSelectionReasons(reasons: readonly SkillRouterSelectionReason[]): readonly SkillRouterSelectionReason[] {
  const seen = new Set<string>();
  const result: SkillRouterSelectionReason[] = [];
  for (const reason of reasons) {
    if (seen.has(reason.skillId)) {
      continue;
    }
    seen.add(reason.skillId);
    result.push(reason);
  }
  return result;
}

function dedupeOmittedReasons(reasons: readonly SkillRouterOmittedReason[]): readonly SkillRouterOmittedReason[] {
  const seen = new Set<string>();
  const result: SkillRouterOmittedReason[] = [];
  for (const reason of reasons) {
    const key = `${reason.code}:${reason.skillId}:${reason.token ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(reason);
  }
  return result;
}

function parseJsonObject(value: string): Readonly<Record<string, unknown>> | undefined {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function normalizeSkillId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}
