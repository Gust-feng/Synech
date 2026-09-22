import { createHash } from "node:crypto";

import type { ToolDefinition, ToolExecutionContext, ToolExecutor } from "../../../domain/tools/index.js";
import {
  asRecord,
  booleanOrUndefined,
  numberOrUndefined,
  stringArrayOrUndefined,
  stringOrUndefined,
  uniqueNonBlankStrings,
} from "../../../kernel/values/index.js";
import type { ResearchContentPort, ResearchSearchPort } from "../../application/research-application.js";
import {
  RESEARCH_ACTION_FAILURE_RETRYABLE,
  RESEARCH_POLICY,
  ResearchError,
  type ResearchActionEvent,
  type ResearchActionFailure,
  type ResearchActionFailureClass,
  type ResearchCheckpointSummaryPayload,
  type ResearchErrorCode,
  type ResearchEvidenceItemRead,
  type ResearchFeature,
  type ResearchFetchAttemptPayload,
  type ResearchFetchOutcomePayload,
  type ResearchLedger,
  type ResearchObservationBatch,
  type ResearchObservationResult,
  type ResearchQuestionNodeRead,
  type ResearchSearchAttemptPayload,
  type ResearchSearchOutcomePayload,
  type ResearchSourceEntry,
  type ResearchSourceEntryDraft,
  type ResearchSourceFetchPayload,
  type ResearchStopAssessmentPayload,
} from "../../research/index.js";
import { canonicalizeUrl } from "../../research/canonical-url.js";
import {
  parseResearchCheckpointSummaryPayload,
  parseResearchFetchAttemptPayload,
  parseResearchSearchAttemptPayload,
  parseResearchSourceFetchPayload,
  readLatestResearchStopAssessment,
} from "../../research/persistence-schema.js";

/**
 * 研究 loop 的工具集（仅研究 loop 可见的 scope）。
 *
 * 分工（ADR 0001 §2.7 / §2.8、设计草案 §7）：
 * - 模型负责研究语义：查什么、读什么、证据意味着什么、问题怎么变、是否充分；
 * - 本模块只提供框架自己的读写面：外部调用、去重、access_level 与 content hash、
 *   事件落账，以及按 ID 的细粒度读取投影。
 *
 * 三条纪律：
 * 1. 工具只调用 Feature 既有命令/查询（applyObservations / appendSourceEntries /
 *    markSourceAccess / appendActionEvents / queries.ledger），不自行编排、不复制结构
 *    校验——校验规则的唯一实现在 contracts.ts，Feature 在串行队列内预检，仓储在事务内
 *    复验；
 * 2. 任务身份来自 `context.resourceScope`（ownerKind = research_task）：模型入参无法
 *    指定任务，因此不存在跨任务读写的入口；
 * 3. 任何返回值都不含全量正文，也不含调用次数/剩余额度等用量事实（ADR §2.3 永不进入
 *    模型上下文）；正文按 ID 有界返回，超出部分给出截断事实。
 */

/** 研究 loop 的执行上下文身份：Host 执行该任务时绑定，模型输入无法构造。 */
export const RESEARCH_TASK_RESOURCE_OWNER_KIND = "research_task";

export type ResearchLoopToolDependencies = {
  readonly feature: Pick<ResearchFeature, "commands" | "queries">;
  /** 研究自己的检索端口（复用 WebSearch provider 与同一份运行时配置）。 */
  readonly search?: ResearchSearchPort;
  /** 研究自己的正文抓取端口（复用 WebFetch 的浏览器能力）。 */
  readonly content?: ResearchContentPort;
  readonly now?: () => number;
};

/** 工具名集中一处：落账 payload 的 tool 字段与作用域注册共用，避免两处漂移。 */
export const RESEARCH_SEARCH_TOOL_NAME = "research_search";
export const RESEARCH_FETCH_TOOL_NAME = "research_fetch";

const readMetadata = {
  category: "research",
  riskLevel: "low",
  operationType: "read-only",
  requiresConfirmation: false,
} as const;

const writeMetadata = {
  category: "research",
  riskLevel: "low",
  operationType: "read-write",
  requiresConfirmation: false,
} as const;

/**
 * 外部动作元数据：研究启动时用户已一次性授权这次研究的外部动作（设计草案 §7.4），
 * loop 内的 search/fetch 在该任务授权下执行，不再逐次确认。
 */
const externalActionMetadata = {
  category: "research",
  riskLevel: "medium",
  operationType: "external-submit",
  requiresConfirmation: false,
} as const;

/** Feature 声明的业务错误转成结构化事实的边界；未知错误继续上抛。 */
const STRUCTURED_RESEARCH_ERROR_CODES: ReadonlySet<ResearchErrorCode> = new Set<ResearchErrorCode>([
  "research_invalid_input",
  "research_task_not_found",
]);

export function createResearchLoopTools(
  dependencies: ResearchLoopToolDependencies,
): readonly ToolExecutor[] {
  const feature = dependencies.feature;
  const tools: ToolExecutor[] = [
    createResearchGetStateTool({ feature }),
    createResearchGetQuestionContextTool({ feature }),
    createResearchGetSourceTool({ feature }),
    createResearchGetEvidenceTool({ feature }),
    createResearchApplyObservationsTool({ feature }),
    createResearchCheckpointTool({ feature }),
    createResearchProposeStopTool({ feature }),
  ];
  // 外部端口未装配时对应工具不注册：能力缺失要如实表现为「工具不存在」，
  // 而不是注册一个只会返回不可用的空壳。
  if (dependencies.search !== undefined) {
    tools.push(createResearchSearchTool({ feature, search: dependencies.search, now: dependencies.now }));
  }
  if (dependencies.content !== undefined) {
    tools.push(createResearchFetchTool({ feature, content: dependencies.content, now: dependencies.now }));
  }
  return tools;
}

// ---------------------------------------------------------------------------
// 读取投影（设计草案 §7.3）：结构摘要进 get_state，全文/excerpt 按 ID 按需取。
// ---------------------------------------------------------------------------

