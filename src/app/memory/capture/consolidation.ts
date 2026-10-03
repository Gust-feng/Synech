import { createId } from "../../../kernel/id.js";
import type { EvidenceTurn, MemoryMaintenanceModelPort, OrdinaryEvidenceReader, OwnerMemoryBackground } from "../contracts.js";
import type { MemoryConsolidationReadPort, MemoryConsolidationReadResult, MemoryEntryRevisionView, MemorySource, MemorySourceView } from "../entry-contracts.js";
import * as limits from "../policy/maintenance-limits.js";
import { lexicalMatchExpression } from "../recall/lexical-projection.js";
import {
  MAINTENANCE_ADJACENT_TOKEN_BUDGET,
  MAINTENANCE_FULL_CONVERSATION_TOKEN_BUDGET,
  MAINTENANCE_MAX_ATTEMPTS,
  MAINTENANCE_MAX_REQUEST_INPUT_TOKENS,
  MAINTENANCE_MEMORY_MAX_TOKENS,
  MAINTENANCE_MEMORY_TARGET_TOKENS,
  MAINTENANCE_MIN_EVIDENCE_CAPACITY_TOKENS,
  MAINTENANCE_OUTPUT_RESERVE_TOKENS,
  MAINTENANCE_RETRY_DELAYS_MS,
  MAINTENANCE_SUMMARY_MAX_TOKENS,
  MAINTENANCE_SUMMARY_TARGET_TOKENS,
} from "../policy/maintenance-limits.js";
import { countMemoryTokens } from "../token-counting.js";
import {
  buildMaintenanceMessages,
  MAINTENANCE_SYSTEM_PROMPT,
  type MaintenanceEvidenceItem,
  type MaintenanceInputPayload,
  type MaintenanceRequestMetadata,
} from "./maintenance-prompt.js";
import {
  maintenanceOutputSchema,
  parseModelJson,
  redactSensitiveContent,
  validateMaintenanceOutput,
} from "./maintenance-output.js";
import { resolveAdmissionFromPolicy } from "../policy/policy-snapshot.js";
import {
  type CommitMemoryEntriesBatchInput,
  type MemoryDocumentRepository,
} from "../store/content-repository.js";
import { memoryOwnerFromKey } from "../store/owner-keys.js";
import type { MemoryControlRepository } from "../store/control-repository.js";

/** Durable claim -> owner-bound evidence -> finite no-tools continuation -> atomic publication.
 * Summary, entries, immutable overview dependencies and progress share the repository transaction.
 * Every observed entry/source remains in the commit read set, even if omitted by the proposal.
 */

// ---------------------------------------------------------------------------
// 证据批次消费与相邻原文读取
// ---------------------------------------------------------------------------

/**
 * 按「完整轮次优先 + 片段收尾」消费证据组（R01 + N04）。
 *
 * - 批次边界优先落在完整 ordinal 上（同轮 user/assistant 共享 ordinal，只装下
 *   user 就推进游标会让 assistant 永久漏记）；
 * - 单轮超过剩余容量时按「消息/片段」消费：以该轮 turn 流的字符偏移为片段
 *   游标（流 = 各 turn 的 `${role}\n${text}` 依次拼接），本批只取容量内的前缀，
 *   progress 记录片段终点；下一 claim 从该偏移继续，读完才推进 ordinal；
 * - 每次消费至少推进一个字符（不存在空页/空批循环）。
 */
export type EvidenceConsumption = {
  readonly batch: readonly EvidenceTurn[];
  /** 最后一个完整消费的 ordinal；片段进行中时其之前的位置。 */
  readonly completeThroughOrdinal: number;
  readonly fragment: { readonly ordinal: number; readonly end: number } | null;
};

