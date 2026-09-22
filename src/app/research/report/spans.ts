import type { ResearchAttributionType } from "../contracts.js";
import { RESEARCH_POLICY } from "../research-policy.js";
import {
  RESEARCH_REPORT_SECTIONS,
  type ResearchComposedSpan,
  type ResearchReportParseFailure,
  type ResearchReportParseFailureCode,
  type ResearchReportParseResult,
  type ResearchReportSection,
} from "./contracts.js";

/**
 * ReportSpan 解析与结构校验：模型输出（unknown JSON）→ span[]。
 *
 * 这一层只校验「模型输出契约」：信封形状、键名、枚举、必填与上界。
 * 账本事实核验（引用是否存在、quote 是否落 content hash、access_level 是否一致）
 * 归 gate.ts——两边规则不同：契约失败 → 调用方重试模型调用；事实失败 → 拒绝发布。
 *
 * 一条内容纪律在解析层强制（ADR 0001 §2.5「引用语法由渲染器独占」）：
 * span 正文不得包含 Markdown 链接或裸 URL——引用只能经 citation_source_ids 声明，
 * 由渲染器换成人可读引用；模型自己写链接等于自定义引用语法。
 * 空 claim_ids 在形状上合法（归因与否由硬门检查），但空字符串 id、越界 section、
 * 六节缺失一律在此拒绝。
 */

const ATTRIBUTION_TYPES: ReadonlySet<string> = new Set([
  "source_statement",
  "synthesis",
  "inference",
]);

const SECTION_SET: ReadonlySet<string> = new Set(RESEARCH_REPORT_SECTIONS);

/** Markdown 链接语法：`[text](url)`。 */
const MARKDOWN_LINK_PATTERN = /\]\([^)]*\)/u;
/** 裸 URL：模型要把来源写进产物只能走 citation_source_ids。 */
const BARE_URL_PATTERN = /https?:\/\//iu;

export function parseResearchReportModelOutput(value: unknown): ResearchReportParseResult {
  const failures: ResearchReportParseFailure[] = [];
  const envelope = asRecord(value);
  if (envelope === undefined) {
    return {
      ok: false,
      failures: [{ field: "$", code: "envelope_invalid", message: "模型输出不是一个 JSON 对象。" }],
    };
  }

  const title = readText(envelope.title);
  if (title.length === 0) {
    failures.push({ field: "title", code: "title_missing", message: "报告标题缺失。" });
  } else if (MARKDOWN_LINK_PATTERN.test(title) || BARE_URL_PATTERN.test(title)) {
    // 标题与 span 正文走同一套用户可见产物管控：引用语法由渲染器独占，
    // 标题原样进入 `# …` 首行并随 finishTask 持久化，不过即拒。
    failures.push({
      field: "title",
      code: "title_url_reserved",
      message: "标题不得包含链接：引用语法由渲染器独占。",
    });
  }

  const spans = readSpans(envelope.spans, failures);
  const gapIds = readIdList(envelope.gap_ids, "gap_ids", "gap_ids_invalid", failures);
  const conflictIds = readIdList(envelope.conflict_ids, "conflict_ids", "conflict_ids_invalid", failures);

  if (spans !== undefined) {
    const missing = RESEARCH_REPORT_SECTIONS.filter(
      (section) => !spans.some((span) => span.section === section),
    );
    if (missing.length > 0) {
      failures.push({
        field: "spans",
        code: "section_empty",
        message: `固定六节每节至少需要一个 span，缺少：${missing.join("、")}。`,
      });
    }
  }

  if (failures.length > 0) return { ok: false, failures };
  // title / spans 的不合法路径都在上面压入了失败；能到这里即草稿完整。
  return {
    ok: true,
    draft: {
      title,
      spans: spans ?? [],
      gapIds: gapIds ?? [],
      conflictIds: conflictIds ?? [],
    },
  };
}

