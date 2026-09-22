import type {
  ResearchAttributionType,
  ResearchCitationVerdict,
  ResearchReportSpanDraft,
} from "../contracts.js";

/**
 * 报告成稿子系统的库内契约（M9 纯库切片：零接线、不改任何既有文件）。
 *
 * 位置说明：本文件只放「渲染器/硬门/抽样/导出」这条链路上的类型与枚举。
 * 持久化形状（ResearchReport / ResearchReportSpan / ResearchReportSpanDraft）归
 * `../contracts.js` 的 S1 契约，本切片只读取、不扩展；模型输出契约（snake_case）
 * 与库内形状（camelCase + section + ordinal）的差异在 spans.ts 解析时收口。
 *
 * 分工（ADR 0001 §2.5 / §2.7）：
 * - 模型负责研究判断：写哪些 span、每个 span 归因什么、引用哪些 claim/source；
 * - 渲染器负责工程义务：固定六节结构、引用语法、access_level 标注——模型与导出层
 *   都无权自定义；
 * - 硬门负责发布判定：账本事实核验，任一不过即拒绝发布，不生成「差一点就发布」的报告。
 */

/** 固定六节（数组顺序即渲染顺序；渲染器只认这一份定义）。 */
export const RESEARCH_REPORT_SECTIONS = [
  "summary",
  "background",
  "analysis",
  "conclusions",
  "disagreements",
  "limitations",
] as const;

export type ResearchReportSection = (typeof RESEARCH_REPORT_SECTIONS)[number];

/** 六节标题只做展示；程序分支用 section 结构值，不用标题文案。 */
export const RESEARCH_REPORT_SECTION_TITLES: Readonly<Record<ResearchReportSection, string>> = {
  summary: "摘要",
  background: "背景与范围",
  analysis: "主体分析",
  conclusions: "结论与建议",
  disagreements: "分歧与争议",
  limitations: "缺口与限制",
};

/**
 * 事实性归因：source_statement 与 synthesis 陈述外部事实，必须带 claim 归因与引用；
 * inference 是模型自己的推断（§6.5「来源没有直接给出该结论」），可以不带引用。
 */
export const RESEARCH_FACTUAL_ATTRIBUTION_TYPES: ReadonlySet<ResearchAttributionType> = new Set([
  "source_statement",
  "synthesis",
]);

/** 模型输出契约里的 span 条目（snake_case：与提示词给模型的键名逐字一致）。 */
export type ResearchReportSpanModelEntry = {
  readonly text: string;
  readonly claim_ids: readonly string[];
  readonly attribution_type: ResearchAttributionType;
  readonly citation_source_ids: readonly string[];
  readonly section: ResearchReportSection;
};

/**
 * 模型输出信封：span[] + 本报告显式引用（Declaration）的 Gap/Conflict id。
 *
 * gap_ids / conflict_ids 是「Gap/Conflict 引用真实实体」硬门检查的对象：
 * 模型必须声明分歧与争议、缺口与限制两节基于哪些真实账本实体书写，
 * 渲染器不渲染这些 id（内部标识不外泄），硬门逐 id 核对存在性。
 */
export type ResearchReportModelOutput = {
  readonly title: string;
  readonly spans: readonly ResearchReportSpanModelEntry[];
  readonly gap_ids: readonly string[];
  readonly conflict_ids: readonly string[];
};

/** 解析后的库内 span：ordinal 与 ResearchReportSpan.ordinal 对齐（1 起，输入顺序）。 */
export type ResearchComposedSpan = {
  readonly ordinal: number;
  readonly text: string;
  readonly claimIds: readonly string[];
  readonly attributionType: ResearchAttributionType;
  readonly citationSourceIds: readonly string[];
  readonly section: ResearchReportSection;
};

/** 解析成功后的报告草稿：段落顺序即 ordinal 顺序，渲染与硬门都消费它。 */
export type ResearchReportDraft = {
  readonly title: string;
  readonly spans: readonly ResearchComposedSpan[];
  readonly gapIds: readonly string[];
  readonly conflictIds: readonly string[];
};

// ---------------------------------------------------------------------------
// 解析失败（模型输出契约层：形状/枚举/必填缺失，供调用方决定重试）
// ---------------------------------------------------------------------------

export type ResearchReportParseFailureCode =
  | "envelope_invalid"
  | "title_missing"
  | "title_url_reserved"
  | "spans_missing"
  | "span_count_over_limit"
  | "span_text_missing"
  | "span_text_over_limit"
  | "span_text_url_reserved"
  | "span_claim_ids_invalid"
  | "span_attribution_invalid"
  | "span_citation_sources_invalid"
  | "span_section_invalid"
  | "section_empty"
  | "gap_ids_invalid"
  | "conflict_ids_invalid";

/** 一条结构失败：field 是稳定结构路径，code 负责程序分支，message 只做展示。 */
export type ResearchReportParseFailure = {
  readonly field: string;
  readonly code: ResearchReportParseFailureCode;
  readonly message: string;
};

export type ResearchReportParseResult =
  | { readonly ok: true; readonly draft: ResearchReportDraft }
  | { readonly ok: false; readonly failures: readonly ResearchReportParseFailure[] };

// ---------------------------------------------------------------------------
// 确定性硬门（发布判定：账本事实核验）
// ---------------------------------------------------------------------------