export function consumeEvidenceGroups(
  turns: readonly EvidenceTurn[],
  input: {
    readonly startOrdinal: number;
    readonly startFragmentOffset: number;
    readonly capacity: number;
    readonly countTokens: (text: string) => number;
  },
): EvidenceConsumption {
  const ordinalGroups = new Map<number, EvidenceTurn[]>();
  for (const turn of turns) {
    const group = ordinalGroups.get(turn.ordinal) ?? [];
    group.push(turn);
    ordinalGroups.set(turn.ordinal, group);
  }
  const batch: EvidenceTurn[] = [];
  let used = 0;
  let completeThroughOrdinal = input.startOrdinal - 1;
  let fragment: { readonly ordinal: number; readonly end: number } | null = null;
  let cursorOrdinal = input.startOrdinal;
  let cursorOffset = input.startFragmentOffset;
  for (const [ordinal, group] of ordinalGroups) {
    if (ordinal < cursorOrdinal) continue;
    const stream = group.map((turn) => ({ turn, text: `${turn.role}\n${turn.text}`, offset: 0 }));
    const totalChars = stream.reduce((sum, segment) => sum + segment.text.length, 0);
    const offset = ordinal === cursorOrdinal ? Math.min(cursorOffset, totalChars) : 0;
    if (offset >= totalChars) {
      // 该轮已在此前的片段中读完（防御分支）：完整推进。
      completeThroughOrdinal = ordinal;
      cursorOrdinal = ordinal + 1;
      cursorOffset = 0;
      continue;
    }
    const remainingSegments = suffixSegments(stream, offset);
    const remainingTokens = remainingSegments.reduce(
      (sum, segment) => sum + input.countTokens(segment.text),
      0,
    );
    if (used + remainingTokens <= input.capacity) {
      batch.push(...remainingSegments.map((segment) => withSlicedText(segment)));
      used += remainingTokens;
      completeThroughOrdinal = ordinal;
      cursorOrdinal = ordinal + 1;
      cursorOffset = 0;
      continue;
    }
    // 部分消费：在剩余流内按 token 预算取前缀（字符二分），片段终点 = 字符偏移。
    const prefix = takeStreamPrefixByTokens(remainingSegments, input.capacity - used, input.countTokens);
    if (prefix.consumedChars <= 0) break;
    batch.push(...prefix.segments.map((segment) => withSlicedText(segment)));
    used += prefix.usedTokens;
    const newOffset = offset + prefix.consumedChars;
    if (newOffset >= totalChars) {
      completeThroughOrdinal = ordinal;
      cursorOrdinal = ordinal + 1;
      cursorOffset = 0;
    } else {
      fragment = { ordinal, end: newOffset };
    }
    break;
  }
  return { batch, completeThroughOrdinal, fragment };
}

type StreamSegment = { readonly turn: EvidenceTurn; readonly text: string; readonly offset: number };

function suffixSegments(stream: readonly StreamSegment[], offset: number): readonly StreamSegment[] {
  const segments: StreamSegment[] = [];
  let consumed = 0;
  for (const segment of stream) {
    if (consumed + segment.text.length <= offset) {
      consumed += segment.text.length;
      continue;
    }
    const localStart = Math.max(0, offset - consumed);
    segments.push({ turn: segment.turn, text: segment.text.slice(localStart), offset: segment.offset + localStart });
    consumed += segment.text.length;
  }
  return segments;
}

function takeStreamPrefixByTokens(
  segments: readonly StreamSegment[],
  maxTokens: number,
  countTokens: (text: string) => number,
): { readonly segments: readonly StreamSegment[]; readonly usedTokens: number; readonly consumedChars: number } {
  const out: StreamSegment[] = [];
  let usedTokens = 0;
  let consumedChars = 0;
  for (const segment of segments) {
    const remainingTokens = maxTokens - usedTokens;
    if (remainingTokens <= 0) break;
    const wholeCost = countTokens(segment.text);
    if (wholeCost <= remainingTokens) {
      out.push(segment);
      usedTokens += wholeCost;
      consumedChars += segment.text.length;
      continue;
    }
    // 二分取该段的前缀，使 token 计数落入剩余预算（同轮内的字符级片段）。
    let low = 1;
    let high = segment.text.length;
    let best = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (countTokens(segment.text.slice(0, mid)) <= remainingTokens) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (best <= 0) break;
    out.push({ ...segment, text: segment.text.slice(0, best) });
    usedTokens += countTokens(segment.text.slice(0, best));
    consumedChars += best;
    break;
  }
  return { segments: out, usedTokens, consumedChars };
}

function withSlicedText(segment: StreamSegment): EvidenceTurn {
  const headerLength = segment.turn.role.length + 1;
  const bodyStart = Math.max(0, headerLength - segment.offset);
  return { ...segment.turn, text: segment.text.slice(bodyStart) };
}

/**
 * 有限相邻原文（incremental 模式，R02）：只读取「合法依赖范围」内的已处理轮次——
 * 下界不得越过排除高水位（清除/关闭期间的内容绝不回流），上界不得超过当前有效
 * 总结的覆盖范围（那是唯一合法的原文依赖），且必须存在有效总结（合法依赖存在）。
 * 最多 4 个完整轮次、1,000 tokens；不推进进度，但所有实际读取均进入来源核验。
 */