function readSpans(
  value: unknown,
  failures: ResearchReportParseFailure[],
): readonly ResearchComposedSpan[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    failures.push({ field: "spans", code: "spans_missing", message: "报告正文 spans 缺失或为空。" });
    return undefined;
  }
  if (value.length > RESEARCH_POLICY.maxSpans) {
    failures.push({
      field: "spans",
      code: "span_count_over_limit",
      message: `span 数量 ${value.length} 超过上限 ${RESEARCH_POLICY.maxSpans}。`,
    });
    return undefined;
  }
  const spans: ResearchComposedSpan[] = [];
  value.forEach((entry, index) => {
    const span = readSpan(entry, index, failures);
    if (span !== undefined) spans.push({ ...span, ordinal: index + 1 });
  });
  return spans.length === value.length ? spans : undefined;
}

function readSpan(
  value: unknown,
  index: number,
  failures: ResearchReportParseFailure[],
): Omit<ResearchComposedSpan, "ordinal"> | undefined {
  const field = `spans[${index}]`;
  const record = asRecord(value);
  if (record === undefined) {
    failures.push({ field, code: "spans_missing", message: "span 条目缺失。" });
    return undefined;
  }

  const text = readText(record.text);
  const attribution = record.attribution_type;
  const section = record.section;
  const claimIds = readIdList(record.claim_ids, `${field}.claim_ids`, "span_claim_ids_invalid", failures);
  const citationSourceIds = readIdList(
    record.citation_source_ids, `${field}.citation_source_ids`, "span_citation_sources_invalid", failures,
  );

  if (text.length === 0) {
    failures.push({ field: `${field}.text`, code: "span_text_missing", message: "span 正文为空。" });
  } else if (text.length > RESEARCH_POLICY.spanMaxChars) {
    failures.push({
      field: `${field}.text`,
      code: "span_text_over_limit",
      message: `span 正文 ${text.length} 字符超过上限 ${RESEARCH_POLICY.spanMaxChars}。`,
    });
  } else if (MARKDOWN_LINK_PATTERN.test(text) || BARE_URL_PATTERN.test(text)) {
    failures.push({
      field: `${field}.text`,
      code: "span_text_url_reserved",
      message: "span 正文不得包含链接：引用语法由渲染器独占，请改用 citation_source_ids。",
    });
  }
  if (typeof attribution !== "string" || !ATTRIBUTION_TYPES.has(attribution)) {
    failures.push({
      field: `${field}.attribution_type`,
      code: "span_attribution_invalid",
      message: "attribution_type 必须是 source_statement / synthesis / inference。",
    });
  }
  if (typeof section !== "string" || !SECTION_SET.has(section)) {
    failures.push({
      field: `${field}.section`,
      code: "span_section_invalid",
      message: `section 必须是 ${RESEARCH_REPORT_SECTIONS.join(" / ")} 之一。`,
    });
  }

  const valid = text.length > 0
    && text.length <= RESEARCH_POLICY.spanMaxChars
    && !MARKDOWN_LINK_PATTERN.test(text)
    && !BARE_URL_PATTERN.test(text)
    && typeof attribution === "string" && ATTRIBUTION_TYPES.has(attribution)
    && typeof section === "string" && SECTION_SET.has(section)
    && claimIds !== undefined
    && citationSourceIds !== undefined;
  if (!valid) return undefined;
  return {
    text,
    claimIds: claimIds ?? [],
    attributionType: attribution as ResearchAttributionType,
    citationSourceIds: citationSourceIds ?? [],
    section: section as ResearchReportSection,
  };
}

/** id 列表：数组形状 + 非空字符串条目；段内重复按首现去重（确定性保留一条）。 */
function readIdList(
  value: unknown,
  field: string,
  code: ResearchReportParseFailureCode,
  failures: ResearchReportParseFailure[],
): readonly string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    failures.push({ field, code, message: `${field} 必须是字符串数组。` });
    return undefined;
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      failures.push({ field, code, message: `${field} 含有非字符串或空 id。` });
      return undefined;
    }
    const id = entry.trim();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
