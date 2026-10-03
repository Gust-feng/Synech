import { createHmac, randomBytes } from "node:crypto";
import { countMemoryTokens } from "../token-counting.js";
import { createMemoryEntryQueries } from "./entry-query.js";

import { memoryOwnerKey } from "../../../domain/memory/index.js";
import type { ConversationOwner } from "../../../domain/execution-scope/contracts.js";
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
 * - FTS 投影命中一律回表复核 owner/validity，跨 owner 泄漏恒为 0；会话范围
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
  /** 目标会话的 memory owner（Space 或 Workspace）；undefined 表示会话不存在（结构身份拒绝）。 */
  readonly resolveConversationOwner: (conversationId: string) => Promise<ConversationOwner | undefined>;
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

/** Shared tokenizer; kept as the history counting entry used by budget checks. */
export const historyCountTokens = countMemoryTokens;

export function createMemoryHistoryQueryPort(
  input: CreateMemoryHistoryQueryPortInput,
): HistoryQueryPort {
  const countTokens = input.countTokens ?? historyCountTokens;
  const transcriptCoverage = input.transcriptCoverage ?? (() => "partial" as const);
  const cursorKey = randomBytes(32);
  const signCursor = (body: string) => createHmac("sha256", cursorKey).update(body).digest("base64url");
  const summaryCursor = (scope: string, revisionId: string, offset: number): string => {
    const body = Buffer.from(JSON.stringify({ scope, revisionId, offset })).toString("base64url");
    return `${body}.${signCursor(body)}`;
  };

  const readAdmission = async (
    owner: ConversationOwner,
    conversationIds: readonly string[] = [],
  ) => {
    const ownerKey = memoryOwnerKey(owner);
    const uniqueConversationIds = [...new Set(conversationIds)];
    const [policyRows, ownerLifecycle, conversationLifecycles] = await Promise.all([
      input.controlRepository.readAllPolicy(),
      input.controlRepository.getLifecycle(ownerKey),
      Promise.all(uniqueConversationIds.map((id) =>
        input.controlRepository.getLifecycle(`conversation:${id}`),
      )),
    ]);
    const conversationLifecycle = conversationLifecycles.length === 1
      ? conversationLifecycles[0]
      : undefined;
    const admission = resolveAdmissionFromPolicy({
      owner,
      conversationId: uniqueConversationIds.length === 1 ? uniqueConversationIds[0]! : "__history_query__",
      policyRows,
      ownerLifecycle,
      conversationLifecycle,
    });
    return {
      ownerKey,
      policyRevision: admission.policyRevision,
      admission,
      conversationGenerations: new Map(uniqueConversationIds.map((id, index) => [
        id,
        conversationLifecycles[index]?.generation ?? 0,
      ])),
      hasFencedConversation: conversationLifecycles.some((lifecycle) =>
        lifecycle !== undefined && (lifecycle.fenceState === "fenced" || lifecycle.fenceState === "tombstone"),
      ),
    };
  };

  /**
   * Async FTS/evidence reads can overlap a policy change or lifecycle fence. Re-read
   * authoritative facts immediately before returning any content and reject the whole
   * result if the admission snapshot changed or any target conversation is fenced.
   */
  const canReturnHistory = async (
    owner: ConversationOwner,
    expected: Awaited<ReturnType<typeof readAdmission>>,
    conversationIds: readonly string[],
    compareConversationGenerations = false,
  ): Promise<"available" | "policy_changed" | "conversation_changed" | "conversation_fenced"> => {
    const current = await readAdmission(owner, conversationIds);
    if (current.hasFencedConversation) return "conversation_fenced";
    if (current.admission.effective !== "active" ||
        current.admission.generation !== expected.admission.generation ||
        current.policyRevision !== expected.policyRevision) return "policy_changed";
    if (compareConversationGenerations && conversationIds.some((id) =>
      (current.conversationGenerations.get(id) ?? 0) !== (expected.conversationGenerations.get(id) ?? 0),
    )) return "conversation_changed";
    return "available";
  };

  const unavailableSearch = (
    summaryRequested: boolean,
    transcriptRequested: boolean,
  ): HistorySearchResult => ({
    outcome: summaryRequested || transcriptRequested ? "degraded" : "no_hit",
    coverage: { summary: "disabled", transcript: "disabled" },
    items: [],
  });

  const entries = createMemoryEntryQueries(input.documentRepository, readAdmission, countTokens);
  return {
    ...entries,
    async search(searchInput: HistorySearchInput): Promise<HistorySearchResult> {
      const initialAdmission = await readAdmission(
        searchInput.owner,
        searchInput.conversationId === undefined ? [] : [searchInput.conversationId],
      );
      const { ownerKey, admission } = initialAdmission;
      const match = lexicalMatchExpression(searchInput.query);
      const summaryRequested = searchInput.sources === "summary" || searchInput.sources === "all";
      const transcriptRequested = searchInput.sources === "transcript" || searchInput.sources === "all";
      // 用户开关（enabled / rollout / fence）关闭时，记忆供给整体停止：摘要与
      // transcript 两个来源都 disabled，工具不得绕过开关继续读历史。
      const memoryOff = admission.effective !== "active";
      const summaryCoverage: HistorySourceCoverage = summaryRequested
        ? (memoryOff ? "disabled" : "available")
        : "disabled";
      const transcriptCov: HistorySourceCoverage = transcriptRequested
        ? (memoryOff ? "disabled" : transcriptCoverage())
        : "disabled";
      // R13：调用方 limit 是统一上限；每个来源各自取满 limit 个候选，再轮转合并。
      const perSourceLimit = Math.max(1, Math.min(Math.floor(searchInput.limit) || 1, HISTORY_SEARCH_MAX_ITEMS));

      type Candidate = { readonly conversationId: string; readonly build: () => Promise<HistorySearchItem> };
      const summaryCandidates: Candidate[] = [];
      const transcriptCandidates: Candidate[] = [];

      if (summaryRequested && admission.effective === "active") {
        const summaryHits = await input.documentRepository.searchSummaries({
          ownerKey,
          match,
          ...(searchInput.conversationId === undefined ? {} : { conversationId: searchInput.conversationId }),
          limit: perSourceLimit,
        });
        for (const hit of summaryHits) {
          summaryCandidates.push({
            conversationId: hit.summary.conversationId,
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
            conversationId: hit.conversationId,
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

      const discoveredConversationIds = [...new Set([
        ...summaryCandidates.map(candidate => candidate.conversationId),
        ...transcriptCandidates.map(candidate => candidate.conversationId),
      ])];
      const evidenceAdmission = await readAdmission(searchInput.owner, discoveredConversationIds);
      if (evidenceAdmission.hasFencedConversation || evidenceAdmission.admission.effective !== "active" ||
          evidenceAdmission.admission.generation !== initialAdmission.admission.generation ||
          evidenceAdmission.policyRevision !== initialAdmission.policyRevision) return unavailableSearch(summaryRequested, transcriptRequested);
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
             countTokens(JSON.stringify({ status: "ok", outcome: "ok", coverage, items: fitted })) > HISTORY_SEARCH_TOTAL_MAX_TOKENS) {
        fitted = fitted.slice(0, -1);
      }
      if (fitted.length === 1 &&
          countTokens(JSON.stringify({ status: "ok", outcome: "ok", coverage, items: fitted })) > HISTORY_SEARCH_TOTAL_MAX_TOKENS) {
        const shrunk = excerptFromStart(fitted[0].text, HISTORY_SEARCH_TOTAL_MAX_TOKENS - 200, countTokens);
        fitted = [{ ...fitted[0], text: shrunk.text, truncated: true }];
      }
      const degraded = (memoryOff && (summaryRequested || transcriptRequested)) || transcriptCov === "unavailable";
      const outcome = fitted.length > 0 ? "ok" : degraded ? "degraded" : "no_hit";
      const targetConversationIds = [
        ...(searchInput.conversationId === undefined ? [] : [searchInput.conversationId]),
        ...fitted.map((item) => item.conversationId),
      ];
      const candidateSummaryRevisions = fitted
        .filter((item) => item.type === "conversation_summary")
        .map((item) => item.sourceRef.slice("summary:".length));
      const stillValidSummaries = await Promise.all(candidateSummaryRevisions.map(async (revisionId) => {
        const revision = await input.documentRepository.getSummaryRevision(revisionId);
        return revision?.validity === "valid" && revision.ownerKey === ownerKey;
      }));
      if (stillValidSummaries.some((valid) => !valid) ||
          await canReturnHistory(searchInput.owner, evidenceAdmission, targetConversationIds, true) !== "available") {
        return unavailableSearch(summaryRequested, transcriptRequested);
      }
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

      // 每次读取都在当前边界重算准入（owner/generation/rollout 变化立即生效）；
      // 关闭时摘要与原文都不可读——history 工具不能绕开用户开关。
      const initialAdmission = await readAdmission(readInput.owner, [readInput.conversationId]);
      const { admission } = initialAdmission;
      if (admission.effective !== "active") {
        return readInput.source === "summary"
          ? { outcome: "unavailable", reason: "summary_disabled" }
          : { outcome: "unavailable", reason: "transcript_disabled" };
      }

      if (readInput.source === "summary") {
        const scope = JSON.stringify([initialAdmission.ownerKey, readInput.conversationId,
          initialAdmission.policyRevision, admission.generation, initialAdmission.conversationGenerations.get(readInput.conversationId)]);
        let offset = 0;
        let revisionId: string | undefined;
        if (readInput.cursor !== undefined) {
          try {
            const [body, mac, extra] = readInput.cursor.split(".");
            if (!body || mac !== signCursor(body) || extra !== undefined || readInput.cursor.length > 8_192) throw new Error("invalid_cursor");
            const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { scope: string; revisionId: string; offset: number };
            if (parsed.scope !== scope || typeof parsed.revisionId !== "string" || !Number.isInteger(parsed.offset) || parsed.offset < 0) throw new Error("stale_cursor");
            offset = parsed.offset; revisionId = parsed.revisionId;
          } catch { return { outcome: "unavailable", reason: "history_cursor_stale" }; }
        }
        const summary = revisionId === undefined
          ? await input.documentRepository.getLatestValidSummary(readInput.conversationId)
          : await input.documentRepository.getSummaryRevision(revisionId);
        if (summary === undefined || summary.ownerKey !== initialAdmission.ownerKey ||
            summary.conversationId !== readInput.conversationId || summary.validity !== "valid") {
          return { outcome: "unavailable", reason: "summary_not_found" };
        }
        const budget = Math.min(Math.max(readInput.limitTokens, 1), HISTORY_READ_MAX_TOKENS);
        const coverage = await input.documentRepository.getTranscriptCoverage(readInput.conversationId);
        const stream = `[模型生成摘要 · 覆盖至 ordinal ${summary.coveredThroughOrdinal}]\n${summary.markdown}`;
        const remaining = stream.slice(offset);
        const pageWith = (text: string): HistoryReadResult => ({ outcome: "ok",
          text, truncated: offset + text.length < stream.length,
          coveredThroughOrdinal: summary.coveredThroughOrdinal,
          hasUnsummarizedMessages: coverage !== undefined && coverage.indexedThroughOrdinal > summary.coveredThroughOrdinal,
          ...(offset + text.length < stream.length ? { nextCursor: summaryCursor(scope, summary.revisionId, offset + text.length) } : {}),
        });
        const pageCost = (text: string) => countTokens(JSON.stringify({ status: "ok", ...pageWith(text) }));
        const prefix = takePrefixByTokens(remaining, budget, pageCost);
        if (pageCost(prefix.text) > budget) return { outcome: "unavailable", reason: "history_response_budget_too_small" };
        const fitted = pageWith(prefix.text);
        const currentSummary = await input.documentRepository.getSummaryRevision(summary.revisionId);
        if (currentSummary?.validity !== "valid" || currentSummary.ownerKey !== memoryOwnerKey(readInput.owner)) {
          return { outcome: "unavailable", reason: "summary_not_found" };
        }
        const finalCheck = await canReturnHistory(readInput.owner, initialAdmission, [readInput.conversationId], true);
        if (finalCheck !== "available") {
          return {
            outcome: "unavailable",
            reason: finalCheck === "conversation_fenced" ? "conversation_not_found"
              : finalCheck === "conversation_changed" ? "conversation_changed"
              : "summary_disabled",
          };
        }
        return fitted;
      }

      // transcript：消息/片段级分页（N01）——页面按完整轮次填充；单轮超预算时
      // 取该轮 turn 流的字符前缀并把续读位置留在同一轮（配合 fragmentStart），
      // 剩余内容经续读可达，绝不永久跳过；扫描跨度用尽时探测下一轮，区分
      // 「token 截断」「跨度到界」与「真正读到末尾」。
      const requestedOrdinal = Math.max(readInput.fromOrdinal ?? 1, 1);
      const authorizedOrdinals = await input.documentRepository.listTranscriptOrdinals({
        ownerKey: memoryOwnerKey(readInput.owner), conversationId: readInput.conversationId,
        fromOrdinal: requestedOrdinal, limit: HISTORY_READ_MAX_ORDINAL_SPAN + 1,
      });
      if (authorizedOrdinals.length === 0) return { outcome: "unavailable", reason: "transcript_not_available" };
      const authorized = new Set(authorizedOrdinals);
      const fromOrdinal = authorizedOrdinals[0];
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
          if (!authorized.has(turn.ordinal)) continue;
          const group = groups.get(turn.ordinal) ?? [];
          group.push(turn);
          groups.set(turn.ordinal, group);
        }
        for (const [ordinal, group] of groups) {
          ordinalStreams.set(
            ordinal,
            group.map((turn) => `[${turn.role} · ${turn.occurredAt}]\n${turn.text}`).join("\n\n") +
              (authorizedOrdinals.some(candidate => candidate > ordinal) ? "\n\n" : ""),
          );
        }
      }
      const startFragmentOffset = Math.max(readInput.fragmentStart ?? 0, 0);
      let fitted: HistoryReadResult = { outcome: "unavailable", reason: "transcript_not_available" };
      const lines: string[] = [];
      for (const [ordinal, stream] of ordinalStreams) {
        const offset = ordinal === fromOrdinal && fromOrdinal === requestedOrdinal
          ? Math.min(startFragmentOffset, stream.length)
          : 0;
        if (offset >= stream.length) continue;
        const remaining = stream.slice(offset);
        const pageWith = (text: string): HistoryReadResult => {
          const end = offset + text.length;
          const nextOrdinal = end < stream.length
            ? ordinal
            : authorizedOrdinals.find(candidate => candidate > ordinal);
          return {
            outcome: "ok",
            text: [...lines, text].join(""),
            truncated: nextOrdinal !== undefined,
            ...(nextOrdinal === undefined ? {} : { nextFromOrdinal: nextOrdinal }),
            ...(end < stream.length ? { nextFragmentStart: end } : {}),
          };
        };
        // 正文、JSON 转义和真实续读位置必须一起计入预算，发布后不能再单独裁正文。
        const pageCost = (text: string): number => countTokens(JSON.stringify({ status: "ok", ...pageWith(text) }));
        if (pageCost(remaining) <= budget) {
          fitted = pageWith(remaining);
          lines.push(remaining);
          continue;
        }
        if (lines.length > 0) break;
        const prefix = takePrefixByTokens(remaining, budget, pageCost);
        if (pageCost(prefix.text) > budget) return { outcome: "unavailable", reason: "history_response_budget_too_small" };
        fitted = pageWith(prefix.text);
        break;
      }
      const finalCheck = await canReturnHistory(readInput.owner, initialAdmission, [readInput.conversationId], true);
      if (finalCheck !== "available") {
        return {
          outcome: "unavailable",
          reason: finalCheck === "conversation_fenced" ? "conversation_not_found"
            : finalCheck === "conversation_changed" ? "conversation_changed"
            : "transcript_disabled",
        };
      }
      return fitted;
    },
  };
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
  if (best < text.length && /[\uD800-\uDBFF]/u.test(text[best - 1]!)) best -= 1;
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