async function readAdjacentTurns(
  deps: MaintenanceDeps,
  input: {
    readonly conversationId: string;
    readonly batchFromOrdinal: number;
    readonly excludedThrough: number;
    readonly coveredThroughOrdinal: number;
    readonly hasLegalDependency: boolean;
    readonly countTokens: (text: string) => number;
  },
): Promise<readonly EvidenceTurn[]> {
  if (!input.hasLegalDependency) return [];
  const rangeEnd = Math.min(input.batchFromOrdinal - 1, input.coveredThroughOrdinal);
  const rangeStart = Math.max(input.excludedThrough + 1, rangeEnd - 3, 1);
  if (rangeStart > rangeEnd) return [];
  try {
    const window = await deps.evidenceReader.readTurnWindow({
      conversationId: input.conversationId,
      fromOrdinal: rangeStart,
      through: { turnId: "", ordinal: rangeEnd, sourceRevision: 0 },
    });
    const adjacent: EvidenceTurn[] = [];
    let used = 0;
    for (const turn of [...window.turns].reverse()) {
      const cost = input.countTokens(`${turn.role}\n${turn.text}`);
      if (used + cost > MAINTENANCE_ADJACENT_TOKEN_BUDGET) break;
      adjacent.unshift(turn);
      used += cost;
    }
    return adjacent;
  } catch {
    return [];
  }
}

function evidenceId(turn: EvidenceTurn): string {
  return `source:${turn.role === "user" ? "u" : "a"}${turn.ordinal}`;
}

// ---------------------------------------------------------------------------
// maintainConversationJob 主流程
// ---------------------------------------------------------------------------

export type MaintenanceDeps = {
  readonly controlRepository: MemoryControlRepository;
  readonly documentRepository: MemoryDocumentRepository;
  readonly evidenceReader: OrdinaryEvidenceReader;
  readonly model: MemoryMaintenanceModelPort;
  /** 缺省用 js-tiktoken o200k_base；测试可注入确定性计数。 */
  readonly countTokens?: (text: string) => number;
  readonly fullConversationTokenBudget?: number;
  /** 后台请求输入容量硬顶（N04，实验参数；缺省 MAINTENANCE_MAX_REQUEST_INPUT_TOKENS）。 */
  readonly maxRequestInputTokens?: number;
  readonly now?: () => number;
};