export function createResearchGetStateTool(options: {
  readonly feature: Pick<ResearchFeature, "commands" | "queries">;
}): ToolExecutor {
  return {
    definition: {
      name: "research_get_state",
      description:
        "读取当前研究状态的结构摘要：批准范围、问题拓扑与状态、证据卡（id/主张/立场/来源/读取深度）、Claim、开放 Gap、未决 Conflict、来源清单、上次 checkpoint 与上次停止评估。不含正文摘录；需要原文时用 research_get_source / research_get_evidence 按 ID 取。",
      metadata: readMetadata,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    execute: async (_input, context) => {
      const taskId = researchTaskIdOf(context);
      if (taskId === undefined) return missingTaskScope();
      const ledger = await options.feature.queries.ledger(taskId);
      if (ledger === undefined) return taskNotFound(taskId);
      return {
        status: "ok",
        taskId,
        brief: ledger.brief === null
          ? null
          : {
              objective: ledger.brief.objective,
              inclusions: ledger.brief.inclusions,
              exclusions: ledger.brief.exclusions,
              audience: ledger.brief.audience,
              answerCriteria: ledger.brief.answerCriteria,
            },
        questions: ledger.questions.map(questionCard),
        questionEdges: ledger.questionEdges.map((edge) => ({
          fromQuestionId: edge.fromQuestionId,
          toQuestionId: edge.toQuestionId,
          kind: edge.kind,
        })),
        evidenceCards: ledger.evidence.map(evidenceCard),
        claims: ledger.claims.map((claim) => ({
          id: claim.id,
          text: cap(claim.text),
          type: claim.type,
          status: claim.status,
          scope: claim.scope,
          qualifier: claim.qualifier,
          evidenceIds: claim.evidenceIds,
        })),
        sources: ledger.sources.map((source) => ({
          id: source.id,
          canonicalUrl: source.canonicalUrl,
          domain: source.domain,
          title: cap(source.title),
          accessLevel: source.accessLevel,
          provenanceStatus: source.provenanceStatus,
          contentHash: source.contentHash,
        })),
        gaps: ledger.gaps.map(gapCard),
        conflicts: ledger.conflicts.map(conflictCard),
        counts: {
          questions: ledger.questions.length,
          openQuestions: countStatus(ledger.questions, "open"),
          investigatingQuestions: countStatus(ledger.questions, "investigating"),
          coveredQuestions: countStatus(ledger.questions, "covered"),
          evidence: ledger.evidence.length,
          claims: ledger.claims.length,
          sources: ledger.sources.length,
          openGaps: ledger.gaps.filter((gap) => gap.status === "open").length,
          unresolvedConflicts: ledger.conflicts.filter((conflict) => conflict.status === "unresolved").length,
        },
        latestCheckpoint: latestCheckpoint(ledger.actionEvents),
        latestStopAssessment: latestStopAssessment(ledger.actionEvents),
        report: ledger.report === null
          ? null
          : { title: cap(ledger.report.title), spanCount: ledger.report.spans.length },
        /**
         * 框架策略上界（工具契约，不是剩余额度）：单次动作限制与整项研究的外部动作
         * 上界都是框架政策。已用次数与剩余预算不进入模型上下文。
         */
        actionLimits: {
          maxSearchRequests: RESEARCH_POLICY.maxSearchRequests,
          maxFetchRequests: RESEARCH_POLICY.maxFetchRequests,
          maxSearchResultsPerRequest: RESEARCH_POLICY.maxSearchResultsPerRequest,
          fetchContentChars: RESEARCH_POLICY.fetchContentChars,
        },
      };
    },
  };
}

export function createResearchGetQuestionContextTool(options: {
  readonly feature: Pick<ResearchFeature, "commands" | "queries">;
}): ToolExecutor {
  return {
    definition: {
      name: "research_get_question_context",
      description:
        "按问题 ID 读取该问题的上下文：问题节点与边界、父子问题与 question edge、直接关联的证据卡（不含摘录正文）、相关 Claim、Gap 与 Conflict。摘录正文用 research_get_evidence 按证据 ID 取。",
      metadata: readMetadata,
      inputSchema: {
        type: "object",
        properties: {
          questionId: { type: "string", minLength: 1, description: "research_get_state 返回的问题 ID。" },
        },
        required: ["questionId"],
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      const taskId = researchTaskIdOf(context);
      if (taskId === undefined) return missingTaskScope();
      const questionId = stringOrUndefined(asRecord(input).questionId);
      if (questionId === undefined) return invalidInput("questionId 必须是非空字符串。");
      const ledger = await options.feature.queries.ledger(taskId);
      if (ledger === undefined) return taskNotFound(taskId);
      const question = ledger.questions.find((item) => item.id === questionId);
      if (question === undefined) {
        return { status: "question_not_found", taskId, questionId };
      }
      const evidence = ledger.evidence.filter((item) => item.questionIds.includes(questionId));
      const evidenceIds = new Set(evidence.map((item) => item.id));
      return {
        status: "ok",
        taskId,
        question: questionCard(question),
        childQuestions: ledger.questions
          .filter((item) => item.parentId === questionId)
          .map((item) => ({ id: item.id, text: cap(item.text), status: item.status })),
        edges: ledger.questionEdges
          .filter((edge) => edge.fromQuestionId === questionId || edge.toQuestionId === questionId)
          .map((edge) => ({
            fromQuestionId: edge.fromQuestionId,
            toQuestionId: edge.toQuestionId,
            kind: edge.kind,
          })),
        evidenceCards: evidence.map(evidenceCard),
        claims: ledger.claims
          .filter((claim) => claim.evidenceIds.some((evidenceId) => evidenceIds.has(evidenceId)))
          .map((claim) => ({
            id: claim.id,
            text: cap(claim.text),
            type: claim.type,
            status: claim.status,
            evidenceIds: claim.evidenceIds,
          })),
        gaps: ledger.gaps.filter((gap) => gap.questionId === questionId).map(gapCard),
        conflicts: ledger.conflicts
          .filter((conflict) => conflict.questionIds.includes(questionId))
          .map(conflictCard),
      };
    },
  };
}

export function createResearchGetSourceTool(options: {
  readonly feature: Pick<ResearchFeature, "commands" | "queries">;
}): ToolExecutor {
  return {
    definition: {
      name: "research_get_source",
      description:
        "按来源 ID 读取一条来源：canonical URL、域名、标题、检索摘要、读取深度、内容 hash 与 provenance，以及该来源已入账的证据卡（含摘录与定位）和最近一次抓取结果。网页正文只在 research_fetch 抓取时有界返回。",
      metadata: readMetadata,
      inputSchema: {
        type: "object",
        properties: {
          sourceId: { type: "string", minLength: 1, description: "research_get_state 或 research_search 返回的来源 ID。" },
        },
        required: ["sourceId"],
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      const taskId = researchTaskIdOf(context);
      if (taskId === undefined) return missingTaskScope();
      const sourceId = stringOrUndefined(asRecord(input).sourceId);
      if (sourceId === undefined) return invalidInput("sourceId 必须是非空字符串。");
      const ledger = await options.feature.queries.ledger(taskId);
      if (ledger === undefined) return taskNotFound(taskId);
      const source = ledger.sources.find((item) => item.id === sourceId);
      if (source === undefined) {
        return { status: "source_not_found", taskId, sourceId };
      }
      return {
        status: "ok",
        taskId,
        source: sourceCard(source),
        evidence: ledger.evidence
          .filter((item) => item.sourceId === sourceId)
          .map((item) => ({
            id: item.id,
            excerpt: cap(item.excerpt),
            locator: item.locator,
            extractedClaim: cap(item.extractedClaim),
            stance: item.stance,
            accessLevelSnapshot: item.accessLevelSnapshot,
            questionIds: item.questionIds,
          })),
        lastFetch: latestSourceFetch(ledger.actionEvents, sourceId),
      };
    },
  };
}

export function createResearchGetEvidenceTool(options: {
  readonly feature: Pick<ResearchFeature, "commands" | "queries">;
}): ToolExecutor {
  return {
    definition: {
      name: "research_get_evidence",
      description:
        "按证据 ID 读取一条证据的完整记录：摘录、定位、抽取的主张、立场、写入时快照的读取深度，以及它所属的来源卡片与问题。",
      metadata: readMetadata,
      inputSchema: {
        type: "object",
        properties: {
          evidenceId: { type: "string", minLength: 1, description: "research_get_state 返回的证据卡 ID。" },
        },
        required: ["evidenceId"],
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      const taskId = researchTaskIdOf(context);
      if (taskId === undefined) return missingTaskScope();
      const evidenceId = stringOrUndefined(asRecord(input).evidenceId);
      if (evidenceId === undefined) return invalidInput("evidenceId 必须是非空字符串。");
      const ledger = await options.feature.queries.ledger(taskId);
      if (ledger === undefined) return taskNotFound(taskId);
      const evidence = ledger.evidence.find((item) => item.id === evidenceId);
      if (evidence === undefined) {
        return { status: "evidence_not_found", taskId, evidenceId };
      }
      const source = ledger.sources.find((item) => item.id === evidence.sourceId);
      return {
        status: "ok",
        taskId,
        evidence: {
          id: evidence.id,
          excerpt: cap(evidence.excerpt),
          locator: evidence.locator,
          extractedClaim: cap(evidence.extractedClaim),
          stance: evidence.stance,
          accessLevelSnapshot: evidence.accessLevelSnapshot,
          createdByModelCall: evidence.createdByModelCall,
          questionIds: evidence.questionIds,
          createdAt: evidence.createdAt,
        },
        source: source === undefined ? null : sourceCard(source),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 写入面（设计草案 §7.2）：一次模型判断 = 一个原子状态变更。
// ---------------------------------------------------------------------------

const OBSERVATION_SEGMENTS = [
  "questionUpdates",
  "newQuestions",
  "evidenceItems",
  "claimUpdates",
  "newClaims",
  "newGaps",
  "newConflicts",
  "reopenQuestionIds",
] as const;

export function createResearchApplyObservationsTool(options: {
  readonly feature: Pick<ResearchFeature, "commands" | "queries">;
}): ToolExecutor {
  return {
    definition: {
      name: "research_apply_observations",
      description:
        "研究状态的主要写入入口：把一个批量观察（问题更新/新问题/证据/主张更新/新主张/新缺口/新分歧/重开问题）作为一次原子状态变更提交。必须至少携带一个片段；结构校验与状态机由框架在事务内执行，任一片段不合法则整批拒绝且不落任何数据。证据草稿不得夹带 access_level：读取深度由框架按来源真实抓取结果派生。",
      metadata: writeMetadata,
      inputSchema: {
        type: "object",
        description: "一次模型判断的批量观察；任一片段校验失败整批拒绝。",
        properties: {
          questionUpdates: {
            type: "array",
            description: "已存在问题的状态/优先级/边界更新；同一问题的多条更新按刚落库状态逐条校验。",
            items: {
              type: "object",
              properties: {
                questionId: { type: "string", minLength: 1, description: "已存在的问题 ID。" },
                status: {
                  type: "string",
                  enum: ["open", "investigating", "covered", "disputed", "blocked", "abandoned"],
                  description: "目标状态；必须落在状态机允许的迁移内。",
                },
                priority: { type: "string", enum: ["critical", "normal", "optional"], description: "优先级。" },
                boundaryNote: { type: "string", description: "新的边界说明。" },
              },
              required: ["questionId"],
              additionalProperties: false,
            },
          },
          newQuestions: {
            type: "array",
            description: "新增问题：必须携带 origin（可追溯地落在批准范围内）；ID 由框架分配。",
            items: {
              type: "object",
              properties: {
                text: { type: "string", minLength: 1, description: "问题正文。" },
                boundaryNote: { type: "string", minLength: 1, description: "边界：查到哪里算查完。" },
                priority: { type: "string", enum: ["critical", "normal", "optional"], description: "优先级。" },
                parentId: { type: ["string", "null"], description: "父问题 ID；顶层问题省略或传 null。" },
                origin: {
                  type: "object",
                  description: "出处：brief=来自批准范围；question/evidence=由某个已存在问题或证据引出。",
                  properties: {
                    kind: { type: "string", enum: ["brief", "question", "evidence"], description: "出处类型。" },
                    questionId: { type: "string", minLength: 1, description: "kind=question 时必填：引出该问题的已存在问题 ID。" },
                    evidenceId: { type: "string", minLength: 1, description: "kind=evidence 时必填：引出该问题的证据 ID。" },
                    scopeBasis: { type: "string", minLength: 1, description: "落在批准范围内的依据。" },
                  },
                  required: ["kind", "scopeBasis"],
                  additionalProperties: false,
                },
              },
              required: ["text", "boundaryNote", "priority", "origin"],
              additionalProperties: false,
            },
          },
          evidenceItems: {
            type: "array",
            description: "证据：摘录尽量贴近来源原文，locator 说明摘录落在哪里；不得夹带 access_level。",
            items: {
              type: "object",
              properties: {
                sourceId: { type: "string", minLength: 1, description: "来源 ID（research_search / research_get_source 返回）。" },
                excerpt: { type: "string", minLength: 1, description: "来源原文摘录。" },
                locator: { type: "string", minLength: 1, description: "摘录在来源中的位置。" },
                extractedClaim: { type: "string", minLength: 1, description: "该摘录支持的论断。" },
                stance: { type: "string", enum: ["supports", "contradicts", "qualifies"], description: "立场。" },
                questionIds: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                  description: "该证据关联的问题 ID。",
                },
              },
              required: ["sourceId", "excerpt", "locator", "extractedClaim", "stance", "questionIds"],
              additionalProperties: false,
            },
          },
          claimUpdates: {
            type: "array",
            description: "已存在主张的状态/文本/范围/限定更新；状态迁移必须过状态机。",
            items: {
              type: "object",
              properties: {
                claimId: { type: "string", minLength: 1, description: "已存在的 Claim ID。" },
                status: {
                  type: "string",
                  enum: ["provisional", "supported", "disputed", "unsupported", "withdrawn"],
                  description: "目标状态；withdrawn 是终态。",
                },
                text: { type: "string", description: "新的主张文本。" },
                scope: { type: "string", description: "适用范围。" },
                qualifier: { type: "string", description: "限定条件。" },
              },
              required: ["claimId"],
              additionalProperties: false,
            },
          },
          newClaims: {
            type: "array",
            description: "新主张：每个主张必须绑定已存在的证据（同批 evidenceItems 先落库，可被这里的 evidenceIds 引用）；初始状态缺省 provisional。",
            items: {
              type: "object",
              properties: {
                text: { type: "string", minLength: 1, description: "主张正文：一个可被证据支撑或反驳的陈述。" },
                type: {
                  type: "string",
                  enum: ["sourced", "synthesis", "inference"],
                  description: "sourced=来源直接给出；synthesis=多来源综合；inference=你自己的推断。",
                },
                evidenceIds: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                  description: "绑定的证据 ID（必须已存在于账本或本批 evidenceItems 中）。",
                },
                scope: { type: "string", description: "适用范围。" },
                qualifier: { type: "string", description: "限定条件。" },
                status: {
                  type: "string",
                  enum: ["provisional", "supported", "disputed", "unsupported", "withdrawn"],
                  description: "初始状态；缺省 provisional，且必须是 provisional 的合法迁移目标。",
                },
              },
              required: ["text", "type", "evidenceIds"],
              additionalProperties: false,
            },
          },
          newGaps: {
            type: "array",
            description: "新缺口：只有一边有证据的争议必须记为 Gap(possible_counterevidence)，不能建成 Conflict。",
            items: {
              type: "object",
              properties: {
                questionId: { type: "string", minLength: 1, description: "缺口所属问题 ID。" },
                description: { type: "string", minLength: 1, description: "缺什么。" },
                importance: { type: "string", enum: ["critical", "material", "minor"], description: "重要程度。" },
                origin: {
                  type: "string",
                  enum: [
                    "insufficient_evidence",
                    "conflicting_evidence",
                    "source_unavailable",
                    "search_exhausted",
                    "unclear_scope",
                    "possible_counterevidence",
                    "out_of_scope_lead",
                  ],
                  description: "缺口来源。",
                },
                attemptedSearchIds: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                  description: "已尝试过的检索尝试 ID（research_search 返回的 attemptId）。",
                },
                status: {
                  type: "string",
                  enum: ["open", "mitigated", "unresolved", "impossible"],
                  description: "状态；impossible 是终态。",
                },
              },
              required: ["questionId", "description", "importance", "origin"],
              additionalProperties: false,
            },
          },
          newConflicts: {
            type: "array",
            description: "新分歧：双边各绑定 ≥2 个不同来源的 Evidence，单边一律拒绝。",
            items: {
              type: "object",
              properties: {
                questionIds: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                  description: "争议涉及的问题 ID。",
                },
                claimAId: { type: "string", minLength: 1, description: "一边的主张 ID。" },
                claimBId: { type: "string", minLength: 1, description: "另一边的主张 ID。" },
                evidenceAIds: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                  description: "A 边证据：≥2 条且来自 ≥2 个不同来源。",
                },
                evidenceBIds: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                  description: "B 边证据：≥2 条且来自 ≥2 个不同来源。",
                },
                nature: {
                  type: "string",
                  enum: ["factual", "definition", "timeframe", "methodology", "interpretation"],
                  description: "分歧性质。",
                },
                status: {
                  type: "string",
                  enum: ["unresolved", "reconciled", "scoped"],
                  description: "状态；reconciled/scoped 是终态。",
                },
              },
              required: ["questionIds", "claimAId", "claimBId", "evidenceAIds", "evidenceBIds", "nature"],
              additionalProperties: false,
            },
          },
          reopenQuestionIds: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "重开的问题 ID：回到 investigating 且 reopened_count +1。",
          },
        },
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      const taskId = researchTaskIdOf(context);
      if (taskId === undefined) return missingTaskScope();
      const record = asRecord(input);
      if (!OBSERVATION_SEGMENTS.some((segment) => record[segment] !== undefined)) {
        return invalidInput("批量观察必须至少携带一个片段（questionUpdates / newQuestions / evidenceItems / claimUpdates / newClaims / newGaps / newConflicts / reopenQuestionIds）。");
      }
      // 形状与状态机校验整体交给 Feature 串行队列与仓储事务：工具不复制第二份规则，
      // 也不替模型补字段；模型输入越界在那里被明确拒绝。
      let applied: ResearchObservationResult;
      try {
        applied = await options.feature.commands.applyObservations({
          taskId,
          batch: record as unknown as ResearchObservationBatch,
        });
      } catch (error) {
        return mapResearchFailure(error);
      }
      return {
        status: "ok",
        taskId,
        applied: {
          questions: applied.questions.map((question) => ({
            id: question.id,
            status: question.status,
            priority: question.priority,
          })),
          evidenceItems: applied.evidenceItems.map((item) => ({
            id: item.id,
            sourceId: item.sourceId,
            stance: item.stance,
            accessLevelSnapshot: item.accessLevelSnapshot,
          })),
          claims: applied.claims.map((claim) => ({
            id: claim.id,
            status: claim.status,
            type: claim.type,
          })),
          gaps: applied.gaps.map((gap) => ({
            id: gap.id,
            questionId: gap.questionId,
            status: gap.status,
          })),
          conflicts: applied.conflicts.map((conflict) => ({
            id: conflict.id,
            status: conflict.status,
          })),
        },
        counts: {
          questions: applied.questions.length,
          evidenceItems: applied.evidenceItems.length,
          claims: applied.claims.length,
          gaps: applied.gaps.length,
          conflicts: applied.conflicts.length,
        },
      };
    },
  };
}

export function createResearchCheckpointTool(options: {
  readonly feature: Pick<ResearchFeature, "commands" | "queries">;
}): ToolExecutor {
  return {
    definition: {
      name: "research_checkpoint",
      description:
        "写入一次检查点：把当前工作记忆压缩成一段文本，并回指保留的 Claim / Gap / Conflict / Source ID。检查点是模型生成的工作记忆，不替代账本；回指实体不存在会被拒绝。",
      metadata: writeMetadata,
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, description: "压缩后的工作记忆：已知什么、还缺什么、下一步看哪里。" },
          retainedClaimIds: { type: "array", items: { type: "string", minLength: 1 }, description: "保留的主张 ID。" },
          retainedGapIds: { type: "array", items: { type: "string", minLength: 1 }, description: "保留的缺口 ID。" },
          retainedConflictIds: { type: "array", items: { type: "string", minLength: 1 }, description: "保留的分歧 ID。" },
          sourceIds: { type: "array", items: { type: "string", minLength: 1 }, description: "保留的来源 ID。" },
          supersedesCheckpointId: { type: ["string", "null"], description: "被本次检查点取代的上一个检查点 ID；首个检查点传 null。" },
          questionRefs: { type: "array", items: { type: "string", minLength: 1 }, description: "本次检查点涉及的问题 ID（可选）。" },
        },
        required: ["text", "retainedClaimIds", "retainedGapIds", "retainedConflictIds", "sourceIds", "supersedesCheckpointId"],
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      const taskId = researchTaskIdOf(context);
      if (taskId === undefined) return missingTaskScope();
      const record = asRecord(input);
      const text = stringOrUndefined(record.text);
      const supersedes = record.supersedesCheckpointId;
      const questionRefs = readQuestionRefs(record);
      if (text === undefined || questionRefs === null) {
        return invalidInput("text 必须是非空字符串；questionRefs 省略或为字符串数组。");
      }
      if (supersedes !== undefined && supersedes !== null && typeof supersedes !== "string") {
        return invalidInput("supersedesCheckpointId 必须是字符串或 null。");
      }
      const lists: readonly (readonly [keyof Omit<ResearchCheckpointSummaryPayload, "version" | "text" | "supersedesCheckpointId">, unknown])[] = [
        ["retainedClaimIds", record.retainedClaimIds],
        ["retainedGapIds", record.retainedGapIds],
        ["retainedConflictIds", record.retainedConflictIds],
        ["sourceIds", record.sourceIds],
      ];
      const retained = new Map<string, readonly string[]>();
      for (const [key, value] of lists) {
        const ids = value === undefined ? [] : stringArrayOrUndefined(value);
        if (ids === undefined) return invalidInput(`${key} 必须是字符串数组。`);
        retained.set(key, uniqueNonBlankStrings(ids));
      }
      const payload: ResearchCheckpointSummaryPayload = {
        version: 1,
        text,
        retainedClaimIds: retained.get("retainedClaimIds") ?? [],
        retainedGapIds: retained.get("retainedGapIds") ?? [],
        retainedConflictIds: retained.get("retainedConflictIds") ?? [],
        sourceIds: retained.get("sourceIds") ?? [],
        supersedesCheckpointId: supersedes ?? null,
      };
      let created: readonly ResearchActionEvent[];
      try {
        created = await options.feature.commands.appendActionEvents({
          taskId,
          events: [{
            kind: "checkpoint_summary",
            ...(questionRefs === undefined ? {} : { questionRefs }),
            payload,
          }],
        });
      } catch (error) {
        return mapResearchFailure(error);
      }
      return {
        status: "ok",
        taskId,
        checkpointId: created[0]?.id ?? null,
        supersedesCheckpointId: payload.supersedesCheckpointId,
      };
    },
  };
}

