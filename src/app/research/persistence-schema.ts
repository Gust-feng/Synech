import { z } from "zod";

import type {
  ResearchActionEvent,
  ResearchActionEventDraft,
  ResearchBrief,
  ResearchBriefDraft,
  ResearchCheckpointSummaryPayload,
  ResearchCitationCheck,
  ResearchCitationCheckDraft,
  ResearchClaim,
  ResearchClaimDraft,
  ResearchClaimRead,
  ResearchConflict,
  ResearchConflictDraft,
  ResearchCoverageRound,
  ResearchEvidenceItem,
  ResearchEvidenceItemDraft,
  ResearchEvidenceItemRead,
  ResearchFetchAttemptPayload,
  ResearchGap,
  ResearchGapDraft,
  ResearchModelContentPayload,
  ResearchObservationBatch,
  ResearchObservationResult,
  ResearchPlan,
  ResearchQuestionEdge,
  ResearchQuestionEdgeDraft,
  ResearchQuestionNode,
  ResearchQuestionNodeDraft,
  ResearchQuestionNodeRead,
  ResearchQueryRecord,
  ResearchReport,
  ResearchReportSpan,
  ResearchReportSpanDraft,
  ResearchResourceStateChangePayload,
  ResearchScopeApproval,
  ResearchSearchAttemptPayload,
  ResearchSearchOutcomePayload,
  ResearchSourceEntry,
  ResearchSourceEntryDraft,
  ResearchSourceFetchPayload,
  ResearchSource,
  ResearchStopAssessmentPayload,
  ResearchTask,
  ResearchTaskSummary,
  ResearchUsage,
} from "./contracts.js";

/**
 * 从 SQLite 读出的每一行都经此校验：`as` 断言不构成运行时保证，
 * 库被外部改写或 schema 漂移必须在读取点明确失败。
 */

const id = z.string().min(1);
const timestamp = z.number().finite();

const questionSchema = z.object({
  id,
  text: z.string(),
  priority: z.enum(["high", "normal"]),
}).strict();

const planSchema = z.object({
  objective: z.string(),
  questions: z.array(questionSchema).min(1),
}).strict();

const coverageRoundSchema = z.object({
  round: z.number().int().min(1),
  answers: z.array(z.object({
    questionId: id,
    coverage: z.enum(["supported", "partial", "contested", "unanswered"]),
    text: z.string(),
    gaps: z.array(z.string()),
  }).strict()),
}).strict();

const usageSchema = z.object({
  searchRequests: z.number().int().min(0),
  fetchRequests: z.number().int().min(0),
  modelRequests: z.number().int().min(0),
  inputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable(),
  elapsedMs: z.number().int().min(0),
}).strict();

const scopeApprovalSchema = z.object({
  payloadHash: z.string().min(1),
  approvedAt: timestamp,
  conversationRef: z.string().min(1),
  scopeSearchDisclosure: z.object({
    snippetSearches: z.number().int().min(0),
  }).strict().optional(),
}).strict();

const taskSchema = z.object({
  id,
  question: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "interrupted", "cancelled"]),
  stage: z.enum(["planning", "searching", "reading", "analyzing", "writing"]).nullable(),
  plan: planSchema.nullable(),
  coverage: z.array(coverageRoundSchema),
  reportTitle: z.string().nullable(),
  reportMarkdown: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  usage: usageSchema,
  createdAt: timestamp,
  startedAt: timestamp.nullable(),
  endedAt: timestamp.nullable(),
  completion: z.enum(["normal", "forced", "incomplete"]).nullable(),
  reason: z.string().nullable(),
  ceilingHit: z.enum(["wall_clock", "external_actions", "no_progress"]).nullable(),
  scopeApproval: scopeApprovalSchema.nullable(),
  briefId: id.nullable(),
}).strict();

const taskSummarySchema = z.object({
  id,
  question: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "interrupted", "cancelled"]),
  stage: z.enum(["planning", "searching", "reading", "analyzing", "writing"]).nullable(),
  sourceCount: z.number().int().min(0),
  questionCount: z.number().int().min(0),
  createdAt: timestamp,
  endedAt: timestamp.nullable(),
  errorCode: z.string().nullable(),
}).strict();

const sourceSchema = z.object({
  id,
  taskId: id,
  ordinal: z.number().int().min(1),
  title: z.string(),
  url: z.string(),
  canonicalUrl: z.string(),
  snippet: z.string(),
  contentText: z.string().nullable(),
  contentStatus: z.enum(["pending", "ready", "failed", "skipped"]),
  publishedAt: z.string().nullable(),
  retrievedAt: timestamp,
}).strict();

