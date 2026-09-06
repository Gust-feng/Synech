import { getEncoding, type Tiktoken } from "js-tiktoken";

import { memoryOwnerKey, type MemoryOwner } from "../../../domain/memory/index.js";
import type {
  HistoryQueryPort,
  HistoryReadInput,
  HistoryReadResult,
  HistorySearchInput,
  HistorySearchItem,
  HistorySearchResult,
  HistorySourceCoverage,
  OrdinaryEvidenceReader,
  EvidenceTurn,
} from "../contracts.js";
import { resolveAdmissionFromPolicy } from "../policy/policy-snapshot.js";
import type { MemoryDocumentRepository } from "../store/content-repository.js";
import type { MemoryControlRepository } from "../store/control-repository.js";
import { lexicalMatchExpression } from "../recall/lexical-projection.js";

/**
 * 历史查询端口实现（正式设计 §10）：search_history / read_history 的唯一查询逻辑。
 *
 * 纪律：
 * - scope 由宿主从真实调用会话注入（owner），不由模型选择；读取目标会话必须
 *   属于同一 owner scope（结构身份拒绝，E10）；
 * - FTS 投影命中一律回表复核 owner/validity，跨 Space 泄漏恒为 0；会话范围
 *   条件在 SQL LIMIT 之前过滤（R12）；
 * - 检索保持中立：返回匹配位置附近有语境的原文/摘要片段，不改写、不合成答案；
 * - all 搜索按「每来源保底 + 轮转合并」在统一预算下选取候选（R13），遵守调用方
 *   limit；摘要命中标注为模型生成摘要；
 * - token 预算使用真实 tokenizer（o200k_base）对最终序列化结果计数，包装、角色、
 *   时间、来源与续读字段全部计入（R14）；分页按完整轮次推进、永不返回空页、
 *   扫描跨度到界时探测续读（R11）。
 */

export const HISTORY_SEARCH_MAX_ITEMS = 8;
export const HISTORY_SEARCH_ITEM_MAX_TOKENS = 400;
export const HISTORY_SEARCH_TOTAL_MAX_TOKENS = 4_000;
export const HISTORY_READ_DEFAULT_TOKENS = 4_000;
export const HISTORY_READ_MAX_TOKENS = 6_000;
/** 原文分页一次最多请求的 ordinal 跨度（防止超长会话一次读爆）。 */
export const HISTORY_READ_MAX_ORDINAL_SPAN = 200;

export type HistoryConversationLookup = {
  /** 目标会话的 memory owner；undefined 表示会话不存在（结构身份拒绝）。 */
  readonly resolveConversationOwner: (conversationId: string) => Promise<MemoryOwner | undefined>;
  /** 会话标题（只用于展示）。 */
  readonly resolveConversationTitle?: (conversationId: string) => Promise<string | undefined>;
};

export type CreateMemoryHistoryQueryPortInput = {
  readonly controlRepository: MemoryControlRepository;
  readonly documentRepository: MemoryDocumentRepository;
  readonly evidenceReader: OrdinaryEvidenceReader;
  readonly conversationLookup: HistoryConversationLookup;
  /**
   * transcript 索引覆盖报告；缺省恒为 partial（v1 索引为启用边界后的增量覆盖，
   * 诚实报告不完整覆盖优于伪装完整）。
   */
  readonly transcriptCoverage?: () => HistorySourceCoverage;
  /** 缺省使用真实 o200k_base tokenizer（R14：字符换算不是保守上界）。 */
  readonly countTokens?: (text: string) => number;
};

let sharedEncoding: Tiktoken | undefined;

/** 真实 tokenizer（与维护管线同源）；预算边界不允许字符近似冒充硬上限。 */
export function historyCountTokens(text: string): number {
  sharedEncoding ??= getEncoding("o200k_base");
  return sharedEncoding.encode(text).length;
}

