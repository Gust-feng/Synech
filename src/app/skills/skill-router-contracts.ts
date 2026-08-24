import type { SkillDefinition } from "./contracts.js";
import type {
  IntelligenceChannel,
  ModelBudget,
  ModelCallRef,
} from "../../domain/intelligence/index.js";
import type { SkillCandidateContext } from "./skill-selection.js";

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
export type CatalogRecord = {
  readonly skill: SkillRouterCatalogSkill;
  readonly index: number;
};
export type ExplicitSelection = {
  readonly skillId: string;
  readonly token?: string;
};
export type ParsedModelRouterOutput = {
  readonly selectedSkillIds: readonly string[];
  readonly reasons: ReadonlyMap<string, ParsedModelRouterReason>;
  readonly confidence?: number;
};
export type ParsedModelRouterReason = {
  readonly reason?: string;
  readonly confidence?: number;
};
export type ModelRoutingAttempt =
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