export function createResearchProposeStopTool(options: {
  readonly feature: Pick<ResearchFeature, "commands" | "queries">;
}): ToolExecutor {
  return {
    definition: {
      name: "research_propose_stop",
      description:
        "提交一份停止评估：还有哪些未决的关键问题/缺口/分歧、最可能被推翻的结论、下一步动作、预期信息量与近期检索产出，以及 continue/stop 建议。框架校验引用是否存在并记录事实；recommendation=stop 不等于研究充分，是否成稿由执行层机械判定。",
      metadata: writeMetadata,
      inputSchema: {
        type: "object",
        properties: {
          unresolvedCriticalQuestionIds: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "仍未解决的关键问题 ID。",
          },
          unresolvedGapIds: { type: "array", items: { type: "string", minLength: 1 }, description: "仍未解决的缺口 ID。" },
          unresolvedConflictIds: { type: "array", items: { type: "string", minLength: 1 }, description: "仍未解决的分歧 ID。" },
          strongestConclusionAtRisk: { type: "string", description: "当前最可能被推翻的结论。" },
          nextBestAction: { type: ["string", "null"], description: "下一步最值得做的事；没有则 null。" },
          expectedInformationGain: { type: "string", enum: ["high", "medium", "low"], description: "继续调查的预期信息量。" },
          recentSearchYield: { type: "string", enum: ["material", "marginal", "none"], description: "近期检索的产出。" },
          recommendation: { type: "string", enum: ["continue", "stop"], description: "建议继续调查还是停止调查。" },
          reason: { type: "string", minLength: 1, description: "给出该建议的研究理由。" },
          questionRefs: { type: "array", items: { type: "string", minLength: 1 }, description: "本次评估涉及的问题 ID（可选）。" },
        },
        required: ["expectedInformationGain", "recentSearchYield", "recommendation", "reason"],
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      const taskId = researchTaskIdOf(context);
      if (taskId === undefined) return missingTaskScope();
      const record = asRecord(input);
      const expectedInformationGain = enumOf(record.expectedInformationGain, ["high", "medium", "low"] as const);
      const recentSearchYield = enumOf(record.recentSearchYield, ["material", "marginal", "none"] as const);
      const recommendation = enumOf(record.recommendation, ["continue", "stop"] as const);
      const reason = stringOrUndefined(record.reason);
      const strongestConclusionAtRisk = optionalText(record.strongestConclusionAtRisk);
      const nextBestAction = record.nextBestAction;
      const questionRefs = readQuestionRefs(record);
      const unresolvedCriticalQuestionIds = readIdList(record.unresolvedCriticalQuestionIds);
      const unresolvedGapIds = readIdList(record.unresolvedGapIds);
      const unresolvedConflictIds = readIdList(record.unresolvedConflictIds);
      if (expectedInformationGain === null || recentSearchYield === null || recommendation === null
        || reason === undefined || questionRefs === null || unresolvedCriticalQuestionIds === null
        || unresolvedGapIds === null || unresolvedConflictIds === null || strongestConclusionAtRisk === null) {
        return invalidInput("expectedInformationGain / recentSearchYield / recommendation / reason 必填且取值合法；unresolved* 与 questionRefs 必须是字符串数组。");
      }
      if (nextBestAction !== undefined && nextBestAction !== null && typeof nextBestAction !== "string") {
        return invalidInput("nextBestAction 必须是字符串或 null。");
      }
      const ledger = await options.feature.queries.ledger(taskId);
      if (ledger === undefined) return taskNotFound(taskId);
      // ADR §8.3：框架只校验引用的 Question/Gap/Conflict 是否存在。
      const knownQuestionIds = new Set(ledger.questions.map((question) => question.id));
      const knownGapIds = new Set(ledger.gaps.map((gap) => gap.id));
      const knownConflictIds = new Set(ledger.conflicts.map((conflict) => conflict.id));
      const unknownReferences = uniqueNonBlankStrings([
        ...unresolvedCriticalQuestionIds.filter((id) => !knownQuestionIds.has(id)),
        ...(questionRefs ?? []).filter((id) => !knownQuestionIds.has(id)),
        ...unresolvedGapIds.filter((id) => !knownGapIds.has(id)),
        ...unresolvedConflictIds.filter((id) => !knownConflictIds.has(id)),
      ]);
      if (unknownReferences.length > 0) {
        return {
          status: "research_invalid_input",
          code: "research_invalid_input",
          unknownReferences,
          message: "停止评估引用了任务内不存在的实体。",
        };
      }
      const payload: ResearchStopAssessmentPayload = {
        version: 1,
        tool: "research_propose_stop",
        assessment: {
          unresolvedCriticalQuestionIds,
          unresolvedGapIds,
          unresolvedConflictIds,
          strongestConclusionAtRisk: strongestConclusionAtRisk ?? "",
          nextBestAction: nextBestAction ?? null,
          expectedInformationGain,
          recentSearchYield,
          recommendation,
          reason,
        },
        recordedAt: Date.now(),
      };
      let created: readonly ResearchActionEvent[];
      try {
        created = await options.feature.commands.appendActionEvents({
          taskId,
          events: [{
            kind: "tool_result",
            ...(questionRefs === undefined ? {} : { questionRefs }),
            payload,
          }],
        });
      } catch (error) {
        return mapResearchFailure(error);
      }
      return {
        status: "recorded",
        taskId,
        assessmentId: created[0]?.id ?? null,
        recommendation,
        message: "停止评估已落账；是否成稿由研究执行层机械判定。",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 外部动作：检索 / 抓取。动作与结果按 ADR §2.1 后置实体形态落账，
// canonical URL / content hash / 精确查询三种去重由框架完成并结构化标注。
// ---------------------------------------------------------------------------

export function createResearchSearchTool(options: {
  readonly feature: Pick<ResearchFeature, "commands" | "queries">;
  readonly search: ResearchSearchPort;
  readonly now?: () => number;
}): ToolExecutor {
  const feature = options.feature;
  const now = options.now ?? Date.now;
  return {
    definition: {
      name: RESEARCH_SEARCH_TOOL_NAME,
      description:
        "执行一次联网检索，并把结果按 canonical URL 去重后入列来源（已存在的来源只回传其 ID，不重复入列）。入参携带该次检索针对的问题 ID；与任务内完全相同的精确查询会被框架跳过，确需重查时显式传 overrideDuplicateQuery。",
      metadata: externalActionMetadata,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, description: "检索词。" },
          questionRefs: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "该次检索针对的问题 ID（必须已存在于问题树）。",
          },
          limit: {
            type: "number",
            description: `返回结果条数上限，1–${RESEARCH_POLICY.maxSearchResultsPerRequest}；默认取框架上限。`,
          },
          overrideDuplicateQuery: {
            type: "boolean",
            description: "框架判定为重复的精确查询仍然执行；override 事实会落账。",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      const taskId = researchTaskIdOf(context);
      if (taskId === undefined) return missingTaskScope();
      const record = asRecord(input);
      const query = stringOrUndefined(record.query);
      const questionRefs = readQuestionRefs(record);
      const overrideDuplicateQuery = booleanOrUndefined(record.overrideDuplicateQuery) ?? false;
      const limit = numberOrUndefined(record.limit);
      if (query === undefined || questionRefs === null || limit === null) {
        return invalidInput("query 必须是非空字符串；questionRefs 与 limit 省略或为合法值。");
      }
      if (limit !== undefined
        && (!Number.isInteger(limit) || limit < 1 || limit > RESEARCH_POLICY.maxSearchResultsPerRequest)) {
        return invalidInput(`limit 必须是 1–${RESEARCH_POLICY.maxSearchResultsPerRequest} 的整数。`);
      }
      if (context.abortSignal?.aborted === true) {
        return { status: "cancelled", taskId, message: "研究已取消。" };
      }
      const ledger = await feature.queries.ledger(taskId);
      if (ledger === undefined) return taskNotFound(taskId);

      const knownQuestionIds = new Set(ledger.questions.map((question) => question.id));
      const unknownRefs = (questionRefs ?? []).filter((id) => !knownQuestionIds.has(id));
      if (unknownRefs.length > 0) {
        // 预检只为不在无效入参上烧掉一次外部调用；权威校验仍在 appendActionEvents。
        return {
          status: "research_invalid_input",
          code: "research_invalid_input",
          unknownQuestionRefs: uniqueNonBlankStrings(unknownRefs),
          message: "检索入参引用了任务内不存在的问题。",
        };
      }

      const requestedAt = now();
      const attempts = priorExternalActions(ledger.actionEvents);
      const refs = questionRefs ?? [];

      // 策略上界：整项研究的外部动作次数由框架限定。模型看不到已用次数，
      // 只知道这一次没有被允许执行。
      if (attempts.search >= RESEARCH_POLICY.maxSearchRequests) {
        return await recordSearchNotExecuted(feature, taskId, {
          query,
          refs,
          requestedAt,
          completedAt: now(),
          status: "policy_ceiling",
        });
      }

      // 精确查询去重：同一任务内同一检索词不重复发起外部调用。
      const previousAttemptId = overrideDuplicateQuery
        ? undefined
        : priorQueryAttemptId(ledger.actionEvents, query);
      if (previousAttemptId !== undefined) {
        return await recordSearchNotExecuted(feature, taskId, {
          query,
          refs,
          requestedAt,
          completedAt: now(),
          status: "duplicate_skipped",
          previousAttemptId,
        });
      }

      const attempt: ResearchSearchAttemptPayload = {
        version: 1,
        tool: "research_search",
        query,
        questionRefs: refs,
        requestedAt,
        executed: true,
        duplicateQuery: null,
        overrideDuplicateQuery,
      };
      let created: readonly ResearchActionEvent[];
      try {
        created = await feature.commands.appendActionEvents({
          taskId,
          events: [{ kind: "tool_call", ...(refs.length === 0 ? {} : { questionRefs: refs }), payload: attempt }],
        });
      } catch (error) {
        return mapResearchFailure(error);
      }
      const attemptId = created[0]?.id ?? null;

      const timeoutSignal = AbortSignal.timeout(RESEARCH_POLICY.perSearchTimeoutMs);
      const signal = context.abortSignal === undefined
        ? timeoutSignal
        : AbortSignal.any([context.abortSignal, timeoutSignal]);
      let response: Awaited<ReturnType<ResearchSearchPort["search"]>>;
      try {
        response = await options.search.search({
          query,
          limit: limit ?? RESEARCH_POLICY.maxSearchResultsPerRequest,
          signal,
        });
      } catch (error) {
        const failure = classifyThrownExternalError(error, context.abortSignal, timeoutSignal);
        await recordSearchOutcome(feature, taskId, {
          query,
          refs,
          requestedAt,
          completedAt: now(),
          status: "failed",
          failure,
        });
        return { status: "failed", taskId, attemptId, failure, message: failureMessage(failure) };
      }

      if (response.status !== "completed") {
        const failure = classifyAdapterFailure(response.code, "search");
        await recordSearchOutcome(feature, taskId, {
          query,
          refs,
          requestedAt,
          completedAt: now(),
          status: "failed",
          failure,
        });
        return { status: "failed", taskId, attemptId, failure, message: failureMessage(failure) };
      }

      // canonical URL 去重：已在账本里的来源不重复入列；同一批内的重复结果也不重复入列。
      const existingByCanonicalUrl = new Map(ledger.sources.map((source) => [source.canonicalUrl, source]));
      const drafts: ResearchSourceEntryDraft[] = [];
      const draftsByCanonicalUrl = new Map<string, ResearchSourceEntryDraft>();
      const duplicates: { url: string; canonicalUrl: string; sourceId: string | null; title: string }[] = [];
      const dropped: { url: string; reason: string }[] = [];
      for (const result of response.results) {
        const title = result.title.trim();
        const url = result.url.trim();
        if (title.length === 0 || url.length === 0) continue;
        const canonicalUrl = canonicalizeUrl(url);
        if (canonicalUrl === undefined) {
          dropped.push({ url, reason: "url_not_canonicalizable" });
          continue;
        }
        const existing = existingByCanonicalUrl.get(canonicalUrl);
        if (existing !== undefined) {
          duplicates.push({ url, canonicalUrl, sourceId: existing.id, title: cap(existing.title) });
          continue;
        }
        if (draftsByCanonicalUrl.has(canonicalUrl)) {
          duplicates.push({ url, canonicalUrl, sourceId: null, title: cap(title) });
          continue;
        }
        const draft: ResearchSourceEntryDraft = {
          title,
          url,
          snippet: result.snippet.trim(),
          canonicalUrl,
        };
        draftsByCanonicalUrl.set(canonicalUrl, draft);
        drafts.push(draft);
      }

      const appended = await feature.commands.appendSourceEntries({ taskId, drafts });
      const appendedByCanonicalUrl = new Map(appended.map((source) => [source.canonicalUrl, source]));
      const unresolved = duplicates.filter((item) => item.sourceId === null);
      for (const item of unresolved) {
        const appendedSource = appendedByCanonicalUrl.get(item.canonicalUrl);
        if (appendedSource !== undefined) item.sourceId = appendedSource.id;
      }
      await recordSearchOutcome(feature, taskId, {
        query,
        refs,
        requestedAt,
        completedAt: now(),
        status: "completed",
        failure: null,
        appendedSourceIds: appended.map((source) => source.id),
        duplicateSourceIds: duplicates
          .map((item) => item.sourceId)
          .filter((sourceId): sourceId is string => sourceId !== null),
      });
      return {
        status: "ok",
        taskId,
        attemptId,
        query,
        questionRefs: refs,
        sources: appended.map((source) => ({
          id: source.id,
          url: source.canonicalUrl,
          title: cap(source.title),
          domain: source.domain,
          accessLevel: source.accessLevel,
          snippet: cap(source.snippet),
        })),
        duplicates,
        dropped,
      };
    },
  };
}

export function createResearchFetchTool(options: {
  readonly feature: Pick<ResearchFeature, "commands" | "queries">;
  readonly content: ResearchContentPort;
  readonly now?: () => number;
}): ToolExecutor {
  const feature = options.feature;
  const now = options.now ?? Date.now;
  return {
    definition: {
      name: RESEARCH_FETCH_TOOL_NAME,
      description:
        "抓取一条来源的正文：框架按真实抓取结果写入读取深度（access_level）与内容 hash，并返回有界的正文片段与截断事实。已按同一内容 hash 读过的来源会被框架跳过，确需重读时显式传 overrideDuplicateRead。",
      metadata: externalActionMetadata,
      inputSchema: {
        type: "object",
        properties: {
          sourceId: { type: "string", minLength: 1, description: "要读取的来源 ID。" },
          questionRefs: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "该次抓取针对的问题 ID（必须已存在于问题树）。",
          },
          overrideDuplicateRead: {
            type: "boolean",
            description: "框架判定为重复读取的来源仍然抓取；override 事实会落账。",
          },
        },
        required: ["sourceId"],
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      const taskId = researchTaskIdOf(context);
      if (taskId === undefined) return missingTaskScope();
      const record = asRecord(input);
      const sourceId = stringOrUndefined(record.sourceId);
      const questionRefs = readQuestionRefs(record);
      const overrideDuplicateRead = booleanOrUndefined(record.overrideDuplicateRead) ?? false;
      if (sourceId === undefined || questionRefs === null) {
        return invalidInput("sourceId 必须是非空字符串；questionRefs 省略或为字符串数组。");
      }
      if (context.abortSignal?.aborted === true) {
        return { status: "cancelled", taskId, message: "研究已取消。" };
      }
      const ledger = await feature.queries.ledger(taskId);
      if (ledger === undefined) return taskNotFound(taskId);
      const source = ledger.sources.find((item) => item.id === sourceId);
      if (source === undefined) {
        return { status: "source_not_found", taskId, sourceId };
      }
      const knownQuestionIds = new Set(ledger.questions.map((question) => question.id));
      const unknownRefs = (questionRefs ?? []).filter((id) => !knownQuestionIds.has(id));
      if (unknownRefs.length > 0) {
        return {
          status: "research_invalid_input",
          code: "research_invalid_input",
          unknownQuestionRefs: uniqueNonBlankStrings(unknownRefs),
          message: "抓取入参引用了任务内不存在的问题。",
        };
      }

      const requestedAt = now();
      const refs = questionRefs ?? [];
      const attempts = priorExternalActions(ledger.actionEvents);

      if (attempts.fetch >= RESEARCH_POLICY.maxFetchRequests) {
        const attempt = fetchAttempt({
          sourceId,
          url: source.canonicalUrl,
          refs,
          requestedAt,
          executed: false,
          duplicateContentHash: null,
          overrideDuplicateRead,
        });
        const attemptId = await appendToolCall(feature, taskId, attempt);
        await appendFetchOutcome(feature, taskId, {
          refs,
          requestedAt,
          completedAt: now(),
          status: "policy_ceiling",
          failure: null,
        });
        return {
          status: "policy_ceiling",
          taskId,
          attemptId,
          reason: "external_action_ceiling",
          message: "研究的外部抓取次数已达框架策略上界；请换来源或记 Gap。",
        };
      }

      // 内容 hash 去重：同一内容已经读过，重复抓取不产生新事实。
      const contentHash = source.contentHash;
      const alreadyRead = contentHash !== null
        && (source.accessLevel === "fulltext" || source.accessLevel === "partial");
      if (alreadyRead && !overrideDuplicateRead) {
        const attempt = fetchAttempt({
          sourceId,
          url: source.canonicalUrl,
          refs,
          requestedAt,
          executed: false,
          duplicateContentHash: { contentHash, accessLevel: source.accessLevel },
          overrideDuplicateRead,
        });
        const attemptId = await appendToolCall(feature, taskId, attempt);
        await appendFetchOutcome(feature, taskId, {
          refs,
          requestedAt,
          completedAt: now(),
          status: "duplicate_skipped",
          failure: null,
        });
        return {
          status: "duplicate_skipped",
          taskId,
          attemptId,
          duplicate: { kind: "content_hash", contentHash, accessLevel: source.accessLevel },
          source: sourceCard(source),
          message: "该来源已按同一内容 hash 读过；确需重读请显式传 overrideDuplicateRead。",
        };
      }

      const attempt = fetchAttempt({
        sourceId,
        url: source.canonicalUrl,
        refs,
        requestedAt,
        executed: true,
        duplicateContentHash: null,
        overrideDuplicateRead,
      });
      const attemptId = await appendToolCall(feature, taskId, attempt);
      /**
       * 单次动作超时（设计草案 §4.2 工具契约）：与 search 分支同构，把 run 取消信号
       * 与本次抓取的时限合并。外层取消仍分类为 cancelled，只有本次抓取超时才是
       * timeout——两者在信号层面可区分。
       */
      const timeoutSignal = AbortSignal.timeout(RESEARCH_POLICY.perFetchTimeoutMs);
      const signal = context.abortSignal === undefined
        ? timeoutSignal
        : AbortSignal.any([context.abortSignal, timeoutSignal]);

      let fetched: Awaited<ReturnType<ResearchContentPort["fetch"]>>;
      try {
        fetched = await options.content.fetch({ url: source.canonicalUrl, signal });
      } catch (error) {
        const failure = classifyThrownExternalError(error, context.abortSignal, timeoutSignal);
        // 与适配器返回 failed 的分支同一规则：抓取没有成功完成，读取深度就是
        // unavailable（框架按真实抓取结果写，不保留上一次的快照）。
        await feature.commands.markSourceAccess({
          taskId,
          sourceId,
          accessLevel: "unavailable",
          contentHash: null,
        });
        await recordSourceFetch(feature, taskId, {
          sourceId,
          status: fetchStatusOf(failure.class),
          retryable: failure.retryable,
          bytesRead: null,
          contentHash: null,
          requestedAt,
          completedAt: now(),
        }, refs);
        return {
          status: "failed",
          taskId,
          attemptId,
          source: { ...sourceCard(source), accessLevel: "unavailable", contentHash: null },
          failure,
          message: failureMessage(failure),
        };
      }

      if (fetched.status !== "completed") {
        const failure = classifyAdapterFailure(fetched.code, "fetch");
        // 读取深度是框架依据真实抓取结果写的事实：抓不到就是 unavailable。
        await feature.commands.markSourceAccess({
          taskId,
          sourceId,
          accessLevel: "unavailable",
          contentHash: null,
        });
        await recordSourceFetch(feature, taskId, {
          sourceId,
          status: fetchStatusOf(failure.class),
          retryable: failure.retryable,
          bytesRead: null,
          contentHash: null,
          requestedAt,
          completedAt: now(),
        }, refs);
        return {
          status: "failed",
          taskId,
          attemptId,
          source: { ...sourceCard(source), accessLevel: "unavailable", contentHash: null },
          failure,
          message: failureMessage(failure),
        };
      }

      const text = fetched.text;
      const bytesRead = Buffer.byteLength(text, "utf8");
      const hash = createHash("sha256").update(text, "utf8").digest("hex");
      await feature.commands.markSourceAccess({
        taskId,
        sourceId,
        accessLevel: "fulltext",
        contentHash: hash,
      });
      await recordSourceFetch(feature, taskId, {
        sourceId,
        status: "succeeded",
        retryable: false,
        bytesRead,
        contentHash: hash,
        requestedAt,
        completedAt: now(),
      }, refs);

      const truncated = text.length > RESEARCH_POLICY.fetchContentChars;
      return {
        status: "ok",
        taskId,
        attemptId,
        source: { ...sourceCard(source), accessLevel: "fulltext", contentHash: hash },
        content: truncated ? text.slice(0, RESEARCH_POLICY.fetchContentChars) : text,
        contentChars: text.length,
        contentTruncated: truncated,
        bytesRead,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 内部助手
// ---------------------------------------------------------------------------

type ResearchLoopFailure = {
  readonly status: string;
  readonly code?: string;
  readonly message: string;
};

function researchTaskIdOf(context: ToolExecutionContext): string | undefined {
  const scope = context.resourceScope;
  if (scope === undefined || scope.ownerKind !== RESEARCH_TASK_RESOURCE_OWNER_KIND) return undefined;
  return stringOrUndefined(scope.ownerId);
}

function missingTaskScope(): ResearchLoopFailure {
  return {
    status: "research_task_scope_missing",
    message: "研究状态工具只能由研究 loop 执行：执行上下文未绑定 research_task 资源范围。",
  };
}

function taskNotFound(taskId: string): ResearchLoopFailure {
  return {
    status: "research_task_not_found",
    code: "research_task_not_found",
    message: `研究任务 ${taskId} 不存在。`,
  };
}

function invalidInput(message: string): ResearchLoopFailure {
  return { status: "research_invalid_input", code: "research_invalid_input", message };
}

/** Feature 声明的业务错误转成结构化事实；未知错误继续上抛，不伪装成空状态。 */
function mapResearchFailure(error: unknown): ResearchLoopFailure {
  if (error instanceof ResearchError && STRUCTURED_RESEARCH_ERROR_CODES.has(error.code)) {
    return { status: error.code, code: error.code, message: error.message };
  }
  throw error;
}

function cap(text: string): string {
  const max = RESEARCH_POLICY.readProjectionExcerptMaxChars;
  return text.length <= max ? text : text.slice(0, max);
}

function countStatus(
  questions: readonly ResearchQuestionNodeRead[],
  status: ResearchQuestionNodeRead["status"],
): number {
  return questions.filter((question) => question.status === status).length;
}

function readQuestionRefs(record: Record<string, unknown>): readonly string[] | undefined | null {
  const value = record.questionRefs;
  if (value === undefined) return undefined;
  const ids = stringArrayOrUndefined(value);
  return ids === undefined ? null : uniqueNonBlankStrings(ids);
}

function readIdList(value: unknown): readonly string[] | null {
  if (value === undefined) return [];
  const ids = stringArrayOrUndefined(value);
  return ids === undefined ? null : uniqueNonBlankStrings(ids);
}

function optionalText(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function enumOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : null;
}

function questionCard(question: ResearchQuestionNodeRead): Record<string, unknown> {
  return {
    id: question.id,
    parentId: question.parentId,
    text: cap(question.text),
    boundaryNote: cap(question.boundaryNote),
    priority: question.priority,
    status: question.status,
    origin: question.origin,
    reopenedCount: question.reopenedCount,
    evidenceCount: question.evidenceCount,
    evidenceStatus: question.evidenceStatus,
  };
}

function evidenceCard(evidence: ResearchEvidenceItemRead): Record<string, unknown> {
  return {
    id: evidence.id,
    sourceId: evidence.sourceId,
    extractedClaim: cap(evidence.extractedClaim),
    stance: evidence.stance,
    accessLevelSnapshot: evidence.accessLevelSnapshot,
    questionIds: evidence.questionIds,
  };
}

function sourceCard(source: ResearchSourceEntry): Record<string, unknown> {
  return {
    id: source.id,
    canonicalUrl: source.canonicalUrl,
    domain: source.domain,
    title: cap(source.title),
    snippet: cap(source.snippet),
    accessLevel: source.accessLevel,
    contentHash: source.contentHash,
    provenanceStatus: source.provenanceStatus,
  };
}

function gapCard(gap: ResearchLedger["gaps"][number]): Record<string, unknown> {
  return {
    id: gap.id,
    questionId: gap.questionId,
    description: cap(gap.description),
    importance: gap.importance,
    origin: gap.origin,
    status: gap.status,
    attemptedSearchIds: gap.attemptedSearchIds,
  };
}

function conflictCard(conflict: ResearchLedger["conflicts"][number]): Record<string, unknown> {
  return {
    id: conflict.id,
    questionIds: conflict.questionIds,
    claimAId: conflict.claimAId,
    claimBId: conflict.claimBId,
    evidenceAIds: conflict.evidenceAIds,
    evidenceBIds: conflict.evidenceBIds,
    nature: conflict.nature,
    status: conflict.status,
  };
}

function eventTool(event: ResearchActionEvent): string | undefined {
  const tool = event.payload.tool;
  return typeof tool === "string" ? tool : undefined;
}

/** 已真正发出的外部动作次数：重复跳过与策略上界不烧外部调用，也不计入。 */
function priorExternalActions(
  events: readonly ResearchActionEvent[],
): { readonly search: number; readonly fetch: number } {
  let search = 0;
  let fetch = 0;
  for (const event of events) {
    if (event.kind !== "tool_call") continue;
    const tool = eventTool(event);
    if (tool === RESEARCH_SEARCH_TOOL_NAME) {
      if (parseResearchSearchAttemptPayload(event.payload).executed) search += 1;
    } else if (tool === RESEARCH_FETCH_TOOL_NAME) {
      if (parseResearchFetchAttemptPayload(event.payload).executed) fetch += 1;
    }
  }
  return { search, fetch };
}

function priorQueryAttemptId(events: readonly ResearchActionEvent[], query: string): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.kind !== "tool_call" || eventTool(event) !== RESEARCH_SEARCH_TOOL_NAME) continue;
    if (parseResearchSearchAttemptPayload(event.payload).query === query) return event.id;
  }
  return undefined;
}

function latestCheckpoint(events: readonly ResearchActionEvent[]): Record<string, unknown> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.kind !== "checkpoint_summary") continue;
    const payload = parseResearchCheckpointSummaryPayload(event.payload);
    return {
      id: event.id,
      text: cap(payload.text),
      retainedClaimIds: payload.retainedClaimIds,
      retainedGapIds: payload.retainedGapIds,
      retainedConflictIds: payload.retainedConflictIds,
      sourceIds: payload.sourceIds,
      supersedesCheckpointId: payload.supersedesCheckpointId,
      createdAt: event.createdAt,
    };
  }
  return null;
}

function latestStopAssessment(events: readonly ResearchActionEvent[]): Record<string, unknown> | null {
  // 扫描与解析只有一份实现（persistence-schema.readLatestResearchStopAssessment）：
  // 执行层、投影器与工具层看到同一个「最近一次停止评估」。
  const record = readLatestResearchStopAssessment(events);
  if (record === null) return null;
  return {
    id: record.eventId,
    recommendation: record.payload.assessment.recommendation,
    expectedInformationGain: record.payload.assessment.expectedInformationGain,
    recentSearchYield: record.payload.assessment.recentSearchYield,
    reason: cap(record.payload.assessment.reason),
    unresolvedCriticalQuestionIds: record.payload.assessment.unresolvedCriticalQuestionIds,
    unresolvedGapIds: record.payload.assessment.unresolvedGapIds,
    unresolvedConflictIds: record.payload.assessment.unresolvedConflictIds,
    createdAt: record.createdAt,
  };
}

function latestSourceFetch(events: readonly ResearchActionEvent[], sourceId: string): Record<string, unknown> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.kind !== "source_fetch") continue;
    const payload = parseResearchSourceFetchPayload(event.payload);
    if (payload.sourceId !== sourceId) continue;
    return {
      id: event.id,
      status: payload.status,
      retryable: payload.retryable,
      bytesRead: payload.bytesRead,
      contentHash: payload.contentHash,
      completedAt: payload.completedAt,
    };
  }
  return null;
}