const querySchema = z.object({
  id,
  taskId: id,
  round: z.number().int().min(1),
  text: z.string(),
  status: z.enum(["succeeded", "failed"]),
  resultCount: z.number().int().min(0),
  createdAt: timestamp,
}).strict();

export function parseResearchTask(value: unknown): ResearchTask {
  return taskSchema.parse(value);
}

export function parseResearchTaskSummary(value: unknown): ResearchTaskSummary {
  return taskSummarySchema.parse(value);
}

export function parseResearchSource(value: unknown): ResearchSource {
  return sourceSchema.parse(value);
}

export function parseResearchQuery(value: unknown): ResearchQueryRecord {
  return querySchema.parse(value);
}

export function parseResearchPlan(value: unknown): ResearchPlan {
  return planSchema.parse(value);
}

export function parseResearchCoverageRound(value: unknown): ResearchCoverageRound {
  return coverageRoundSchema.parse(value);
}

export function parseResearchUsage(value: unknown): ResearchUsage {
  return usageSchema.parse(value);
}

// ---------------------------------------------------------------------------
// 账本段 schema：读取行与写入草料都经 strict 校验。
// 草稿 schema 一律 strict：模型输入（JSON）不得自带 id、不得夹带 access_level
// 等框架字段——ID 不回收、access_level 只能由框架写入，就在这里强制。
// ---------------------------------------------------------------------------

const stringList = z.array(z.string());

const briefSchema = z.object({
  id,
  taskId: id,
  objective: z.string(),
  inclusions: stringList,
  exclusions: stringList,
  audience: z.string(),
  answerCriteria: z.string(),
  createdAt: timestamp,
}).strict();

const briefDraftSchema = z.object({
  objective: z.string(),
  inclusions: stringList,
  exclusions: stringList,
  audience: z.string(),
  answerCriteria: z.string(),
}).strict();

const questionOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("brief"), scopeBasis: z.string() }).strict(),
  z.object({ kind: z.literal("question"), questionId: id, scopeBasis: z.string() }).strict(),
  z.object({ kind: z.literal("evidence"), evidenceId: id, scopeBasis: z.string() }).strict(),
]);

const questionNodeSchema = z.object({
  id,
  taskId: id,
  parentId: id.nullable(),
  text: z.string(),
  boundaryNote: z.string(),
  priority: z.enum(["critical", "normal", "optional"]),
  status: z.enum(["open", "investigating", "covered", "disputed", "blocked", "abandoned"]),
  origin: questionOriginSchema,
  reopenedCount: z.number().int().min(0),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

const questionNodeReadSchema = questionNodeSchema.extend({
  evidenceCount: z.number().int().min(0),
  evidenceStatus: z.enum(["has_sources", "no_external_evidence"]),
}).strict();

const questionNodeDraftSchema = z.object({
  text: z.string(),
  boundaryNote: z.string(),
  priority: z.enum(["critical", "normal", "optional"]),
  origin: questionOriginSchema,
  parentId: id.nullable().optional(),
}).strict();

const questionEdgeSchema = z.object({
  id,
  taskId: id,
  fromQuestionId: id,
  toQuestionId: id,
  kind: z.enum(["split", "merge", "related"]),
  createdAt: timestamp,
}).strict();

const questionEdgeDraftSchema = z.object({
  fromQuestionId: id,
  toQuestionId: id,
  kind: z.enum(["split", "merge", "related"]),
}).strict();

const accessLevelSchema = z.enum(["snippet", "partial", "fulltext", "unavailable"]);

const sourceEntrySchema = z.object({
  id,
  taskId: id,
  canonicalUrl: z.string(),
  title: z.string(),
  domain: z.string(),
  snippet: z.string(),
  accessLevel: accessLevelSchema,
  contentHash: z.string().nullable(),
  provenanceStatus: z.enum(["unchecked", "confirmed", "changed", "unavailable"]),
  createdAt: timestamp,
}).strict();

const sourceEntryDraftSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  canonicalUrl: z.string().optional(),
  domain: z.string().optional(),
  accessLevel: accessLevelSchema.optional(),
}).strict();