export function createMemoryHistoryQueryPort(
  input: CreateMemoryHistoryQueryPortInput,
): HistoryQueryPort {
  const countTokens = input.countTokens ?? historyCountTokens;
  const transcriptCoverage = input.transcriptCoverage ?? (() => "partial" as const);

  const readAdmission = async (owner: MemoryOwner) => {
    const ownerKey = memoryOwnerKey(owner);
    const [policyRows, ownerLifecycle] = await Promise.all([
      input.controlRepository.readAllPolicy(),
      input.controlRepository.getLifecycle(ownerKey),
    ]);
    return {
      ownerKey,
      admission: resolveAdmissionFromPolicy({
        owner,
        conversationId: "__history_query__",
        policyRows,
        ownerLifecycle,
        conversationLifecycle: undefined,
      }),
    };
  };

  return {
    async search(searchInput: HistorySearchInput): Promise<HistorySearchResult> {
      const { ownerKey, admission } = await readAdmission(searchInput.owner);
      const match = lexicalMatchExpression(searchInput.query);
      const summaryRequested = searchInput.sources === "summary" || searchInput.sources === "all";
      const transcriptRequested = searchInput.sources === "transcript" || searchInput.sources === "all";
      const summaryCoverage: HistorySourceCoverage = summaryRequested
        ? (admission.effective === "off" ? "disabled" : "available")
        : "disabled";
      const transcriptCov: HistorySourceCoverage = transcriptRequested ? transcriptCoverage() : "disabled";
      // R13：调用方 limit 是统一上限；每个来源各自取满 limit 个候选，再轮转合并。
      const perSourceLimit = Math.max(1, Math.min(Math.floor(searchInput.limit) || 1, HISTORY_SEARCH_MAX_ITEMS));

      type Candidate = { readonly build: () => Promise<HistorySearchItem> };
      const summaryCandidates: Candidate[] = [];
      const transcriptCandidates: Candidate[] = [];

      if (summaryRequested && admission.effective !== "off") {
        const summaryHits = await input.documentRepository.searchSummaries({
          ownerKey,
          match,
          ...(searchInput.conversationId === undefined ? {} : { conversationId: searchInput.conversationId }),
          limit: perSourceLimit,
        });
        for (const hit of summaryHits) {
          summaryCandidates.push({
            build: async () => {
              const excerpt = excerptAroundTerms(
                hit.summary.markdown,
                searchInput.query,
                HISTORY_SEARCH_ITEM_MAX_TOKENS,
                countTokens,
              );
              return {
                type: "conversation_summary",
                conversationId: hit.summary.conversationId,
                text: `[模型生成摘要]\n${excerpt.text}`,
                sourceRef: `summary:${hit.summary.revisionId}`,
                summaryRevision: hit.summary.revision,
                occurredAt: new Date(hit.summary.updatedAt).toISOString(),
                coveredThroughTime: new Date(hit.summary.updatedAt).toISOString(),
                truncated: excerpt.truncated,
              };
            },
          });
        }
      }

      if (transcriptRequested && transcriptCov !== "disabled") {
        const transcriptHits = await input.documentRepository.searchTranscript({
          ownerKey,
          match,
          ...(searchInput.conversationId === undefined ? {} : { conversationId: searchInput.conversationId }),
          limit: perSourceLimit,
        });
        for (const hit of transcriptHits) {
          transcriptCandidates.push({
            build: async () => {
              const window = await input.evidenceReader.readTurnWindow({
                conversationId: hit.conversationId,
                fromOrdinal: hit.ordinal,
                through: { turnId: "", ordinal: hit.ordinal, sourceRevision: 0 },
              });
              const turnText = window.turns
                .map((turn) => `[${turn.role}] ${turn.text}`)
                .join("\n");
              const excerpt = excerptAroundTerms(turnText, searchInput.query, HISTORY_SEARCH_ITEM_MAX_TOKENS, countTokens);
              return {
                type: "raw_excerpt",
                conversationId: hit.conversationId,
                text: excerpt.text,
                sourceRef: `conversation:${hit.conversationId}:ordinal:${hit.ordinal}`,
                truncated: excerpt.truncated,
              };
            },
          });
        }
      }

      // 轮转合并（保底配额，R13）：两个来源交替参与候选选择，在同一 per-item 与
      // 总预算下截断；任何来源都不允许占满整个配额。
      const queue: Candidate[] = [];
      const maxLen = Math.max(summaryCandidates.length, transcriptCandidates.length);
      for (let index = 0; index < maxLen; index += 1) {
        if (index < summaryCandidates.length) queue.push(summaryCandidates[index]);
        if (index < transcriptCandidates.length) queue.push(transcriptCandidates[index]);
      }

      const items: HistorySearchItem[] = [];
      let totalTokens = 0;
      for (const candidate of queue) {
        if (items.length >= perSourceLimit) break;
        const item = await candidate.build();
        const cost = countTokens(JSON.stringify(item));
        if (items.length === 0 && totalTokens + cost > HISTORY_SEARCH_TOTAL_MAX_TOKENS) {
          // 单条本身超总预算：硬截断其正文，永不超限且至少返回一条。
          const shrunk = excerptFromStart(item.text, HISTORY_SEARCH_TOTAL_MAX_TOKENS - 200, countTokens);
          items.push({ ...item, text: shrunk.text, truncated: true });
          break;
        }
        if (totalTokens + cost > HISTORY_SEARCH_TOTAL_MAX_TOKENS) break;
        items.push(item);
        totalTokens += cost;
      }

      // N03：搜索结果同样按完整序列化包装做最终校验，超出时逐条丢弃。
      const coverage = { summary: summaryCoverage, transcript: transcriptCov };
      let fitted = items;
      while (fitted.length > 1 &&
             countTokens(JSON.stringify({ outcome: "ok", coverage, items: fitted })) > HISTORY_SEARCH_TOTAL_MAX_TOKENS) {
        fitted = fitted.slice(0, -1);
      }
      if (fitted.length === 1 &&
          countTokens(JSON.stringify({ outcome: "ok", coverage, items: fitted })) > HISTORY_SEARCH_TOTAL_MAX_TOKENS) {
        const shrunk = excerptFromStart(fitted[0].text, HISTORY_SEARCH_TOTAL_MAX_TOKENS - 200, countTokens);
        fitted = [{ ...fitted[0], text: shrunk.text, truncated: true }];
      }
      const degraded = (summaryRequested && admission.effective === "off") || transcriptCov === "unavailable";
      const outcome = fitted.length > 0 ? "ok" : degraded ? "degraded" : "no_hit";
      return {
        outcome,
        coverage,
        items: fitted,
      };
    },

    async read(readInput: HistoryReadInput): Promise<HistoryReadResult> {
      // 目标会话必须属于调用方 scope（结构身份拒绝跨 Space 读取）。
      const targetOwner = await input.conversationLookup.resolveConversationOwner(readInput.conversationId);
      if (targetOwner === undefined) {
        return { outcome: "unavailable", reason: "conversation_not_found" };
      }
      if (memoryOwnerKey(targetOwner) !== memoryOwnerKey(readInput.owner)) {
        return { outcome: "unavailable", reason: "conversation_outside_scope" };
      }

      if (readInput.source === "summary") {
        const { admission } = await readAdmission(readInput.owner);
        if (admission.effective === "off") {
          return { outcome: "unavailable", reason: "summary_disabled" };
        }
        const summary = await input.documentRepository.getLatestValidSummary(readInput.conversationId);
        if (summary === undefined) {
          return { outcome: "unavailable", reason: "summary_not_found" };
        }
        const budget = Math.min(Math.max(readInput.limitTokens, 1), HISTORY_READ_MAX_TOKENS);
        const excerpt = excerptFromStart(summary.markdown, budget, countTokens);
        const coverage = await input.documentRepository.getTranscriptCoverage(readInput.conversationId);
        // N03：摘要头与覆盖字段计入最终预算，超出时收缩正文。
        const raw: HistoryReadResult = {
          outcome: "ok",
          text: `[模型生成摘要 · 覆盖至 ordinal ${summary.coveredThroughOrdinal}]\n${excerpt.text}`,
          truncated: excerpt.truncated,
          coveredThroughOrdinal: summary.coveredThroughOrdinal,
          hasUnsummarizedMessages: coverage !== undefined && coverage.indexedThroughOrdinal > summary.coveredThroughOrdinal,
        };
        return fitReadResultToBudget(raw, budget, countTokens);
      }

      // transcript：消息/片段级分页（N01）——页面按完整轮次填充；单轮超预算时
      // 取该轮 turn 流的字符前缀并把续读位置留在同一轮（配合 fragmentStart），
      // 剩余内容经续读可达，绝不永久跳过；扫描跨度用尽时探测下一轮，区分
      // 「token 截断」「跨度到界」与「真正读到末尾」。
      const fromOrdinal = Math.max(readInput.fromOrdinal ?? 1, 1);
      const spanEnd = fromOrdinal + HISTORY_READ_MAX_ORDINAL_SPAN - 1;
      const window = await input.evidenceReader.readTurnWindow({
        conversationId: readInput.conversationId,
        fromOrdinal,
        through: { turnId: "", ordinal: spanEnd, sourceRevision: 0 },
      });
      if (window.turns.length === 0) {
        return { outcome: "unavailable", reason: "transcript_not_available" };
      }
      const budget = Math.min(Math.max(readInput.limitTokens, 1), HISTORY_READ_MAX_TOKENS);
      const ordinalStreams = new Map<number, string>();
      {
        const groups = new Map<number, EvidenceTurn[]>();
        for (const turn of window.turns) {
          const group = groups.get(turn.ordinal) ?? [];
          group.push(turn);
          groups.set(turn.ordinal, group);
        }
        for (const [ordinal, group] of groups) {
          ordinalStreams.set(
            ordinal,
            group.map((turn) => `[${turn.role} · ${turn.occurredAt}]\n${turn.text}`).join("\n\n"),
          );
        }
      }
      const startFragmentOffset = Math.max(readInput.fragmentStart ?? 0, 0);
      let cursorOrdinal = fromOrdinal;
      let cursorOffset = fromOrdinal === (readInput.fromOrdinal ?? 1) ? startFragmentOffset : 0;
      const lines: string[] = [];
      let usedTokens = 0;
      let truncated = false;
      let lastOrdinal = fromOrdinal - 1;
      let includedOrdinals = 0;
      for (const [ordinal, stream] of ordinalStreams) {
        if (ordinal < cursorOrdinal) continue;
        const offset = ordinal === cursorOrdinal ? Math.min(cursorOffset, stream.length) : 0;
        if (offset >= stream.length) {
          // 该轮已在前页读完（防御分支）。
          lastOrdinal = ordinal;
          cursorOrdinal = ordinal + 1;
          cursorOffset = 0;
          continue;
        }
        const remaining = stream.slice(offset);
        const remainingTokens = countTokens(remaining);
        if (usedTokens + remainingTokens <= budget) {
          lines.push(remaining);
          usedTokens += remainingTokens;
          lastOrdinal = ordinal;
          includedOrdinals += 1;
          cursorOrdinal = ordinal + 1;
          cursorOffset = 0;
          continue;
        }
        const prefix = takePrefixByTokens(remaining, budget - usedTokens, countTokens);
        lines.push(prefix.text);
        usedTokens += prefix.tokens;
        lastOrdinal = ordinal;
        includedOrdinals += 1;
        truncated = true;
        cursorOffset = offset + prefix.consumedChars;
        break;
      }

      // 扫描跨度用尽且未触发 token 截断时，探测下一轮判断是否真的读到末尾。
      const reachedSpanEnd = ordinalStreams.size >= HISTORY_READ_MAX_ORDINAL_SPAN;
      if (!truncated && reachedSpanEnd) {
        const probe = await input.evidenceReader.readTurnWindow({
          conversationId: readInput.conversationId,
          fromOrdinal: spanEnd + 1,
          through: { turnId: "", ordinal: spanEnd + 1, sourceRevision: 0 },
        });
        if (probe.turns.length > 0) truncated = true;
      }

      // N03：最终返回按完整包装（JSON 转义、分页/覆盖字段）计入预算，超出时
      // 收缩正文并保留有效续读位置。
      const raw: HistoryReadResult = {
        outcome: "ok",
        text: lines.join("\n\n"),
        truncated,
        ...(truncated
          ? { nextFromOrdinal: cursorOffset > 0 ? cursorOrdinal : lastOrdinal + 1 }
          : {}),
        ...(truncated && cursorOffset > 0 ? { nextFragmentStart: cursorOffset } : {}),
      };
      return fitReadResultToBudget(raw, budget, countTokens);
    },
  };
}

