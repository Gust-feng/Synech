import { createHash } from "node:crypto";

import {
  RESEARCH_CLARIFICATION_MAX_SNIPPET_SEARCHES,
} from "../../domain/config/settings-store.js";
import { stableStringify } from "../../kernel/values/index.js";
import {
  ResearchError,
  type ResearchBriefDraft,
  type ResearchQuestionNodePriority,
  type ResearchScopeApproval,
  type ResearchScopeSearchDisclosure,
} from "./contracts.js";
import { RESEARCH_POLICY } from "./research-policy.js";

/**
 * 范围闸门（ADR 0001 §2.2 / 设计草案 §8.1）：`ResearchApplication.start` 入参的
 * 结构完整性校验与规范化，规则只有这一份实现。
 *
 * 判据（产品硬约束）：
 * - 结构校验只查完整性——objective 非平凡、问题数在界内、每问有 boundary_note、
 *   exclusions 非空、answer_criteria 存在；任一不齐即拒绝并给出结构化缺失清单；
 * - **语义充分性由用户在范围卡上判定**，框架不判，因此这里没有任何「写得好不好」的判断；
 * - 无 approval 不得创建任务：approval 的三个字段全部纳入同一道门，不存在免确认路径；
 * - payload_hash 由框架按规范化 payload 计算并落账；入参自带的值若提供则必须与它
 *   一致，否则拒绝——客户端自述的哈希不构成「确定后不能改」的可审计事实。
 */

/**
 * 澄清期检索披露的次数上限：设置形状的合法域（与配置中心同一条契约），
 * 无论开关来自用户配置还是默认值，披露次数都不得超出。
 */
const MAX_SCOPE_SEARCH_DISCLOSURE = RESEARCH_CLARIFICATION_MAX_SNIPPET_SEARCHES;

/** payload_hash 是框架计算的 sha256 十六进制摘要；调用方提供时必须同形。 */
const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/u;

/** 初始问题树落在批准范围内的依据（origin.scopeBasis，D8）。 */
export const RESEARCH_INITIAL_QUESTION_SCOPE_BASIS = "范围卡批准的初始问题树";

export type ResearchScopeGateFailureCode =
  | "brief_missing"
  | "objective_missing"
  | "inclusions_missing"
  | "exclusions_missing"
  | "audience_missing"
  | "answer_criteria_missing"
  | "questions_missing"
  | "question_count_out_of_range"
  | "question_text_missing"
  | "question_priority_invalid"
  | "question_boundary_note_missing"
  | "approval_missing"
  | "approval_payload_hash_missing"
  | "approved_at_missing"
  | "conversation_ref_missing"
  | "payload_hash_mismatch"
  | "scope_search_disclosure_over_limit";

/**
 * 一条缺失/不合规字段。`field` 是稳定的结构路径（程序分支用 code，不用 message）；
 * `message` 只做展示，调用方不得靠它恢复语义。
 */
export type ResearchScopeGateFailure = {
  readonly field: string;
  readonly code: ResearchScopeGateFailureCode;
  readonly message: string;
};

/** 闸门拒绝：携带完整缺失字段清单，供对话侧继续追问与 UI 结构化展示。 */
export class ResearchScopeGateError extends ResearchError {
  constructor(readonly failures: readonly ResearchScopeGateFailure[]) {
    super("research_scope_incomplete", describeScopeGateFailures(failures));
  }
}

export type ResearchScopeGateResult =
  | { readonly ok: true; readonly scope: ResearchApprovedScope }
  | { readonly ok: false; readonly failures: readonly ResearchScopeGateFailure[] };

/** 通过闸门后交给编排的规范化范围：brief + 初始问题树 + 可审计批准事实。 */
export type ResearchApprovedScope = {
  readonly brief: ResearchBriefDraft;
  readonly questions: readonly ResearchScopeQuestion[];
  readonly approval: ResearchScopeApproval;
};

/** 初始问题树的规范化形状：与入参同名同义，trim 后由框架持有。 */
export type ResearchScopeQuestion = {
  readonly text: string;
  readonly priority: ResearchQuestionNodePriority;
  readonly boundaryNote: string;
};

export type ResearchScopeHashInput = {
  readonly brief: ResearchBriefDraft;
  readonly questions: readonly ResearchScopeQuestion[];
  readonly scopeSearchDisclosure?: ResearchScopeSearchDisclosure;
};

/**
 * 规范化 payload 的 sha256：确定性（键排序序列化）、与存储形状无关。
 * 只覆盖「用户批准了什么」，不含 approved_at / conversation_ref（时间与地点不是内容）。
 */
