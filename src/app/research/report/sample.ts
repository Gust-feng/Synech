import type { ResearchCitationVerdict, ResearchClaimType, ResearchLedger } from "../contracts.js";
import { RESEARCH_POLICY } from "../research-policy.js";
import {
  type ResearchCitationRemediation,
  type ResearchCitationSample,
  type ResearchCitationSampleItem,
  type ResearchCitationSupportRate,
  type ResearchCitationVerdictInput,
  type ResearchReportDraft,
} from "./contracts.js";

/**
 * 语义抽样核验（设计草案 §8.4 / §10.2）：抽样测量，不阻断发布。
 *
 * 与确定性硬门的分工：硬门回答「引用是否真实可解析」，抽样回答「引用的内容是否支撑
 * 报告表述」。后者由 verifier 模型判定，天生带误差，因此只做抽样（默认每任务 1 个
 * 已覆盖问题）、产出「本任务引用支撑率」展示给用户并作回归指标。
 *
 * verifier 只返回五值枚举（supports / partially_supports / contradicts /
 * does_not_support / insufficient_context），不得自动换引用或改结论；失败处理仅限
 * 收窄 claim / 改为 inference·uncertainty / reopen 问题——本切片只实现判定与返回，
 * 不改账本（执行归 S5w）。
 */

/** 计入「已支撑」的判定：明确支撑 + 部分支撑。 */
const SUPPORTING_VERDICTS: ReadonlySet<ResearchCitationVerdict> = new Set([
  "supports",
  "partially_supports",
]);

/** verifier 五值枚举：入口归一化用；枚举外值不得混入计数。 */
const VERDICT_ENUM: ReadonlySet<string> = new Set<ResearchCitationVerdict>([
  "supports",
  "partially_supports",
  "contradicts",
  "does_not_support",
  "insufficient_context",
]);

function isCitationVerdict(value: string): value is ResearchCitationVerdict {
  return VERDICT_ENUM.has(value);
}

const REMEDIATION_ACTIONS: readonly ResearchCitationRemediation[] = [
  "narrow_claim",
  "switch_to_inference",
  "reopen_question",
];

export function buildResearchCitationSample(input: {
  readonly ledger: ResearchLedger;
  readonly draft: ResearchReportDraft;
  readonly questionsPerTask?: number;
}): ResearchCitationSample {
  const perTask = input.questionsPerTask ?? RESEARCH_POLICY.citationSampleQuestionsPerTask;
  // 抽样对象是「已覆盖」问题（covered 只表示研究认为证据够用，不为真背书）；
  // 选取确定性：按 (createdAt, id) 排序取前 N 个，同一账本状态两次抽样相同。
  const covered = [...input.ledger.questions]
    .filter((question) => question.status === "covered")
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, perTask));

  const evidenceById = new Map(input.ledger.evidence.map((item) => [item.id, item]));
  const items: ResearchCitationSampleItem[] = [];
  for (const question of covered) {
    const questionEvidenceIds = input.ledger.evidence
      .filter((item) => item.questionIds.includes(question.id))
      .map((item) => item.id);
    const questionEvidenceIdSet = new Set(questionEvidenceIds);
    const claims = input.ledger.claims.filter((claim) =>
      claim.evidenceIds.some((evidenceId) => questionEvidenceIdSet.has(evidenceId)));
    const spans = input.draft.spans.filter((span) =>
      span.claimIds.some((claimId) => claims.some((claim) => claim.id === claimId)));
    for (const span of spans) {
      for (const claimId of span.claimIds) {
        const claim = claims.find((candidate) => candidate.id === claimId);
        if (claim === undefined) continue;
        items.push({
          questionId: question.id,
          spanOrdinal: span.ordinal,
          claimId,
          evidenceIds: claim.evidenceIds,
          verifierInput: buildVerifierInput(question.text, claim.text, claim.type, claim.evidenceIds, evidenceById, span.text),
        });
      }
    }
  }
  return { sampledQuestionIds: covered.map((question) => question.id), items };
}

/** verifier 输入：问题 + claim + 证据卡 + 报告段落的确定性装配（同状态同文本）。 */
function buildVerifierInput(
  questionText: string,
  claimText: string,
  claimType: ResearchClaimType,
  evidenceIds: readonly string[],
  evidenceById: ReadonlyMap<string, { readonly excerpt: string; readonly locator: string; readonly stance: string }>,
  spanText: string,
): string {
  const cards = evidenceIds
    .map((evidenceId) => evidenceById.get(evidenceId))
    .filter((item) => item !== undefined)
    .map((item) => `- 摘录（定位=${item.locator}，立场=${item.stance}）：${clip(item.excerpt, RESEARCH_POLICY.verifierExcerptMaxChars)}`);
  return [
    "判断下面的报告段落是否被其主张（claim）的证据支撑。",
    "只回答以下五个值之一：supports / partially_supports / contradicts / does_not_support / insufficient_context。",
    "",
    `问题：${questionText}`,
    `主张（${claimType}）：${claimText}`,
    "证据：",
    ...(cards.length > 0 ? cards : ["（无证据卡）"]),
    "",
    `报告段落：${spanText}`,
  ].join("\n");
}

export function readResearchCitationSupportRate(input: {
  readonly sample: ResearchCitationSample;
  readonly verdicts: readonly ResearchCitationVerdictInput[];
}): ResearchCitationSupportRate {
  // 同一抽样项的多次判定后到者覆盖（重试语义）；不在抽样项里的判定忽略。
  const byKey = new Map<string, ResearchCitationVerdictInput["verdict"]>();
  for (const verdict of input.verdicts) {
    byKey.set(`${verdict.spanOrdinal}|${verdict.claimId}`, verdict.verdict);
  }
  const counts = { supports: 0, partiallySupports: 0, contradicts: 0, doesNotSupport: 0, insufficientContext: 0 };
  const remediations: ResearchCitationSupportRate["remediations"][number][] = [];
  let sampled = 0;
  let rejected = 0;
  for (const item of input.sample.items) {
    const verdict = byKey.get(`${item.spanOrdinal}|${item.claimId}`);
    if (verdict === undefined) continue;
    // 信任边界：verifier 输出天然不可信。枚举外字符串单独进 rejected 桶——
    // 不计入 sampled、不进 supportRate 分子分母、不生成 remediation；
    // 静默吞掉会破坏 sampled=Σbuckets 的计数不变量，按 insufficient_context 计
    // 又会把格式错误伪装成核验结论，因此显式单列（调用方 S5w 可见并处置）。
    if (!isCitationVerdict(verdict)) {
      rejected += 1;
      continue;
    }
    sampled += 1;
    switch (verdict) {
      case "supports": counts.supports += 1; break;
      case "partially_supports": counts.partiallySupports += 1; break;
      case "contradicts": counts.contradicts += 1; break;
      case "does_not_support": counts.doesNotSupport += 1; break;
      case "insufficient_context": counts.insufficientContext += 1; break;
    }
    if (!SUPPORTING_VERDICTS.has(verdict)) {
      remediations.push({
        spanOrdinal: item.spanOrdinal,
        claimId: item.claimId,
        verdict,
        allowedActions: REMEDIATION_ACTIONS,
      });
    }
  }
  const supporting = counts.supports + counts.partiallySupports;
  return {
    sampled,
    ...counts,
    rejected,
    supportRate: sampled === 0 ? null : supporting / sampled,
    remediations,
  };
}

function clip(text: string, limit: number): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}
