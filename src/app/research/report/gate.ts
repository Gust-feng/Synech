import type {
  ResearchEvidenceItemRead,
  ResearchLedger,
  ResearchSourceEntry,
} from "../contracts.js";
import {
  RESEARCH_FACTUAL_ATTRIBUTION_TYPES,
  RESEARCH_REPORT_POLICY,
  type ResearchReportDraft,
  type ResearchReportGateFailure,
  type ResearchReportGateResult,
} from "./contracts.js";

/**
 * 确定性硬门（设计草案 §10.1 / ADR 0001 §2.4、§2.5、§2.7）：
 * 不过不得发布。任一检查失败即返回结构化拒绝原因，不生成「差一点就发布」的报告。
 *
 * 检查项与代码路径（每条对应一条失败码）：
 * 1. report_no_citable_source          零保留来源：模型写不出可引用句子，不成稿；
 * 2. span_claim_unattributed           每个 span 必须有 claim 归因（claim_ids 非空）；
 * 3. span_claim_missing                引用的 claim 必须存在于账本；
 * 4. span_claim_evidence_missing       被引用 claim 必须绑定已存在的 Evidence；
 * 5. span_citation_source_missing      引用的 citation source 必须存在于账本；
 * 6. span_factual_citation_missing     事实性 span（source_statement/synthesis）必须带引用；
 * 7. span_citation_source_unavailable  access_level 与表述一致：unavailable 来源不能支撑事实句；
 * 8. span_quote_not_verified           引文必须落在已保存内容的 content hash 上（quote 可核验）；
 * 9. span_internal_id_leaked           内部标识永不进入用户可见产物；
 * 10. gap_reference_missing           声明的 Gap 必须引用真实实体；
 * 11. conflict_reference_missing      声明的 Conflict 必须引用真实实体。
 *
 * 边界说明（写进交付说明的设计决策）：
 * - 「access_level 与表述一致」中「表述深度」无法对自然语言做确定性判定；框架的确定性
 *   防线是：unavailable 来源不得支撑事实句（第 7 条）+ 渲染器在每个引用上标注 access_level
 *   （渲染后用户始终看得见读取深度）+ 逐字引文必须有 content hash（第 8 条）。
 * - quote 核验链：span 正文的逐字引文 ⊆ 该 span **已引用来源名下**的背书 Evidence 的
 *   excerpt，且该 Evidence 所属来源的 content_hash 非空（内容真的被抓取并哈希过）。
 *   仅摘要级（未抓取）来源不支持逐字引文——摘要不等于全文，模型可以改写而不是照抄。
 *   背书范围含 claim 绑定证据是对第 9 条（Evidence.source_id 与引用一致，设计 §10.1）
 *   的让步修复：候选 evidence 只收 sourceId ∈ span.citationSourceIds 的（含其 claim
 *   绑定证据中来源被本 span 引用的那些），span 未引用的来源不得背书其引文——否则渲染
 *   会把引文错位挂到用户点开的来源名下。
 */

/** 引文定界符：中文直角引号、中文弯引号、英文直引号对。 */
const QUOTE_PAIR_PATTERN = /「([^」]{2,})」|“([^”]{2,})”|"([^"]{2,})"/gu;