export function researchScopePayloadHash(scope: ResearchScopeHashInput): string {
  const canonical = {
    brief: scope.brief,
    questions: scope.questions.map((question) => ({
      text: question.text,
      priority: question.priority,
      boundaryNote: question.boundaryNote,
    })),
    ...(scope.scopeSearchDisclosure === undefined
      ? {}
      : { scopeSearchDisclosure: { snippetSearches: scope.scopeSearchDisclosure.snippetSearches } }),
  };
  return createHash("sha256").update(stableStringify(canonical), "utf8").digest("hex");
}

/** 结构校验门：不通过时返回完整缺失清单（不抛异常，便于调用方自行决定呈现方式）。 */
export function readResearchScopeGate(input: unknown): ResearchScopeGateResult {
  const failures: ResearchScopeGateFailure[] = [];
  const scope = readScopeShape(input, failures);
  if (scope === undefined) return { ok: false, failures };
  return { ok: true, scope };
}

/** 同一道门的抛错形态：编排与工具层用这一个入口，不各写一份。 */
export function assertResearchScope(input: unknown): ResearchApprovedScope {
  const gate = readResearchScopeGate(input);
  if (!gate.ok) throw new ResearchScopeGateError(gate.failures);
  return gate.scope;
}

function readScopeShape(
  input: unknown,
  failures: ResearchScopeGateFailure[],
): ResearchApprovedScope | undefined {
  const record = asRecord(input);
  if (record === undefined) {
    failures.push({ field: "$", code: "brief_missing", message: "研究范围载荷缺失。" });
    return undefined;
  }
  const brief = readBrief(asRecord(record.brief), failures);
  const questions = readQuestions(record.questions, failures);
  const approval = readApproval(asRecord(record.approval), failures);
  const disclosure = readDisclosure(record.scopeSearchDisclosure, failures);

  if (failures.length > 0) return undefined;

  const scope: ResearchApprovedScope = {
    brief,
    questions,
    approval: {
      payloadHash: "",
      approvedAt: approval.approvedAt,
      conversationRef: approval.conversationRef,
      ...(disclosure === undefined ? {} : { scopeSearchDisclosure: disclosure }),
    },
  };

  // payload_hash 由框架计算；入参自带的值必须与它一致（审计事实不可客户端自述）。
  const payloadHash = researchScopePayloadHash(scope);
  if (approval.payloadHash.length > 0 && approval.payloadHash !== payloadHash) {
    failures.push({
      field: "approval.payloadHash",
      code: "payload_hash_mismatch",
      message: "范围载荷与批准记录不一致，请重新在范围卡上确认。",
    });
    return undefined;
  }
  return { ...scope, approval: { ...scope.approval, payloadHash } };
}

function readBrief(
  input: Record<string, unknown> | undefined,
  failures: ResearchScopeGateFailure[],
): ResearchBriefDraft {
  if (input === undefined) {
    failures.push({ field: "brief", code: "brief_missing", message: "缺少研究范围（brief）。" });
    return { objective: "", inclusions: [], exclusions: [], audience: "", answerCriteria: "" };
  }
  const objective = readText(input.objective);
  if (objective.length < RESEARCH_POLICY.scopeObjectiveMinChars) {
    failures.push({
      field: "brief.objective",
      code: "objective_missing",
      message: `研究目标至少需要 ${RESEARCH_POLICY.scopeObjectiveMinChars} 个字符。`,
    });
  }
  const inclusions = readStringList(input.inclusions);
  if (inclusions === undefined) {
    failures.push({ field: "brief.inclusions", code: "inclusions_missing", message: "纳入范围必须是字符串数组。" });
  }
  const exclusions = readNonEmptyStringList(input.exclusions);
  if (exclusions === undefined) {
    failures.push({
      field: "brief.exclusions",
      code: "exclusions_missing",
      message: "排除范围至少要有一项：不研究什么必须由用户明确说清。",
    });
  }
  const audience = readText(input.audience);
  if (audience.length === 0) {
    failures.push({ field: "brief.audience", code: "audience_missing", message: "受众与输出期待未填写。" });
  }
  const answerCriteria = readText(input.answerCriteria);
  if (answerCriteria.length === 0) {
    failures.push({
      field: "brief.answerCriteria",
      code: "answer_criteria_missing",
      message: "「什么算答够了」未填写：这是语义充分性的唯一依据。",
    });
  }
  return {
    objective,
    inclusions: inclusions ?? [],
    exclusions: exclusions ?? [],
    audience,
    answerCriteria,
  };
}

function readQuestions(
  input: unknown,
  failures: ResearchScopeGateFailure[],
): ResearchApprovedScope["questions"] {
  if (!Array.isArray(input)) {
    failures.push({ field: "questions", code: "questions_missing", message: "缺少初始问题树。" });
    return [];
  }
  if (input.length < RESEARCH_POLICY.minQuestions || input.length > RESEARCH_POLICY.maxQuestions) {
    failures.push({
      field: "questions",
      code: "question_count_out_of_range",
      message: `初始问题数必须在 ${RESEARCH_POLICY.minQuestions} 至 ${RESEARCH_POLICY.maxQuestions} 之间。`,
    });
  }
  const questions: ResearchScopeQuestion[] = [];
  input.forEach((entry, index) => {
    const question = readQuestion(entry, index, failures);
    if (question !== undefined) questions.push(question);
  });
  return questions;
}

