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
 * - FTS 投影命中一律回表复核 owner/validity，跨 Space 泄漏恒为 0；
 * - 检索保持中立：返回匹配位置附近有语境的原文/摘要片段，不改写、不合成答案；
 * - 摘要命中标注为模型生成摘要；结果预算 ≤8 片、单片 ≤400 tokens、总计 ≤4,000；
 * - coverage 如实报告：memory 关闭时摘要来源 disabled（原文工具仍可用），索引
 *   覆盖不完整时 partial；所有请求来源都不可用时 outcome=degraded，不伪装 no_hit。
 */

/** 搜索片段与读取结果的 token 预算（正式设计 §10.3/§13，实验参数）。 */
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
  readonly countTokens?: (text: string) => number;
};

export function createMemoryHistoryQueryPort(
  input: CreateMemoryHistoryQueryPortInput,
): HistoryQueryPort {
  const countTokens = input.countTokens ?? defaultHistoryCountTokens;
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

      const items: HistorySearchItem[] = [];
      let totalTokens = 0;
      let degraded = false;

      if (summaryRequested && admission.effective !== "off") {
        const hits = await input.documentRepository.searchSummaries({
          ownerKey,
          match,
          limit: HISTORY_SEARCH_MAX_ITEMS,
        });
        for (const hit of hits) {
          if (searchInput.conversationId !== undefined && hit.summary.conversationId !== searchInput.conversationId) continue;
          const excerpt = excerptAroundTerms(
            hit.summary.markdown,
            searchInput.query,
            HISTORY_SEARCH_ITEM_MAX_TOKENS,
            countTokens,
          );
          totalTokens += excerpt.tokens;
          if (totalTokens > HISTORY_SEARCH_TOTAL_MAX_TOKENS) break;
          items.push({
            type: "conversation_summary",
            conversationId: hit.summary.conversationId,
            text: `[模型生成摘要]\n${excerpt.text}`,
            sourceRef: `summary:${hit.summary.revisionId}`,
            summaryRevision: hit.summary.revision,
            occurredAt: new Date(hit.summary.updatedAt).toISOString(),
            coveredThroughTime: new Date(hit.summary.updatedAt).toISOString(),
            truncated: excerpt.truncated,
          });
          if (items.length >= HISTORY_SEARCH_MAX_ITEMS) break;
        }
      } else if (summaryRequested && admission.effective === "off") {
        degraded = true;
      }

      if (transcriptRequested && transcriptCov !== "disabled") {
        const hits = await input.documentRepository.searchTranscript({
          ownerKey,
          match,
          limit: HISTORY_SEARCH_MAX_ITEMS,
        });
        for (const hit of hits) {
          if (searchInput.conversationId !== undefined && hit.conversationId !== searchInput.conversationId) continue;
          if (items.length >= HISTORY_SEARCH_MAX_ITEMS) break;
          const window = await input.evidenceReader.readTurnWindow({
            conversationId: hit.conversationId,
            fromOrdinal: hit.ordinal,
            through: { turnId: "", ordinal: hit.ordinal, sourceRevision: 0 },
          });
          const turnText = window.turns
            .map((turn) => `[${turn.role}] ${turn.text}`)
            .join("\n");
          if (turnText.length === 0) continue;
          const excerpt = excerptAroundTerms(turnText, searchInput.query, HISTORY_SEARCH_ITEM_MAX_TOKENS, countTokens);
          totalTokens += excerpt.tokens;
          if (totalTokens > HISTORY_SEARCH_TOTAL_MAX_TOKENS) break;
          items.push({
            type: "raw_excerpt",
            conversationId: hit.conversationId,
            text: excerpt.text,
            sourceRef: `conversation:${hit.conversationId}:ordinal:${hit.ordinal}`,
            truncated: excerpt.truncated,
          });
        }
      }

      const outcome = items.length > 0
        ? "ok"
        : (degraded || (summaryRequested && admission.effective === "off"))
          ? "degraded"
          : "no_hit";
      return {
        outcome,
        coverage: { summary: summaryCoverage, transcript: transcriptCov },
        items,
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
        const excerpt = excerptAroundTokensFromStart(summary.markdown, budget, countTokens);
        const coverage = await input.documentRepository.getTranscriptCoverage(readInput.conversationId);
        return {
          outcome: "ok",
          text: `[模型生成摘要 · 覆盖至 ordinal ${summary.coveredThroughOrdinal}]\n${excerpt.text}`,
          truncated: excerpt.truncated,
          coveredThroughOrdinal: summary.coveredThroughOrdinal,
          hasUnsummarizedMessages: coverage !== undefined && coverage.indexedThroughOrdinal > summary.coveredThroughOrdinal,
        };
      }

      // transcript：按序读取连续稳定原文，token 预算内截断并给续读位置。
      const fromOrdinal = Math.max(readInput.fromOrdinal ?? 1, 1);
      const throughOrdinal = fromOrdinal + HISTORY_READ_MAX_ORDINAL_SPAN - 1;
      const window = await input.evidenceReader.readTurnWindow({
        conversationId: readInput.conversationId,
        fromOrdinal,
        through: { turnId: "", ordinal: throughOrdinal, sourceRevision: 0 },
      });
      if (window.turns.length === 0) {
        return { outcome: "unavailable", reason: "transcript_not_available" };
      }
      const budget = Math.min(Math.max(readInput.limitTokens, 1), HISTORY_READ_MAX_TOKENS);
      const lines: string[] = [];
      let usedTokens = 0;
      let truncated = false;
      let lastOrdinal = fromOrdinal - 1;
      for (const turn of window.turns) {
        const line = `[${turn.role} · ${turn.occurredAt}]\n${turn.text}`;
        const cost = countTokens(line);
        if (usedTokens + cost > budget) {
          truncated = true;
          break;
        }
        lines.push(line);
        usedTokens += cost;
        lastOrdinal = Math.max(lastOrdinal, turn.ordinal);
      }
      const result: HistoryReadResult = {
        outcome: "ok",
        text: lines.join("\n\n"),
        truncated,
        nextFromOrdinal: truncated ? lastOrdinal + 1 : undefined,
      };
      return result;
    },
  };
}