function classifyAdapterFailure(detail: string, action: "search" | "fetch"): ResearchActionFailure {
  const failureClass = adapterFailureClass(detail, action);
  return { class: failureClass, retryable: RESEARCH_ACTION_FAILURE_RETRYABLE[failureClass], detail };
}

function adapterFailureClass(detail: string, action: "search" | "fetch"): ResearchActionFailureClass {
  if (action === "search") {
    if (detail === "web_search_not_configured") return "not_configured";
    if (detail === "invalid_query") return "invalid_input";
    return "http_error";
  }
  if (detail === "content_too_short") return "parse_error";
  if (detail === "content_fetch_cancelled") return "cancelled";
  return "http_error";
}

/** 端口抛出的异常：区分外层取消、超时与上游故障。 */
function classifyThrownExternalError(
  error: unknown,
  runSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal | undefined,
): ResearchActionFailure {
  if (runSignal?.aborted === true) {
    return { class: "cancelled", retryable: false, detail: "research_cancelled" };
  }
  if (timeoutSignal?.aborted === true) {
    return { class: "timeout", retryable: true, detail: "action_timeout" };
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return { class: "timeout", retryable: true, detail: name };
  }
  return {
    class: "http_error",
    retryable: true,
    detail: (error instanceof Error ? error.message : String(error)).slice(0, 300),
  };
}