export function evaluateResearchReportGate(input: {
  readonly ledger: ResearchLedger;
  readonly draft: ResearchReportDraft;
}): ResearchReportGateResult {
  const { ledger, draft } = input;
  const failures: ResearchReportGateFailure[] = [];

  const sourcesById = new Map(ledger.sources.map((source) => [source.id, source]));
  const claimsById = new Map(ledger.claims.map((claim) => [claim.id, claim]));
  const evidenceById = new Map(ledger.evidence.map((item) => [item.id, item]));
  const gapsById = new Set(ledger.gaps.map((gap) => gap.id));
  const conflictsById = new Set(ledger.conflicts.map((conflict) => conflict.id));
  const internalIds = collectInternalIds(ledger);

  if (ledger.sources.length === 0) {
    failures.push({
      code: "report_no_citable_source",
      spanOrdinal: null,
      field: "sources",
      message: "本任务没有保留任何可引用来源，无法成稿。",
    });
  }

  // 标题与 span 正文走同一套用户可见产物管控：标题原样渲染为 `# …` 并随
  // finishTask 持久化，内部标识出现在标题里同样不得发布（链接禁令在解析层）。
  const leakedInTitle = findLeakedInternalId(draft.title, internalIds);
  if (leakedInTitle !== undefined) {
    failures.push({
      code: "title_internal_id_leaked",
      spanOrdinal: null,
      field: "title",
      message: `标题出现内部标识，用户可见产物不得包含：${leakedInTitle}。`,
    });
  }

  for (const span of draft.spans) {
    const field = `spans[${span.ordinal}]`;

    // 2. 归因：每个 span 必须挂靠 claim（含 inference：推断本身也是 claim）。
    if (span.claimIds.length === 0) {
      failures.push({
        code: "span_claim_unattributed",
        spanOrdinal: span.ordinal,
        field: `${field}.claimIds`,
        message: "span 没有 claim 归因：没有归因的事实句不得出现。",
      });
    }

    // 3 + 4. claim 存在且绑定已存在 Evidence。
    for (const claimId of span.claimIds) {
      const claim = claimsById.get(claimId);
      if (claim === undefined) {
        failures.push({
          code: "span_claim_missing",
          spanOrdinal: span.ordinal,
          field: `${field}.claimIds`,
          message: `引用的主张不存在：${claimId}。`,
        });
        continue;
      }
      if (claim.evidenceIds.length === 0) {
        failures.push({
          code: "span_claim_evidence_missing",
          spanOrdinal: span.ordinal,
          field: `${field}.claimIds`,
          message: `被引用的主张没有绑定任何证据：${claimId}。`,
        });
        continue;
      }
      for (const evidenceId of claim.evidenceIds) {
        if (!evidenceById.has(evidenceId)) {
          failures.push({
            code: "span_claim_evidence_missing",
            spanOrdinal: span.ordinal,
            field: `${field}.claimIds`,
            message: `被引用主张绑定的证据不存在：${evidenceId}。`,
          });
        }
      }
    }

    // 5. citation source 存在。
    for (const sourceId of span.citationSourceIds) {
      if (!sourcesById.has(sourceId)) {
        failures.push({
          code: "span_citation_source_missing",
          spanOrdinal: span.ordinal,
          field: `${field}.citationSourceIds`,
          message: `引用的来源不存在：${sourceId}。`,
        });
      }
    }

    // 6 + 7. 事实性 span：必须带引用，且不得引用 unavailable 来源。
    if (RESEARCH_FACTUAL_ATTRIBUTION_TYPES.has(span.attributionType)) {
      if (span.citationSourceIds.length === 0) {
        failures.push({
          code: "span_factual_citation_missing",
          spanOrdinal: span.ordinal,
          field: `${field}.citationSourceIds`,
          message: "事实性 span 必须引用至少一个来源。",
        });
      }
      for (const sourceId of span.citationSourceIds) {
        const source = sourcesById.get(sourceId);
        if (source !== undefined && source.accessLevel === "unavailable") {
          failures.push({
            code: "span_citation_source_unavailable",
            spanOrdinal: span.ordinal,
            field: `${field}.citationSourceIds`,
            message: `来源读取深度为 unavailable，不能支撑事实性表述：${sourceId}。`,
          });
        }
      }
    }

    // 8. 逐字引文必须落在已引用来源的、已保存且带 content hash 的证据内容上。
    const backingEvidence = collectBackingEvidence(span.citationSourceIds, evidenceById);
    for (const quote of extractQuotedSegments(span.text)) {
      if (!isQuoteVerified(quote, backingEvidence, sourcesById)) {
        failures.push({
          code: "span_quote_not_verified",
          spanOrdinal: span.ordinal,
          field: `${field}.text`,
          message: `引文没有落在已保存内容上（quote 不落 content hash）：${clip(quote, 40)}。`,
        });
      }
    }

    // 9. 内部标识不外泄。
    const leaked = findLeakedInternalId(span.text, internalIds);
    if (leaked !== undefined) {
      failures.push({
        code: "span_internal_id_leaked",
        spanOrdinal: span.ordinal,
        field: `${field}.text`,
        message: `span 正文出现内部标识，用户可见产物不得包含：${leaked}。`,
      });
    }
  }

  for (const gapId of draft.gapIds) {
    if (!gapsById.has(gapId)) {
      failures.push({
        code: "gap_reference_missing",
        spanOrdinal: null,
        field: "gapIds",
        message: `引用的缺口不存在：${gapId}。`,
      });
    }
  }
  for (const conflictId of draft.conflictIds) {
    if (!conflictsById.has(conflictId)) {
      failures.push({
        code: "conflict_reference_missing",
        spanOrdinal: null,
        field: "conflictIds",
        message: `引用的分歧不存在：${conflictId}。`,
      });
    }
  }

  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

/**
 * span 的背书证据：**只收 sourceId ∈ span.citationSourceIds 的证据**
 * （设计 §10.1「Evidence.source_id 与引用一致」）。
 *
 * 覆盖「span 直接引用来源 S，quote 来自 S 名下的证据」——包括挂到该 span 的 claim
 * 上的与未挂的两类。span 未引用的来源名下的证据不得背书其引文：否则渲染会把引文
 * 错位挂到用户点开的来源名下（用户在该来源里找不到这句原文）。模型若要让某来源的
 * 证据背书引文，就必须把该来源列入 citation_source_ids。
 */
function collectBackingEvidence(
  citationSourceIds: readonly string[],
  evidenceById: ReadonlyMap<string, ResearchEvidenceItemRead>,
): readonly ResearchEvidenceItemRead[] {
  const citedSources = new Set(citationSourceIds);
  return [...evidenceById.values()].filter((item) => citedSources.has(item.sourceId));
}

/** 取出正文里的逐字引文段（已归一化空白）。 */
export function extractQuotedSegments(text: string): readonly string[] {
  const segments: string[] = [];
  for (const match of text.matchAll(QUOTE_PAIR_PATTERN)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    const normalized = raw.replace(/\s+/gu, "").trim();
    if (normalized.length >= 2) segments.push(normalized);
  }
  return segments;
}

/**
 * quote 核验：归一化后是某条背书证据 excerpt 的子串，且该证据所属来源的
 * content_hash 非空（quote 落在已抓取并哈希保存的内容上）。
 */
function isQuoteVerified(
  quote: string,
  backingEvidence: readonly ResearchEvidenceItemRead[],
  sourcesById: ReadonlyMap<string, ResearchSourceEntry>,
): boolean {
  return backingEvidence.some((item) => {
    const source = sourcesById.get(item.sourceId);
    if (source === undefined || source.contentHash === null) return false;
    return item.excerpt.replace(/\s+/gu, "").includes(quote);
  });
}

/** 任务内全部内部标识（含问题/claim/evidence/source/gap/conflict）。 */
function collectInternalIds(ledger: ResearchLedger): readonly string[] {
  const ids = new Set<string>();
  const add = (id: string): void => {
    if (id.length >= RESEARCH_REPORT_POLICY.internalIdMinChars) ids.add(id);
  };
  for (const source of ledger.sources) add(source.id);
  for (const item of ledger.evidence) add(item.id);
  for (const claim of ledger.claims) add(claim.id);
  for (const gap of ledger.gaps) add(gap.id);
  for (const conflict of ledger.conflicts) add(conflict.id);
  for (const question of ledger.questions) add(question.id);
  return [...ids].sort();
}

/** 用户可见文本（标题/span 正文）里的第一个内部标识；没有则 undefined。 */
function findLeakedInternalId(text: string, internalIds: readonly string[]): string | undefined {
  return internalIds.find((id) => text.includes(id));
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