/** 摘要命中片段：优先对齐第一个查询词命中位置，保证片段有语境。 */
function excerptAroundTerms(
  text: string,
  query: string,
  maxTokens: number,
  countTokens: (text: string) => number,
): { readonly text: string; readonly tokens: number; readonly truncated: boolean } {
  const terms = lexicalTermsOf(query);
  let matchIndex = -1;
  const lowered = text.toLowerCase();
  for (const term of terms) {
    const index = lowered.indexOf(term.toLowerCase());
    if (index !== -1 && (matchIndex === -1 || index < matchIndex)) matchIndex = index;
  }
  if (matchIndex === -1) {
    return excerptAroundTokensFromStart(text, maxTokens, countTokens);
  }
  const start = Math.max(0, matchIndex - 120);
  return excerptBounded(text, start, maxTokens, countTokens);
}

function excerptAroundTokensFromStart(
  text: string,
  maxTokens: number,
  countTokens: (text: string) => number,
): { readonly text: string; readonly tokens: number; readonly truncated: boolean } {
  return excerptBounded(text, 0, maxTokens, countTokens);
}

function excerptBounded(
  text: string,
  start: number,
  maxTokens: number,
  countTokens: (text: string) => number,
): { readonly text: string; readonly tokens: number; readonly truncated: boolean } {
  if (countTokens(text) <= maxTokens) {
    return { text, tokens: countTokens(text), truncated: false };
  }
  // 粗略字符预算（CJK 约 1 字/token，拉丁约 4 字符/token），再精确校验。
  const charBudget = maxTokens * 3;
  let candidate = text.slice(start, start + charBudget);
  while (candidate.length > 0 && countTokens(candidate) > maxTokens) {
    candidate = candidate.slice(0, Math.floor(candidate.length * 0.9));
  }
  return { text: candidate, tokens: countTokens(candidate), truncated: true };
}

function lexicalTermsOf(query: string): readonly string[] {
  return query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length > 0)
    .slice(0, 12);
}

function defaultHistoryCountTokens(text: string): number {
  // 检索预算的保守估算（历史端口无 tokenizer 依赖）；精确计数由维护管线负责。
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (/[\u3400-\u4dbf\u4e00-\u9fff]/u.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}