function readQuestion(
  input: unknown,
  index: number,
  failures: ResearchScopeGateFailure[],
): ResearchScopeQuestion | undefined {
  const record = asRecord(input);
  if (record === undefined) {
    failures.push({ field: `questions[${index}]`, code: "questions_missing", message: "问题条目缺失。" });
    return undefined;
  }
  const text = readText(record.text);
  if (text.length === 0) {
    failures.push({ field: `questions[${index}].text`, code: "question_text_missing", message: "问题正文未填写。" });
  }
  const priority = record.priority;
  if (priority !== "critical" && priority !== "normal" && priority !== "optional") {
    failures.push({
      field: `questions[${index}].priority`,
      code: "question_priority_invalid",
      message: "问题优先级必须是 critical / normal / optional。",
    });
  }
  const boundaryNote = readText(record.boundaryNote);
  if (boundaryNote.length === 0) {
    failures.push({
      field: `questions[${index}].boundaryNote`,
      code: "question_boundary_note_missing",
      message: "每个问题都必须说明边界：查到哪里算查完。",
    });
  }
  if (text.length === 0 || boundaryNote.length === 0) return undefined;
  return {
    text,
    priority: (priority === "critical" || priority === "normal" || priority === "optional") ? priority : "normal",
    boundaryNote,
  };
}

function readApproval(
  input: Record<string, unknown> | undefined,
  failures: ResearchScopeGateFailure[],
): { readonly payloadHash: string; readonly approvedAt: number; readonly conversationRef: string } {
  if (input === undefined) {
    failures.push({ field: "approval", code: "approval_missing", message: "缺少用户批准记录：范围卡是唯一启动路径。" });
    return { payloadHash: "", approvedAt: 0, conversationRef: "" };
  }
  const payloadHash = readText(input.payloadHash);
  if (payloadHash.length > 0 && !PAYLOAD_HASH_PATTERN.test(payloadHash)) {
    failures.push({
      field: "approval.payloadHash",
      code: "approval_payload_hash_missing",
      message: "批准记录的 payload 哈希不是有效的 sha256 十六进制字符串。",
    });
  }
  const approvedAt = input.approvedAt;
  if (typeof approvedAt !== "number" || !Number.isFinite(approvedAt) || approvedAt <= 0) {
    failures.push({ field: "approval.approvedAt", code: "approved_at_missing", message: "批准时间无效。" });
  }
  const conversationRef = readText(input.conversationRef);
  if (conversationRef.length === 0) {
    failures.push({ field: "approval.conversationRef", code: "conversation_ref_missing", message: "批准记录缺少会话引用。" });
  }
  return {
    payloadHash,
    approvedAt: typeof approvedAt === "number" && Number.isFinite(approvedAt) ? approvedAt : 0,
    conversationRef,
  };
}

function readDisclosure(
  input: unknown,
  failures: ResearchScopeGateFailure[],
): ResearchScopeSearchDisclosure | undefined {
  if (input === undefined || input === null) return undefined;
  const record = asRecord(input);
  if (record === undefined) {
    failures.push({
      field: "scopeSearchDisclosure",
      code: "scope_search_disclosure_over_limit",
      message: "澄清期检索披露形状无效。",
    });
    return undefined;
  }
  const snippetSearches = record.snippetSearches;
  if (typeof snippetSearches !== "number" || !Number.isInteger(snippetSearches) || snippetSearches < 0) {
    failures.push({
      field: "scopeSearchDisclosure.snippetSearches",
      code: "scope_search_disclosure_over_limit",
      message: "澄清期摘要级检索次数必须是非负整数。",
    });
    return undefined;
  }
  if (snippetSearches > MAX_SCOPE_SEARCH_DISCLOSURE) {
    failures.push({
      field: "scopeSearchDisclosure.snippetSearches",
      code: "scope_search_disclosure_over_limit",
      message: `澄清期摘要级检索次数不得超过 ${MAX_SCOPE_SEARCH_DISCLOSURE} 次。`,
    });
    return undefined;
  }
  return { snippetSearches };
}

export function describeScopeGateFailures(
  failures: readonly ResearchScopeGateFailure[],
): string {
  if (failures.length === 0) return "研究范围未通过结构校验。";
  return `研究范围未通过结构校验，缺少：${failures.map((failure) => failure.field).join("、")}。`;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim());
}

function readNonEmptyStringList(value: unknown): readonly string[] | undefined {
  const list = readStringList(value);
  if (list === undefined) return undefined;
  const nonEmpty = list.filter((item) => item.length > 0);
  return nonEmpty.length === 0 ? undefined : nonEmpty;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