export type ResearchReportGateFailureCode =
  /** 模型输出没有通过结构解析：按拒绝发布处理（细节见 parse 失败清单）。 */
  | "model_output_invalid"
  /** 零保留来源：模型写不出可引用句子，不成稿（ADR §2.4 终止路径）。 */
  | "report_no_citable_source"
  /** span 无 claim 归因（claim_ids 为空）。 */
  | "span_claim_unattributed"
  /** 引用的 claim 不存在于账本。 */
  | "span_claim_missing"
  /** 被引用 claim 没有已存在的证据支撑（evidence 不存在/为空）。 */
  | "span_claim_evidence_missing"
  /** 引用的 citation source 不存在于账本。 */
  | "span_citation_source_missing"
  /** 事实性 span 没有引用任何来源。 */
  | "span_factual_citation_missing"
  /** access_level 与表述不一致： unavailable 来源不能支撑事实句。 */
  | "span_citation_source_unavailable"
  /** 引文没有落在已保存内容的 content hash 上（quote 不可核验）。 */
  | "span_quote_not_verified"
  /** span 正文出现内部标识（sourceId/evidenceId 等永不进入用户可见产物）。 */
  | "span_internal_id_leaked"
  /** 标题出现内部标识：标题与 span 正文走同一套用户可见产物管控（ADR §2.5）。 */
  | "title_internal_id_leaked"
  /** 声明的 Gap 引用不存在。 */
  | "gap_reference_missing"
  /** 声明的 Conflict 引用不存在。 */
  | "conflict_reference_missing";

/** 一条硬门拒绝：spanOrdinal 指向具体段落（非 span 级检查为 null）。 */
export type ResearchReportGateFailure = {
  readonly code: ResearchReportGateFailureCode;
  readonly spanOrdinal: number | null;
  readonly field: string;
  readonly message: string;
};

export type ResearchReportGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failures: readonly ResearchReportGateFailure[] };

// ---------------------------------------------------------------------------
// 语义抽样核验（测量，不阻断发布）
// ---------------------------------------------------------------------------

/** 失败处理的许可路径（设计草案 §8.4）：verifier 不得自动换引用或改结论。 */
export type ResearchCitationRemediation = "narrow_claim" | "switch_to_inference" | "reopen_question";

/** 一条抽样核验项：一个（span, claim）对，挂在其覆盖的问题下。 */
export type ResearchCitationSampleItem = {
  readonly questionId: string;
  readonly spanOrdinal: number;
  readonly claimId: string;
  readonly evidenceIds: readonly string[];
  /** verifier 输入：问题 + claim + 证据卡 + span 正文的确定性装配（同状态同文本）。 */
  readonly verifierInput: string;
};

export type ResearchCitationSample = {
  readonly sampledQuestionIds: readonly string[];
  readonly items: readonly ResearchCitationSampleItem[];
};

/** 一条 verifier 判定：verdict 接受 string——S5w 在信任边界灌入 verifier 模型原始输出，枚举外值显式进 rejected 桶。 */
export type ResearchCitationVerdictInput = {
  readonly spanOrdinal: number;
  readonly claimId: string;
  readonly verdict: string;
};

/** 本任务引用支撑率：展示给用户并作回归指标，不阻断发布。 */
export type ResearchCitationSupportRate = {
  readonly sampled: number;
  readonly supports: number;
  readonly partiallySupports: number;
  readonly contradicts: number;
  readonly doesNotSupport: number;
  readonly insufficientContext: number;
  /**
   * 枚举外判定的条数：单独成桶、不计入 sampled、不进 supportRate 分子分母。
   * verifier 输出天然不可信；静默吞掉会破坏 sampled=Σbuckets 的计数不变量，
   * 按 insufficient_context 计又会伪装成核验结论，因此显式单列。
   */
  readonly rejected: number;
  /** (supports + partially_supports) / sampled；无抽样项时为 null。 */
  readonly supportRate: number | null;
  /** 非支撑判定的许可处理路径（只列动作，不改账本——执行归 S5w）。 */
  readonly remediations: readonly {
    readonly spanOrdinal: number;
    readonly claimId: string;
    readonly verdict: ResearchCitationVerdict;
    readonly allowedActions: readonly ResearchCitationRemediation[];
  }[];
};

// ---------------------------------------------------------------------------
// 库输出契约
// ---------------------------------------------------------------------------

export type ResearchReportComposition = {
  /** parse 与硬门都通过且已生成 Markdown 时为 true（唯一可发布形态）。 */
  readonly ok: boolean;
  readonly title: string | null;
  readonly spans: readonly ResearchComposedSpan[];
  /** 原生形态 Markdown；解析失败或硬门拒绝时为 null（不生成「差一点就发布」的报告）。 */
  readonly markdown: string | null;
  readonly gate: ResearchReportGateResult;
  readonly supportRate: ResearchCitationSupportRate | null;
  /** 解析细节：S5w 据此区分「重试模型调用」与「拒绝发布」。 */
  readonly parse: ResearchReportParseResult;
};

/** 库内 span → S1 持久化草稿：section / ordinal 是渲染期契约，不进账本。 */
export function toResearchReportSpanDrafts(
  spans: readonly ResearchComposedSpan[],
): readonly ResearchReportSpanDraft[] {
  return spans.map((span) => ({
    text: span.text,
    claimIds: span.claimIds,
    attributionType: span.attributionType,
    citationSourceIds: span.citationSourceIds,
  }));
}