/**
 * N03：把完整返回（含 JSON 转义与包装字段）收缩进预算——wrapper 以「正文置空的
 * 完整序列化」精确计量，正文二分收缩；续读位置保持有效（页面仍前进）。
 */
function fitReadResultToBudget(
  result: HistoryReadResult,
  budget: number,
  countTokens: (text: string) => number,
): HistoryReadResult {
  if (result.outcome !== "ok") return result;
  const wrapperCost = countTokens(JSON.stringify({ ...result, text: "" }));
  const textBudget = budget - wrapperCost;
  if (textBudget <= 0 || countTokens(result.text) <= textBudget) return result;
  const shrunk = excerptFromStart(result.text, textBudget, countTokens);
  return { ...result, text: shrunk.text, truncated: true };
}

/** 在 token 预算内取文本前缀（字符二分）；至少消费 1 个字符。 */
function takePrefixByTokens(
  text: string,
  maxTokens: number,
  countTokens: (text: string) => number,
): { readonly text: string; readonly tokens: number; readonly consumedChars: number } {
  if (maxTokens <= 0) {
    const one = text.slice(0, 1);
    return { text: one, tokens: countTokens(one), consumedChars: 1 };
  }
  if (countTokens(text) <= maxTokens) {
    return { text, tokens: countTokens(text), consumedChars: text.length };
  }
  let low = 1;
  let high = text.length;
  let best = 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (countTokens(text.slice(0, mid)) <= maxTokens) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const out = text.slice(0, Math.max(best, 1));
  return { text: out, tokens: countTokens(out), consumedChars: out.length };
}