const evidenceItemSchema = z.object({
  id,
  taskId: id,
  sourceId: id,
  excerpt: z.string(),
  locator: z.string(),
  extractedClaim: z.string(),
  stance: z.enum(["supports", "contradicts", "qualifies"]),
  accessLevelSnapshot: accessLevelSchema,
  createdByModelCall: z.string().nullable(),
  createdAt: timestamp,
}).strict();

const evidenceItemReadSchema = evidenceItemSchema.extend({
  questionIds: z.array(id),
}).strict();

/** 草稿没有 access_level 字段：快照写入时由来源行派生，模型无法声称读取深度。 */
const evidenceItemDraftSchema = z.object({
  sourceId: id,
  excerpt: z.string(),
  locator: z.string(),
  extractedClaim: z.string(),
  stance: z.enum(["supports", "contradicts", "qualifies"]),
  questionIds: z.array(id),
  createdByModelCall: z.string().nullable().optional(),
}).strict();

const claimSchema = z.object({
  id,
  taskId: id,
  text: z.string(),
  type: z.enum(["sourced", "synthesis", "inference"]),
  status: z.enum(["provisional", "supported", "disputed", "unsupported", "withdrawn"]),
  scope: z.string().nullable(),
  qualifier: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

const claimReadSchema = claimSchema.extend({
  evidenceIds: z.array(id),
}).strict();

const claimDraftSchema = z.object({
  text: z.string(),
  type: z.enum(["sourced", "synthesis", "inference"]),
  evidenceIds: z.array(id),
  scope: z.string().nullable().optional(),
  qualifier: z.string().nullable().optional(),
  status: z.enum(["provisional", "supported", "disputed", "unsupported", "withdrawn"]).optional(),
}).strict();

const gapSchema = z.object({
  id,
  taskId: id,
  questionId: id,
  description: z.string(),
  importance: z.enum(["critical", "material", "minor"]),
  origin: z.enum([
    "insufficient_evidence",
    "conflicting_evidence",
    "source_unavailable",
    "search_exhausted",
    "unclear_scope",
    "possible_counterevidence",
    "out_of_scope_lead",
  ]),
  attemptedSearchIds: z.array(id),
  status: z.enum(["open", "mitigated", "unresolved", "impossible"]),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

const gapDraftSchema = z.object({
  questionId: id,
  description: z.string(),
  importance: z.enum(["critical", "material", "minor"]),
  origin: z.enum([
    "insufficient_evidence",
    "conflicting_evidence",
    "source_unavailable",
    "search_exhausted",
    "unclear_scope",
    "possible_counterevidence",
    "out_of_scope_lead",
  ]),
  attemptedSearchIds: z.array(id).optional(),
  status: z.enum(["open", "mitigated", "unresolved", "impossible"]).optional(),
}).strict();

const conflictSchema = z.object({
  id,
  taskId: id,
  questionIds: z.array(id),
  claimAId: id,
  claimBId: id,
  evidenceAIds: z.array(id),
  evidenceBIds: z.array(id),
  nature: z.enum(["factual", "definition", "timeframe", "methodology", "interpretation"]),
  status: z.enum(["unresolved", "reconciled", "scoped"]),
  resolutionNote: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

const conflictDraftSchema = z.object({
  questionIds: z.array(id),
  claimAId: id,
  claimBId: id,
  evidenceAIds: z.array(id),
  evidenceBIds: z.array(id),
  nature: z.enum(["factual", "definition", "timeframe", "methodology", "interpretation"]),
  status: z.enum(["unresolved", "reconciled", "scoped"]).optional(),
}).strict();

const reportSpanSchema = z.object({
  id,
  taskId: id,
  reportId: id,
  ordinal: z.number().int().min(1),
  text: z.string(),
  claimIds: z.array(id),
  attributionType: z.enum(["source_statement", "synthesis", "inference"]),
  citationSourceIds: z.array(id),
  createdAt: timestamp,
}).strict();

const reportSpanDraftSchema = z.object({
  text: z.string(),
  claimIds: z.array(id),
  attributionType: z.enum(["source_statement", "synthesis", "inference"]),
  citationSourceIds: z.array(id),
}).strict();

const reportSchema = z.object({
  id,
  taskId: id,
  title: z.string(),
  spans: z.array(reportSpanSchema),
  createdAt: timestamp,
}).strict();

const citationCheckSchema = z.object({
  id,
  taskId: id,
  reportSpanId: id,
  claimId: id.nullable(),
  verdict: z.enum([
    "supports",
    "partially_supports",
    "contradicts",
    "does_not_support",
    "insufficient_context",
  ]),
  sampled: z.boolean(),
  verifierInput: z.string().nullable(),
  verifierOutput: z.string().nullable(),
  verifierModel: z.string().nullable(),
  createdAt: timestamp,
}).strict();

const citationCheckDraftSchema = z.object({
  reportSpanId: id,
  verdict: z.enum([
    "supports",
    "partially_supports",
    "contradicts",
    "does_not_support",
    "insufficient_context",
  ]),
  sampled: z.boolean(),
  claimId: id.nullable().optional(),
  verifierInput: z.string().nullable().optional(),
  verifierOutput: z.string().nullable().optional(),
  verifierModel: z.string().nullable().optional(),
}).strict();

const actionEventKindSchema = z.enum([
  "model_content",
  "tool_call",
  "tool_result",
  "ledger_change",
  "resource_state_change",
  "source_fetch",
  "checkpoint_summary",
]);

/** 负载信封：version 必填，其余字段按 kind 由消费方解析（后置实体的版本化 JSON）。 */
const actionEventPayloadSchema = z.looseObject({
  version: z.number().int().min(1),
});

const actionEventSchema = z.object({
  id,
  taskId: id,
  kind: actionEventKindSchema,
  questionRefs: z.array(id),
  payload: actionEventPayloadSchema,
  createdAt: timestamp,
}).strict();

const actionEventDraftSchema = z.object({
  kind: actionEventKindSchema,
  questionRefs: z.array(id).optional(),
  payload: actionEventPayloadSchema,
}).strict();

const sourceFetchPayloadSchema = z.object({
  version: z.literal(1),
  sourceId: id,
  status: z.enum(["succeeded", "timeout", "http_error", "parse_error", "paywalled", "cancelled"]),
  retryable: z.boolean(),
  bytesRead: z.number().int().min(0).nullable(),
  contentHash: z.string().nullable(),
  requestedAt: timestamp,
  completedAt: timestamp.nullable(),
}).strict();

const checkpointSummaryPayloadSchema = z.object({
  version: z.literal(1),
  text: z.string(),
  retainedClaimIds: z.array(id),
  retainedGapIds: z.array(id),
  retainedConflictIds: z.array(id),
  sourceIds: z.array(id),
  supersedesCheckpointId: id.nullable(),
}).strict();

const actionFailureSchema = z.object({
  class: z.enum(["not_configured", "invalid_input", "timeout", "http_error", "parse_error", "cancelled"]),
  retryable: z.boolean(),
  detail: z.string(),
}).strict();

const searchAttemptPayloadSchema = z.object({
  version: z.literal(1),
  tool: z.literal("research_search"),
  query: z.string(),
  questionRefs: z.array(id),
  requestedAt: timestamp,
  executed: z.boolean(),
  duplicateQuery: z.object({ previousEventId: id }).strict().nullable(),
  overrideDuplicateQuery: z.boolean(),
}).strict();

const searchOutcomePayloadSchema = z.object({
  version: z.literal(1),
  tool: z.literal("research_search"),
  status: z.enum(["completed", "failed", "duplicate_skipped", "policy_ceiling"]),
  requestedAt: timestamp,
  completedAt: timestamp,
  appendedSourceIds: z.array(id),
  duplicateSourceIds: z.array(id),
  failure: actionFailureSchema.nullable(),
}).strict();

const fetchAttemptPayloadSchema = z.object({
  version: z.literal(1),
  tool: z.literal("research_fetch"),
  sourceId: id,
  url: z.string(),
  questionRefs: z.array(id),
  requestedAt: timestamp,
  executed: z.boolean(),
  duplicateContentHash: z.object({
    contentHash: z.string(),
    accessLevel: accessLevelSchema,
  }).strict().nullable(),
  overrideDuplicateRead: z.boolean(),
}).strict();

const stopAssessmentPayloadSchema = z.object({
  version: z.literal(1),
  tool: z.literal("research_propose_stop"),
  assessment: z.object({
    unresolvedCriticalQuestionIds: z.array(id),
    unresolvedGapIds: z.array(id),
    unresolvedConflictIds: z.array(id),
    strongestConclusionAtRisk: z.string(),
    nextBestAction: z.string().nullable(),
    expectedInformationGain: z.enum(["high", "medium", "low"]),
    recentSearchYield: z.enum(["material", "marginal", "none"]),
    recommendation: z.enum(["continue", "stop"]),
    reason: z.string(),
  }).strict(),
  recordedAt: timestamp,
}).strict();

const resourceStateChangePayloadSchema = z.object({
  version: z.literal(1),
  from: z.enum(["normal", "constrained", "finalization_required"]).nullable(),
  to: z.enum(["normal", "constrained", "finalization_required"]),
  reason: z.enum([
    "initial",
    "wall_clock_constrained",
    "wall_clock_reserve",
    "external_actions_ceiling",
    "no_progress_ceiling",
  ]),
  elapsedMs: z.number().int().min(0),
  consecutiveNoProgressCycles: z.number().int().min(0),
}).strict();

const modelContentPayloadSchema = z.object({
  version: z.literal(1),
  blocks: z.array(z.object({
    contentIndex: z.number().int().min(0),
    kind: z.enum(["text", "thinking"]),
    content: z.string(),
  }).strict()),
  reasoningAvailable: z.boolean(),
}).strict();

const questionUpdateSchema = z.object({
  questionId: id,
  status: z.enum(["open", "investigating", "covered", "disputed", "blocked", "abandoned"]).optional(),
  priority: z.enum(["critical", "normal", "optional"]).optional(),
  boundaryNote: z.string().optional(),
}).strict();

const claimUpdateSchema = z.object({
  claimId: id,
  status: z.enum(["provisional", "supported", "disputed", "unsupported", "withdrawn"]).optional(),
  text: z.string().optional(),
  scope: z.string().optional(),
  qualifier: z.string().optional(),
}).strict();

const observationBatchSchema = z.object({
  questionUpdates: z.array(questionUpdateSchema).optional(),
  newQuestions: z.array(questionNodeDraftSchema).optional(),
  evidenceItems: z.array(evidenceItemDraftSchema).optional(),
  claimUpdates: z.array(claimUpdateSchema).optional(),
  newClaims: z.array(claimDraftSchema).optional(),
  newGaps: z.array(gapDraftSchema).optional(),
  newConflicts: z.array(conflictDraftSchema).optional(),
  reopenQuestionIds: z.array(id).optional(),
}).strict();

const observationResultSchema = z.object({
  questions: z.array(questionNodeSchema),
  evidenceItems: z.array(evidenceItemSchema),
  claims: z.array(claimSchema),
  gaps: z.array(gapSchema),
  conflicts: z.array(conflictSchema),
}).strict();

export function parseResearchScopeApproval(value: unknown): ResearchScopeApproval {
  return scopeApprovalSchema.parse(value);
}

export function parseResearchBrief(value: unknown): ResearchBrief {
  return briefSchema.parse(value);
}

export function parseResearchBriefDraft(value: unknown): ResearchBriefDraft {
  return briefDraftSchema.parse(value);
}

export function parseResearchQuestionNode(value: unknown): ResearchQuestionNode {
  return questionNodeSchema.parse(value);
}

export function parseResearchQuestionNodeRead(value: unknown): ResearchQuestionNodeRead {
  return questionNodeReadSchema.parse(value);
}

export function parseResearchQuestionNodeDraft(value: unknown): ResearchQuestionNodeDraft {
  return questionNodeDraftSchema.parse(value);
}

export function parseResearchQuestionEdge(value: unknown): ResearchQuestionEdge {
  return questionEdgeSchema.parse(value);
}

export function parseResearchQuestionEdgeDraft(value: unknown): ResearchQuestionEdgeDraft {
  return questionEdgeDraftSchema.parse(value);
}

export function parseResearchSourceEntry(value: unknown): ResearchSourceEntry {
  return sourceEntrySchema.parse(value);
}

export function parseResearchSourceEntryDraft(value: unknown): ResearchSourceEntryDraft {
  return sourceEntryDraftSchema.parse(value);
}

export function parseResearchEvidenceItem(value: unknown): ResearchEvidenceItem {
  return evidenceItemSchema.parse(value);
}

export function parseResearchEvidenceItemRead(value: unknown): ResearchEvidenceItemRead {
  return evidenceItemReadSchema.parse(value);
}

export function parseResearchEvidenceItemDraft(value: unknown): ResearchEvidenceItemDraft {
  return evidenceItemDraftSchema.parse(value);
}

export function parseResearchClaim(value: unknown): ResearchClaim {
  return claimSchema.parse(value);
}

export function parseResearchClaimRead(value: unknown): ResearchClaimRead {
  return claimReadSchema.parse(value);
}

export function parseResearchClaimDraft(value: unknown): ResearchClaimDraft {
  return claimDraftSchema.parse(value);
}

export function parseResearchGap(value: unknown): ResearchGap {
  return gapSchema.parse(value);
}

export function parseResearchGapDraft(value: unknown): ResearchGapDraft {
  return gapDraftSchema.parse(value);
}

export function parseResearchConflict(value: unknown): ResearchConflict {
  return conflictSchema.parse(value);
}

export function parseResearchConflictDraft(value: unknown): ResearchConflictDraft {
  return conflictDraftSchema.parse(value);
}

export function parseResearchReport(value: unknown): ResearchReport {
  return reportSchema.parse(value);
}

export function parseResearchReportSpan(value: unknown): ResearchReportSpan {
  return reportSpanSchema.parse(value);
}

export function parseResearchReportSpanDraft(value: unknown): ResearchReportSpanDraft {
  return reportSpanDraftSchema.parse(value);
}

export function parseResearchCitationCheck(value: unknown): ResearchCitationCheck {
  return citationCheckSchema.parse(value);
}

export function parseResearchCitationCheckDraft(value: unknown): ResearchCitationCheckDraft {
  return citationCheckDraftSchema.parse(value);
}

export function parseResearchActionEvent(value: unknown): ResearchActionEvent {
  return actionEventSchema.parse(value);
}

export function parseResearchActionEventDraft(value: unknown): ResearchActionEventDraft {
  return actionEventDraftSchema.parse(value);
}

export function parseResearchSourceFetchPayload(value: unknown): ResearchSourceFetchPayload {
  return sourceFetchPayloadSchema.parse(value);
}

export function parseResearchCheckpointSummaryPayload(value: unknown): ResearchCheckpointSummaryPayload {
  return checkpointSummaryPayloadSchema.parse(value);
}

export function parseResearchSearchAttemptPayload(value: unknown): ResearchSearchAttemptPayload {
  return searchAttemptPayloadSchema.parse(value);
}

export function parseResearchSearchOutcomePayload(value: unknown): ResearchSearchOutcomePayload {
  return searchOutcomePayloadSchema.parse(value);
}

export function parseResearchFetchAttemptPayload(value: unknown): ResearchFetchAttemptPayload {
  return fetchAttemptPayloadSchema.parse(value);
}

export function parseResearchStopAssessmentPayload(value: unknown): ResearchStopAssessmentPayload {
  return stopAssessmentPayloadSchema.parse(value);
}

export function parseResearchResourceStateChangePayload(value: unknown): ResearchResourceStateChangePayload {
  return resourceStateChangePayloadSchema.parse(value);
}

export function parseResearchModelContentPayload(value: unknown): ResearchModelContentPayload {
  return modelContentPayloadSchema.parse(value);
}

export function parseResearchObservationBatch(value: unknown): ResearchObservationBatch {
  return observationBatchSchema.parse(value);
}

/**
 * 最近一次已落账的停止评估（后置实体：research_propose_stop 以 tool_result 事件持久化）。
 *
 * 事件顺序即落账顺序，倒序取第一条形状合法的即为当前停止评估。扫描只有这一份实现：
 * 执行层（是否已提议停止 → 成稿）、投影器（stopAssessment 槽位与 inputEntityIds）、
 * 工具层（get_state 投影）与成稿层（写作提示词的 StopAssessment 槽位）共用，
 * 不各写一份倒序扫描。形状不符的事件不构成停止提议。
 */
export function readLatestResearchStopAssessment(
  events: readonly ResearchActionEvent[],
): { readonly eventId: string; readonly createdAt: number; readonly payload: ResearchStopAssessmentPayload } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.kind !== "tool_result") continue;
    if (event.payload.tool !== "research_propose_stop") continue;
    try {
      return {
        eventId: event.id,
        createdAt: event.createdAt,
        payload: parseResearchStopAssessmentPayload(event.payload),
      };
    } catch {
      // 形状不符的事件不构成停止提议：继续向前找。
    }
  }
  return null;
}

/** 是否已有停止评估落账（执行层据此机械判定进入成稿）。 */
export function hasRecordedResearchStopAssessment(events: readonly ResearchActionEvent[]): boolean {
  return readLatestResearchStopAssessment(events) !== null;
}

export function parseResearchObservationResult(value: unknown): ResearchObservationResult {
  return observationResultSchema.parse(value);
}