function failureMessage(failure: ResearchActionFailure): string {
  if (failure.class === "not_configured") return "联网检索服务未配置。";
  if (failure.class === "invalid_input") return "入参不合法，未被外部服务接受。";
  if (failure.class === "cancelled") return "研究已取消。";
  if (failure.class === "timeout") return "外部调用超时；可以换来源或稍后重试。";
  if (failure.class === "parse_error") return "来源内容无法解析为正文（通常是登录墙或脚本壳）；换来源或记 Gap。";
  return "外部调用失败；可以换来源或稍后重试。";
}

function fetchStatusOf(failureClass: ResearchActionFailureClass): ResearchSourceFetchPayload["status"] {
  if (failureClass === "cancelled") return "cancelled";
  if (failureClass === "timeout") return "timeout";
  if (failureClass === "parse_error") return "parse_error";
  return "http_error";
}

async function appendToolCall(
  feature: Pick<ResearchFeature, "commands">,
  taskId: string,
  payload: ResearchSearchAttemptPayload | ResearchFetchAttemptPayload,
): Promise<string | null> {
  const created = await feature.commands.appendActionEvents({
    taskId,
    events: [{
      kind: "tool_call",
      ...(payload.questionRefs.length === 0 ? {} : { questionRefs: payload.questionRefs }),
      payload,
    }],
  });
  return created[0]?.id ?? null;
}