export type MaintenanceJobOutcome =
  | { readonly status: "completed"; readonly mode: "full_conversation" | "incremental"; readonly longTermUpdated: boolean; readonly processedThroughOrdinal: number }
  | { readonly status: "no_evidence" }
  | { readonly status: "not_claimed" }
  | { readonly status: "retry_queued"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

export async function maintainConversationJob(deps: MaintenanceDeps, jobId: string): Promise<MaintenanceJobOutcome> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const countTokens = deps.countTokens ?? countMemoryTokens;

  // 1. CAS 领取：并发调度下只有一个执行者能拿到 running + claimToken。
  const claimToken = `claim:${jobId}:${now()}`;
  const claimed = await deps.controlRepository.claimJob({ jobId, claimToken, now: now() });
  if (claimed === undefined) {
    return { status: "not_claimed" };
  }

  const requeue = async (reason: string, useBackoff: boolean): Promise<MaintenanceJobOutcome> => {
    const exhausted = useBackoff && claimed.attempt >= MAINTENANCE_MAX_ATTEMPTS;
    const backoffIndex = Math.min(Math.max(claimed.attempt - 1, 0), MAINTENANCE_RETRY_DELAYS_MS.length - 1);
    await deps.controlRepository.finishJob({
      jobId,
      claimToken,
      status: exhausted ? "failed" : "queued",
      now: now(),
      nextAttemptAt: exhausted || !useBackoff ? null : now() + MAINTENANCE_RETRY_DELAYS_MS[backoffIndex],
      lastFailure: reason,
    });
    return exhausted ? { status: "failed", reason } : { status: "retry_queued", reason };
  };
  const convergeQuietly = async (): Promise<void> => {
    try {
      await deps.controlRepository.finishJob({ jobId, claimToken, status: "done", now: now() });
    } catch {
      // 残留 running 由重启恢复兜底（recoverInterruptedJobs）。
    }
  };

  try {
    const conversationId = claimed.conversationId;
    const ownerKey = claimed.ownerKey;
    const owner = memoryOwnerFromKey(ownerKey);
    if (owner.kind === "global") throw new Error("memory_invalid_owner");

    // 2. 领取后的当次 admission 预检（明显失效的批次不烧模型调用；权威结论仍以
    //    提交边界锁内重读为准）。
    const [policyRows, ownerLifecycle, conversationLifecycle, progress] = await Promise.all([
      deps.controlRepository.readAllPolicy(),
      deps.controlRepository.getLifecycle(ownerKey),
      deps.controlRepository.getLifecycle(`conversation:${conversationId}`),
      deps.documentRepository.getProgress(conversationId),
    ]);
    const admission = resolveAdmissionFromPolicy({
      owner,
      conversationId,
      policyRows,
      ownerLifecycle,
      conversationLifecycle,
    });
    if (admission.effective === "off" ||
        admission.policyRevision !== claimed.policyRevision ||
        admission.generation !== claimed.generation) {
      // 关闭/清除后的残余任务直接收敛；启用边界由 Admin 的排除高水位负责。
      await convergeQuietly();
      return { status: "no_evidence" };
    }

    // 3. 处理起点与目标边界：片段进度优先（N04），其次完整轮次边界；
    //    legalStart 是「合法原文」下界（R02/R08：排除区间不进入后台输入）。
    const excludedThrough = progress?.excludedThroughOrdinal ?? 0;
    const processedThrough = progress?.processedThroughOrdinal ?? 0;
    const fragmentOrdinal = progress?.processedFragmentOrdinal ?? null;
    const fragmentEnd = progress?.processedFragmentEnd ?? 0;
    const targetThrough = claimed.targetThroughOrdinal;
    const inFragment = fragmentOrdinal !== null
      && fragmentOrdinal > excludedThrough
      && fragmentOrdinal <= targetThrough;
    const startOrdinal = inFragment ? fragmentOrdinal : Math.max(processedThrough, excludedThrough) + 1;
    const legalStartOrdinal = excludedThrough + 1;
    if (startOrdinal > targetThrough) {
      await convergeQuietly();
      return { status: "no_evidence" };
    }

    // 4. 新增证据窗（适配器保证不跳洞；缺口前的连续块先行处理）。
    const newEvidenceWindow = await deps.evidenceReader.readTurnWindow({
      conversationId,
      fromOrdinal: startOrdinal,
      through: { turnId: "", ordinal: targetThrough, sourceRevision: 0 },
    });
    if (newEvidenceWindow.turns.length === 0) {
      await convergeQuietly();
      return { status: "no_evidence" };
    }

    // 5. 旧产物与请求容量（N04）：系统提示 + 旧产物 + 输出预留之外的剩余容量
    //    才是本次证据预算；连最低处理单元都容纳不下时明确报容量不足。
    const [previousSummary, currentMemoryHead] = await Promise.all([
      deps.documentRepository.getLatestValidSummary(conversationId),
      deps.documentRepository.getActiveOwnerMemoryHead(ownerKey),
    ]);
    const baseCost = countTokens(MAINTENANCE_SYSTEM_PROMPT)
      + (previousSummary === undefined ? 0 : countTokens(previousSummary.markdown))
      + (currentMemoryHead === undefined ? 0 : countTokens(currentMemoryHead.markdown))
      + MAINTENANCE_OUTPUT_RESERVE_TOKENS
      + limits.MAINTENANCE_INITIAL_ENTRY_TOKEN_BUDGET
      + limits.MAINTENANCE_READ_TOKEN_BUDGET
      + limits.MAINTENANCE_REQUEST_WRAPPER_RESERVE_TOKENS;
    const evidenceCapacity = (deps.maxRequestInputTokens ?? MAINTENANCE_MAX_REQUEST_INPUT_TOKENS) - baseCost;
    if (evidenceCapacity < MAINTENANCE_MIN_EVIDENCE_CAPACITY_TOKENS) {
      await deps.controlRepository.finishJob({
        jobId,
        claimToken,
        status: "failed",
        now: now(),
        lastFailure: "input_capacity_exceeded",
      });
      return { status: "failed", reason: "input_capacity_exceeded" };
    }

    // 6. 模式选择与分组消费：合法全文可容纳时优先对照原文（R08，片段进行中
    //    除外——先把未读完的轮次消费完）；否则有界增量，完整轮次优先、单轮
    //    超容量按片段消费（R01 + N04）。
    const fullBudget = deps.fullConversationTokenBudget ?? MAINTENANCE_FULL_CONVERSATION_TOKEN_BUDGET;
    const legalFullWindow = legalStartOrdinal < startOrdinal
      ? await deps.evidenceReader.readTurnWindow({
          conversationId,
          fromOrdinal: legalStartOrdinal,
          through: { turnId: "", ordinal: targetThrough, sourceRevision: 0 },
        })
      : newEvidenceWindow;
    const legalFullTokens = legalFullWindow.turns.reduce(
      (sum, turn) => sum + countTokens(`${turn.role}\n${turn.text}`),
      0,
    );
    const fullMode = !inFragment
      && legalFullWindow.turns.length > 0
      && legalFullTokens <= Math.min(fullBudget, evidenceCapacity);
    const consumption = fullMode
      ? {
          batch: legalFullWindow.turns,
          completeThroughOrdinal: legalFullWindow.turns.at(-1)!.ordinal,
          fragment: null,
        }
      : consumeEvidenceGroups(newEvidenceWindow.turns, {
          startOrdinal,
          startFragmentOffset: inFragment ? fragmentEnd : 0,
          capacity: evidenceCapacity,
          countTokens,
        });
    const newTurns = consumption.batch;
    if (newTurns.length === 0 || consumption.completeThroughOrdinal < startOrdinal - 1) {
      await convergeQuietly();
      return { status: "no_evidence" };
    }
    const batchFromOrdinal = newTurns[0]!.ordinal;
    const batchToOrdinal = consumption.completeThroughOrdinal;

    // 7. 有限相邻原文（incremental 模式，R02）：只允许来自仍合法的依赖范围——
    //    不得越过排除高水位，且必须落在当前有效总结已覆盖的范围之内；不存在
    //    有效总结（清除后首次整理）时不提供任何相邻旧内容。
    const adjacentTurns = fullMode
      ? []
      : await readAdjacentTurns(deps, {
          conversationId,
          batchFromOrdinal,
          excludedThrough,
          coveredThroughOrdinal: previousSummary?.coveredThroughOrdinal ?? 0,
          hasLegalDependency: previousSummary !== undefined,
          countTokens,
        });
    const evidenceTurns: readonly EvidenceTurn[] = [...adjacentTurns, ...newTurns];

    const expectedConversationGeneration = conversationLifecycle?.generation ?? 0;
    const newSources: MemorySource[] = [];
    const sourceByIdentity = new Map<string, MemorySource>();
    const evidenceItems: MaintenanceEvidenceItem[] = evidenceTurns.map((turn, index) => {
      const identity = `${turn.ordinal}:${turn.sourceRevision}`;
      let source = sourceByIdentity.get(identity);
      if (!source) {
        source = { sourceId: createId("memory-source"), owner,
          locator: { kind: "conversation_range", conversationId, fromOrdinal: turn.ordinal, toOrdinal: turn.ordinal,
            sourceRevision: turn.sourceRevision, conversationGeneration: expectedConversationGeneration },
          lifecycle: "present", branch: "selected", createdAt: now() };
        sourceByIdentity.set(identity, source); newSources.push(source);
      }
      return { id: `${evidenceId(turn)}:${index}`, sourceId: source.sourceId, role: turn.role,
        reportedAt: turn.occurredAt, text: redactSensitiveContent(turn.text), sourceRef: `run:${turn.runId}:ordinal:${turn.ordinal}` };
    });
    const newEvidence = evidenceItems.slice(adjacentTurns.length).filter((e, i) => newTurns[i]!.ordinal >= startOrdinal);
    const entries = new Map<string, MemoryEntryRevisionView>();
    const sources = new Map<string, MemorySourceView>();
    const readSet = new Map<string, { sourceId: string; conversationGeneration: number | null }>();
    const entryReadSet = new Map<string, { entryId: string; revisionId: string; expectedHeadRevisionId: string }>();
    for (const source of newSources) readSet.set(source.sourceId, { sourceId: source.sourceId, conversationGeneration: expectedConversationGeneration });
    const observeEntry = (item: MemoryEntryRevisionView): void => {
      if (JSON.stringify(item.entry.owner) !== JSON.stringify(owner)) throw new Error("entry_owner_invalid");
      const key = item.revision.revisionId;
      if (entries.has(key)) return;
      entries.set(key, item); entryReadSet.set(key, { entryId: item.entry.entryId, revisionId: key, expectedHeadRevisionId: item.entry.headRevisionId });
      for (const source of item.sources) {
        if (JSON.stringify(source.owner) !== JSON.stringify(owner)) throw new Error("source_owner_invalid");
        sources.set(source.sourceId, source);
      }
    };
    const resolve = async (refs: readonly { entryId: string; revisionId: string }[]) => {
      const items = await deps.documentRepository.resolveEntries({ ownerKey, expectedPolicyRevision: claimed.policyRevision,
        expectedGeneration: claimed.generation, entries: refs });
      return items ?? [];
    };
    const topics = (await deps.documentRepository.listTopics(ownerKey)).slice(0, limits.MAINTENANCE_MAX_TOPICS);
    const discover = async (query: string, topicId?: string) => {
      const match = lexicalMatchExpression(query);
      if (!match) return [];
      const found = await deps.documentRepository.searchEntryCandidates({ ownerKey, match, includeHistory: false, limit: 8,
        ...(topicId === undefined ? {} : { topicId }) });
      return resolve(found.candidates);
    };
    let initialEntryTokens = 0;
    for (const item of await discover(newTurns.map((t) => t.text).join(" ").slice(0, 512))) {
      const cost = countTokens(JSON.stringify(item));
      if (initialEntryTokens + cost > limits.MAINTENANCE_INITIAL_ENTRY_TOKEN_BUDGET) continue;
      observeEntry(item); initialEntryTokens += cost;
    }
    let suppliedOverview = toMemoryPayload(currentMemoryHead);
    if (currentMemoryHead) {
      const dependencies = await deps.documentRepository.listOverviewDependencies(currentMemoryHead.revisionId);
      const overviewEntries = await resolve(dependencies.entries);
      const extra = overviewEntries.filter((item) => !entries.has(item.revision.revisionId));
      const cost = extra.reduce((sum, item) => sum + countTokens(JSON.stringify(item)), 0);
      if (overviewEntries.length !== dependencies.entries.length || initialEntryTokens + cost > limits.MAINTENANCE_INITIAL_ENTRY_TOKEN_BUDGET) {
        suppliedOverview = null;
      } else {
        for (const item of extra) observeEntry(item);
        initialEntryTokens += cost;
      }
    }
    const initialEntryRevisionIds = new Set(entries.keys());
    const readResults: MemoryConsolidationReadResult[] = [];
    let readTokens = 0;
    const readPort: MemoryConsolidationReadPort = {
      async read(request) {
        const result = (outcome: MemoryConsolidationReadResult["outcome"], content = "") => ({ request, outcome, content });
        if (now() - startedAt >= limits.MAINTENANCE_MAX_LATENCY_MS || readTokens >= limits.MAINTENANCE_READ_TOKEN_BUDGET) return result("budget_exceeded");
        let content: string;
        if (request.kind === "read_evidence") {
          const source = sources.get(request.sourceId);
          if (!source || source.readback !== "available" || source.lifecycle !== "present" || source.branch !== "selected" || source.locator.kind !== "conversation_range") return result("unavailable");
          const locator = source.locator;
          const [life, sourceProgress, rows, ownerLife] = await Promise.all([
            deps.controlRepository.getLifecycle(`conversation:${locator.conversationId}`),
            deps.documentRepository.getProgress(locator.conversationId), deps.controlRepository.readAllPolicy(),
            deps.controlRepository.getLifecycle(ownerKey),
          ]);
          const sourceAdmission = resolveAdmissionFromPolicy({ owner, conversationId: locator.conversationId,
            policyRows: rows, ownerLifecycle: ownerLife, conversationLifecycle: life });
          if (sourceAdmission.effective === "off" || sourceAdmission.policyRevision !== claimed.policyRevision ||
              sourceAdmission.generation !== claimed.generation || (life?.generation ?? 0) !== locator.conversationGeneration ||
              locator.fromOrdinal <= (sourceProgress?.excludedThroughOrdinal ?? 0)) return result("unavailable");
          const window = await deps.evidenceReader.readTurnWindow({ conversationId: locator.conversationId, fromOrdinal: locator.fromOrdinal,
            through: { turnId: "", ordinal: locator.toOrdinal, sourceRevision: locator.sourceRevision } });
          readSet.set(source.sourceId, { sourceId: source.sourceId, conversationGeneration: life?.generation ?? 0 });
          if (!window.turns.length || window.turns.some((t) => t.ordinal < locator.fromOrdinal || t.ordinal > locator.toOrdinal || t.sourceRevision !== locator.sourceRevision)) return result("unavailable");
          const after = await deps.controlRepository.getLifecycle(`conversation:${locator.conversationId}`);
          if ((after?.generation ?? 0) !== locator.conversationGeneration || (after && after.fenceState !== "none")) return result("unavailable");
          content = JSON.stringify(window.turns.map((t) => ({ ordinal: t.ordinal, role: t.role, reportedAt: t.occurredAt, text: redactSensitiveContent(t.text) })));
        } else {
          let items: readonly MemoryEntryRevisionView[];
          if (request.kind === "search_entries") {
            if (request.topicId && !topics.some((t) => t.topicId === request.topicId)) return result("not_found");
            items = await discover(request.query, request.topicId);
          } else {
            const entry = await deps.documentRepository.getEntry({ ownerKey, entryId: request.entryId });
            if (!entry) return result("not_found");
            items = await resolve([{ entryId: request.entryId, revisionId: request.revisionId ?? entry.headRevisionId }]);
          }
          const exposed: MemoryEntryRevisionView[] = [];
          for (const item of items) {
            if (countTokens(JSON.stringify([...exposed, item])) > limits.MAINTENANCE_READ_TOKEN_BUDGET - readTokens - 100) break;
            exposed.push(item); observeEntry(item);
          }
          if (!exposed.length) return result(items.length ? "budget_exceeded" : "not_found");
          content = JSON.stringify(exposed);
        }
        const cost = countTokens(JSON.stringify(result("ok", content)));
        if (readTokens + cost > limits.MAINTENANCE_READ_TOKEN_BUDGET) return result("budget_exceeded");
        readTokens += cost; return result("ok", content);
      },
    };
    const metadata: MaintenanceRequestMetadata = {
      conversationRef: conversationId, spaceRef: ownerKey, generatedAt: new Date(now()).toISOString(), displayTimezone: "local",
      mode: fullMode ? "full_conversation" : "incremental",
      providedCoverage: fullMode ? `ordinal ${legalStartOrdinal}..${targetThrough}（合法全文）` : `ordinal ${batchFromOrdinal}..${batchToOrdinal}, fragment ${JSON.stringify(consumption.fragment)}`,
      summaryTargetTokens: MAINTENANCE_SUMMARY_TARGET_TOKENS, summaryMaxTokens: MAINTENANCE_SUMMARY_MAX_TOKENS,
      memoryTargetTokens: MAINTENANCE_MEMORY_TARGET_TOKENS, memoryMaxTokens: MAINTENANCE_MEMORY_MAX_TOKENS,
    };
    const previousSummaryPayload: MaintenanceInputPayload["previousSummary"] = previousSummary === undefined ? null : {
      ref: `summary:${previousSummary.revisionId}`, markdown: redactSensitiveContent(previousSummary.markdown), origin: "model",
      updatedAt: new Date(previousSummary.updatedAt).toISOString(), sourceCoverage: `ordinal ${legalStartOrdinal}..${previousSummary.coveredThroughOrdinal}`,
    };
    const availableNewEntryIds = Array.from({ length: limits.MAINTENANCE_MAX_ENTRY_MUTATIONS }, () => createId("memory-entry"));
    const availableNewTopicIds = Array.from({ length: limits.MAINTENANCE_MAX_NEW_TOPICS }, () => createId("memory-topic"));
    const allowedSummaryRefs = [...evidenceItems.map((item) => item.id), ...(previousSummaryPayload ? [previousSummaryPayload.ref] : [])];
    const allowedSourceIds = () => [...newSources.map((s) => s.sourceId), ...sources.keys()];
    const requestMessages = () => buildMaintenanceMessages({ requestMetadata: metadata, previousSummary: previousSummaryPayload,
      currentMemory: suppliedOverview, evidence: evidenceItems,
      entries: [...entries.values()].filter((v) => initialEntryRevisionIds.has(v.revision.revisionId)), existingTopics: topics,
      availableNewEntryIds, availableNewTopicIds, readResults, allowedSourceIds: allowedSourceIds() });
    let rounds = 0;
    let repaired = false;
    let repairReason: string | null = null;
    let totalTokens = 0;
    let validated: ReturnType<typeof validateMaintenanceOutput>;
    for (;;) {
      const messages = requestMessages().map((message) => message.role === "user" ? { ...message, content: redactSensitiveContent(message.content) } : message);
      if (repairReason) messages.push({ role: "user", content: `结构校验失败：${repairReason}。只返回符合契约的JSON。` });
      const inputTokens = messages.reduce((sum, m) => sum + countTokens(m.content), 0);
      if (inputTokens + MAINTENANCE_OUTPUT_RESERVE_TOKENS > (deps.maxRequestInputTokens ?? MAINTENANCE_MAX_REQUEST_INPUT_TOKENS) ||
          totalTokens + inputTokens + MAINTENANCE_OUTPUT_RESERVE_TOKENS > limits.MAINTENANCE_MAX_TOTAL_REQUEST_TOKENS ||
          now() - startedAt >= limits.MAINTENANCE_MAX_LATENCY_MS) {
        validated = { ok: false, reason: "request_budget_exceeded" }; break;
      }
      totalTokens += inputTokens + MAINTENANCE_OUTPUT_RESERVE_TOKENS;
      const outcome = await deps.model.generate({ messages, maxLatencyMs: limits.MAINTENANCE_MAX_LATENCY_MS - (now() - startedAt) });
      if (outcome.status === "unavailable") return await requeue(`model_unavailable:${outcome.reason}`, true);
      if (now() - startedAt >= limits.MAINTENANCE_MAX_LATENCY_MS) {
        validated = { ok: false, reason: "request_deadline_exceeded" }; break;
      }
      if (countTokens(outcome.text) > MAINTENANCE_OUTPUT_RESERVE_TOKENS) {
        validated = { ok: false, reason: "output_over_budget" };
      } else {
        const parsed = maintenanceOutputSchema.safeParse(parseModelJson(outcome.text));
        if (parsed.success && parsed.data.status === "needs_read" && rounds < limits.MAINTENANCE_MAX_READ_ROUNDS && !repairReason) {
          rounds += 1;
          for (const request of parsed.data.requests) readResults.push(await readPort.read(request));
          continue;
        }
        validated = parsed.success && parsed.data.status === "ready"
          ? validateMaintenanceOutput({ output: parsed.data, allowedSummaryRefs, allowedSourceIds: allowedSourceIds(),
            newEvidence, entries: [...entries.values()], availableNewEntryIds, existingTopics: topics, availableNewTopicIds, countTokens })
          : { ok: false, reason: parsed.success ? "read_rounds_exhausted" : "model_output_invalid" };
      }
      if (validated.ok || repaired) break;
      repaired = true; repairReason = validated.reason;
    }
    if (!validated.ok) {
      await deps.controlRepository.finishJob({ jobId, claimToken, status: "failed", now: now(), lastFailure: validated.reason });
      return { status: "failed", reason: validated.reason };
    }
    const mutations = validated.value.mutations.map((m) => ({ ...m, revisionId: createId("memory-entry-revision") }));
    const proposalOverview = validated.value.overview;
    const overview = proposalOverview === null ? null : { markdown: proposalOverview.markdown,
      entries: proposalOverview.entryIds.map((entryId) => {
        const mutation = mutations.find((m) => m.entryId === entryId);
        const existing = [...entries.values()].find((v) => v.entry.entryId === entryId && v.revision.revisionId === v.entry.headRevisionId);
        return { entryId, revisionId: mutation?.revisionId ?? existing!.revision.revisionId };
      }) };
    const lastEvidenceRevision = newTurns.at(-1)!.sourceRevision;
    const commitInput: CommitMemoryEntriesBatchInput = {
      jobId, claimToken, conversationId, ownerKey, expectedPolicyRevision: claimed.policyRevision, expectedGeneration: claimed.generation,
      expectedConversationGeneration, expectedSummaryRevisionId: previousSummary?.revisionId ?? null,
      expectedMemoryHeadRevisionId: currentMemoryHead?.revisionId ?? null,
      summary: { markdown: validated.value.summaryMarkdown, coveredThroughOrdinal: Math.max(batchToOrdinal, previousSummary?.coveredThroughOrdinal ?? 0) },
      mutations, topics: validated.value.topics.map((topic) => ({ ...topic, owner })), sources: newSources, readSet: [...readSet.values()], entryReadSet: [...entryReadSet.values()], overview,
      batchRange: { fromOrdinal: batchFromOrdinal, toOrdinal: Math.max(batchToOrdinal, consumption.fragment?.ordinal ?? batchToOrdinal), sourceRevision: lastEvidenceRevision },
      advanceProgressTo: { ordinal: batchToOrdinal, sourceFingerprint: `rev:${lastEvidenceRevision}`,
        ...(consumption.fragment === null ? {} : { fragment: consumption.fragment }) },
    };
    const commit = await deps.documentRepository.commitMaintenanceBatch(commitInput);
    if (commit.status === "discarded") {
      if (commit.reason === "admission_off" || commit.reason === "range_excluded") {
        await convergeQuietly();
        return { status: "no_evidence" };
      }
      if (commit.reason === "claim_stale") {
        return { status: "not_claimed" };
      }
      // summary/memory head 被用户编辑或并发整理取代：退避重排后按最新理解重读。
      return await requeue(commit.reason, true);
    }

    return {
      status: "completed",
      mode: fullMode ? "full_conversation" : "incremental",
      longTermUpdated: commit.memoryRevisionId !== null,
      processedThroughOrdinal: commitInput.advanceProgressTo.ordinal,
    };
  } catch (error) {
    // 未预期失败（含存储完整性错误）：不推进游标、不伪造记录，退避重排；
    // 结构化错误上抛到调度层诊断，不吞进"成功"。
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : "unexpected_error";
    return await requeue(reason, true);
  }
}

function toMemoryPayload(head: OwnerMemoryBackground | undefined): MaintenanceInputPayload["currentMemory"] {
  return head === undefined ? null : {
    ref: `memory:${head.revisionId}`,
    markdown: redactSensitiveContent(head.markdown),
    origin: head.origin,
    updatedAt: new Date(head.updatedAt).toISOString(),
  };
}
