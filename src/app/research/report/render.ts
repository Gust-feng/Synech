import type {
  ResearchClaimRead,
  ResearchEvidenceItemRead,
  ResearchLedger,
  ResearchSourceAccessLevel,
  ResearchSourceEntry,
} from "../contracts.js";
import {
  RESEARCH_REPORT_SECTIONS,
  RESEARCH_REPORT_SECTION_TITLES,
  type ResearchComposedSpan,
  type ResearchReportDraft,
} from "./contracts.js";

/**
 * 确定性 MD 渲染器：span[] → Markdown（固定六节）。
 *
 * 引用语法由渲染器独占（ADR 0001 §2.5）：模型与导出层都无权自定义。span 正文是纯散文，
 * 引用经 citation_source_ids 声明，由这里渲染成「可点开 URL + 来源标题 + access_level
 * 标注 + 证据定位」的自包含引用——离开应用后仍然成立，且 evidenceId/sourceId 等内部
 * 标识永远不会出现在产物里（产出只含标题、URL、定位与读取深度）。
 *
 * 确定性：同一 draft + 同一 ledger 两次渲染逐字节相同（无时间戳、无随机、
 * 证据选择按 id 排序）；MD 是报告的原生形态，导出=写文件，不存在第二套渲染器。
 */

export function renderResearchReportMarkdown(input: {
  readonly draft: ResearchReportDraft;
  readonly ledger: ResearchLedger;
}): string {
  const { draft, ledger } = input;
  const sourcesById = new Map(ledger.sources.map((source) => [source.id, source]));
  const evidenceById = new Map(ledger.evidence.map((item) => [item.id, item]));

  const lines: string[] = [`# ${draft.title}`, ""];
  for (const section of RESEARCH_REPORT_SECTIONS) {
    lines.push(`## ${RESEARCH_REPORT_SECTION_TITLES[section]}`, "");
    for (const span of draft.spans.filter((item) => item.section === section)) {
      lines.push(renderSpan(span, sourcesById, evidenceById, ledger.claims), "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderSpan(
  span: ResearchComposedSpan,
  sourcesById: ReadonlyMap<string, ResearchSourceEntry>,
  evidenceById: ReadonlyMap<string, ResearchEvidenceItemRead>,
  claims: readonly ResearchClaimRead[],
): string {
  const prefix = span.attributionType === "synthesis"
    ? "**【综合】** "
    : span.attributionType === "inference"
      ? "**【推断】** "
      : "";
  const citations = span.citationSourceIds
    .map((sourceId) => renderCitation(sourceId, span.claimIds, sourcesById, evidenceById, claims))
    .filter((citation): citation is string => citation !== undefined);
  const suffix = citations.length > 0 ? ` ${citations.join("；")}` : "";
  return `${prefix}${span.text}${suffix}`;
}

/**
 * 单条引用：`[标题](URL)（读取深度，证据定位）`。
 * access_level 是结构字段，这里只取它的展示标签；定位取该 span 的 claim 背书中
 * 属于该来源的第一条证据（按 locator 排序的第一个，确定性选择）。
 */
function renderCitation(
  sourceId: string,
  claimIds: readonly string[],
  sourcesById: ReadonlyMap<string, ResearchSourceEntry>,
  evidenceById: ReadonlyMap<string, ResearchEvidenceItemRead>,
  claims: readonly ResearchClaimRead[],
): string | undefined {
  const source = sourcesById.get(sourceId);
  if (source === undefined) return undefined;
  const locator = pickLocator(sourceId, claimIds, evidenceById, claims);
  const annotation = [
    ACCESS_LEVEL_LABELS[source.accessLevel],
    ...(locator === undefined ? [] : [locator]),
  ].join("，");
  const title = source.title.trim() || source.domain || source.canonicalUrl;
  return `[${escapeLinkText(title)}](${formatUrl(source.canonicalUrl)})（${annotation}）`;
}

function pickLocator(
  sourceId: string,
  claimIds: readonly string[],
  evidenceById: ReadonlyMap<string, ResearchEvidenceItemRead>,
  claims: readonly ResearchClaimRead[],
): string | undefined {
  const claimEvidenceIds = new Set(
    claimIds.flatMap((claimId) => claims.find((claim) => claim.id === claimId)?.evidenceIds ?? []),
  );
  const locators = [...evidenceById.values()]
    .filter((item) => item.sourceId === sourceId && claimEvidenceIds.has(item.id))
    .map((item) => item.locator.trim())
    .filter((locator) => locator.length > 0)
    .sort();
  return locators[0];
}

const ACCESS_LEVEL_LABELS: Readonly<Record<ResearchSourceAccessLevel, string>> = {
  snippet: "摘要级",
  partial: "部分正文",
  fulltext: "全文",
  unavailable: "不可读",
};

/** 链接文本转义：标题里的方括号会破坏 Markdown 链接语法。 */
function escapeLinkText(text: string): string {
  return text.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

/** URL 格式化：含空白或括号的 URL 用尖括号包住，保证点击可达。 */
function formatUrl(url: string): string {
  return /[\s()]/u.test(url) ? `<${url}>` : url;
}