function fetchAttempt(input: {
  readonly sourceId: string;
  readonly url: string;
  readonly refs: readonly string[];
  readonly requestedAt: number;
  readonly executed: boolean;
  readonly duplicateContentHash: ResearchFetchAttemptPayload["duplicateContentHash"];
  readonly overrideDuplicateRead: boolean;
}): ResearchFetchAttemptPayload {
  return {
    version: 1,
    tool: "research_fetch",
    sourceId: input.sourceId,
    url: input.url,
    questionRefs: input.refs,
    requestedAt: input.requestedAt,
    executed: input.executed,
    duplicateContentHash: input.duplicateContentHash,
    overrideDuplicateRead: input.overrideDuplicateRead,
  };
}

async function appendFetchOutcome(
  feature: Pick<ResearchFeature, "commands">,
  taskId: string,
  outcome: {
    readonly refs: readonly string[];
    readonly requestedAt: number;
    readonly completedAt: number;
    readonly status: ResearchFetchOutcomePayload["status"];
    readonly failure: ResearchActionFailure | null;
  },
): Promise<void> {
  const payload: ResearchFetchOutcomePayload = {
    version: 1,
    tool: "research_fetch",
    status: outcome.status,
    requestedAt: outcome.requestedAt,
    completedAt: outcome.completedAt,
    failure: outcome.failure,
  };
  await feature.commands.appendActionEvents({
    taskId,
    events: [{
      kind: "tool_result",
      ...(outcome.refs.length === 0 ? {} : { questionRefs: outcome.refs }),
      payload,
    }],
  });
}