/** 摘要命中片段：优先对齐第一个查询词命中位置，保证片段有语境。 */
function excerptAroundTerms(
  text: string,
  query: string,
  maxTokens: number,
  countTokens: (text: string) => number,
): { readonly text: string; readonly truncated: boolean } {
  const terms = lexicalTermsOf(query);
  let matchIndex = -1;
  const lowered = text.toLowerCase();
  for (const term of terms) {
    const index = lowered.indexOf(term.toLowerCase());
    if (index !== -1 && (matchIndex === -1 || index < matchIndex)) matchIndex = index;
  }
  if (matchIndex === -1) {
    return excerptFromStart(text, maxTokens, countTokens);
  }
  const start = Math.max(0, matchIndex - 120);
  return excerptBounded(text, start, maxTokens, countTokens);
}

function excerptFromStart(
  text: string,
  maxTokens: number,
  countTokens: (text: string) => number,
): { readonly text: string; readonly truncated: boolean } {
  return excerptBounded(text, 0, maxTokens, countTokens);
}

function excerptBounded(
  text: string,
  start: number,
  maxTokens: number,
  countTokens: (text: string) => number,
): { readonly text: string; readonly truncated: boolean } {
  if (countTokens(text) <= maxTokens) {
    return { text, truncated: false };
  }
  // 二分收缩到预算内（真实 tokenizer 计数，不用字符近似）。
  let low = 1;
  let high = text.length - start;
  let best = start + 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (countTokens(text.slice(start, start + mid)) <= maxTokens) {
      best = start + mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return { text: text.slice(start, best), truncated: true };
}

function lexicalTermsOf(query: string): readonly string[] {
  return query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length > 0)
    .slice(0, 12);
}
