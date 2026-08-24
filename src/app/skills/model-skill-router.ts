import type {
  ModelBudget,
  ModelCallRef,
  ModelOutputValidationResult,
  ModelRequest,
  ModelResponse,
} from "../../domain/intelligence/index.js";
import { createId, nowIso } from "../../kernel/id.js";
import type { SkillCandidateContext } from "./skill-selection.js";
import type {
  ModelRoutingAttempt,
  SkillRouterInput,
  SkillRouterOmittedReason,
  SkillRouterRequestRef,
  SkillRouterResult,
  SkillRouterValidationIssue,
} from "./skill-router-contracts.js";
import {
  buildCatalog,
  explicitReason,
  fallbackKeywordReasons,
  filterCandidateContexts,
  finalizeSelection,
  isSelectable,
  modelSelectionReasons,
  normalizeLimit,
  parseModelRouterOutput,
  resolveExplicitSelections,
  safeCandidateMetadataForModel,
  unavailableCandidateContextReasons,
  unavailableExplicitReasons,
} from "./skill-router-selection.js";

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
          "Select skill ids for this Agent run.",
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