async function recordSearchOutcome(
  feature: Pick<ResearchFeature, "commands">,
  taskId: string,
  outcome: {
    readonly query: string;
    readonly refs: readonly string[];
    readonly requestedAt: number;
    readonly completedAt: number;
    readonly status: ResearchSearchOutcomePayload["status"];
    readonly failure: ResearchActionFailure | null;
    readonly appendedSourceIds?: readonly string[];
    readonly duplicateSourceIds?: readonly string[];
  },
): Promise<void> {
  const payload: ResearchSearchOutcomePayload = {
    version: 1,
    tool: "research_search",
    status: outcome.status,
    requestedAt: outcome.requestedAt,
    completedAt: outcome.completedAt,
    appendedSourceIds: outcome.appendedSourceIds ?? [],
    duplicateSourceIds: outcome.duplicateSourceIds ?? [],
    failure: outcome.failure,
  };
  await feature.commands.appendActionEvents({
    taskId,
    events: [{
      kind: "tool_result",
      ...(outcome.refs.length === 0 ? {} : { questionRefs: outcome.refs }),
      payload,
    }],
  });
}

async function recordSearchNotExecuted(
  feature: Pick<ResearchFeature, "commands">,
  taskId: string,
  input: {
    readonly query: string;
    readonly refs: readonly string[];
    readonly requestedAt: number;
    readonly completedAt: number;
    readonly status: "duplicate_skipped" | "policy_ceiling";
    readonly previousAttemptId?: string;
  },
): Promise<Record<string, unknown>> {
  const attempt: ResearchSearchAttemptPayload = {
    version: 1,
    tool: "research_search",
    query: input.query,
    questionRefs: input.refs,
    requestedAt: input.requestedAt,
    executed: false,
    duplicateQuery: input.previousAttemptId === undefined
      ? null
      : { previousEventId: input.previousAttemptId },
    overrideDuplicateQuery: false,
  };
  const attemptId = await appendToolCall(feature, taskId, attempt);
  await recordSearchOutcome(feature, taskId, {
    query: input.query,
    refs: input.refs,
    requestedAt: input.requestedAt,
    completedAt: input.completedAt,
    status: input.status,
    failure: null,
  });
  if (input.status === "duplicate_skipped") {
    return {
      status: "duplicate_skipped",
      taskId,
      attemptId,
      duplicate: { kind: "exact_query", previousAttemptId: input.previousAttemptId ?? null },
      message: "同一个检索词已在本次研究中执行过；确需重查请显式传 overrideDuplicateQuery。",
    };
  }
  return {
    status: "policy_ceiling",
    taskId,
    attemptId,
    reason: "external_action_ceiling",
    message: "研究的外部检索次数已达框架策略上界；请改用已有来源或记 Gap。",
  };
}

async function recordSourceFetch(
  feature: Pick<ResearchFeature, "commands">,
  taskId: string,
  fetch: {
    readonly sourceId: string;
    readonly status: ResearchSourceFetchPayload["status"];
    readonly retryable: boolean;
    readonly bytesRead: number | null;
    readonly contentHash: string | null;
    readonly requestedAt: number;
    readonly completedAt: number;
  },
  refs: readonly string[],
): Promise<void> {
  const payload: ResearchSourceFetchPayload = { version: 1, ...fetch };
  await feature.commands.appendActionEvents({
    taskId,
    events: [{
      kind: "source_fetch",
      ...(refs.length === 0 ? {} : { questionRefs: refs }),
      payload,
    }],
  });
}
