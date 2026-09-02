import { createHash } from "node:crypto";

import { getEncoding, type Tiktoken } from "js-tiktoken";
import { z } from "zod";

import type { EvidenceTurn, MemoryCaptureSignal, OrdinaryEvidenceReader } from "../contracts.js";
import { resolveAdmissionFromPolicy } from "../policy/policy-snapshot.js";
import {
  memoryOwnerFromKey,
  type ConsolidationRecordInput,
  type ConsolidationSourceInput,
  type MemoryContentRepository,
} from "../store/content-repository.js";
import type { MemoryControlRepository } from "../store/control-repository.js";
import { evidenceClassSchema, recordKindSchema } from "../store/persistence-schema.js";

/**
 * Consolidation 提炼管线（T21，《手册》9.1/9.3/9.4）：
 *
 *   durable job（T20 accept 落盘）→ CAS queued→running → 当次 admission 预检
 *   → OrdinaryEvidenceReader 连续证据窗 → 按模型 token 切块
 *   → 辅助模型提炼（purpose=memory_consolidation）→ zod + Host 校验
 *   → 提交边界锁内重读 admission → Record+Source+Cursor+job 同事务原子提交。
 *
 * 失败语义（《手册》13.2，绝不伪造记录、绝不推进游标）：
 * - 模型不可用 / 未预期错误：job 退回 queued 保持可重试，游标不动；
 * - 模型输出无法通过 zod / Host 校验（引用越界、目标不存在）：job 置 failed
 *   终止自动重试（避免对同一段证据无限重复烧模型调用）；证据不丢——后续
 *   稳定信号会经 enqueueOrAdvanceJob 产生新 queued job 重新覆盖该窗口；
 * - admission 变化（off / revision / generation 不符）：废弃本批，job 退回
 *   queued 从合法边界重试，游标不推进；
 * - 游标只推进到实际送入模型的最后一轮：按 token 预算切块，每块独立原子提交；
 *   块边界之后的轮次留待同 job 的下一块（或重试）继续，不允许把游标推到
 *   未送入模型的轮次。
 *
 * Host / 模型分工（《手册》9.4）：模型只做语义提炼；输入范围、结构校验、
 * 目标 ID、来源引用边界、容量与原子写入全部由本层 Host 负责。模型输出里的
 * confirmation 一律不采信，记录恒以 unconfirmed 落库（user_confirmed 只能来自
 * 用户显式 mutation）。
 */

/** 每批送入模型的证据 token 预算（首轮实验参数，手册 9.2 "单轮约 1600 tokens" 同量级）。 */
export const CONSOLIDATION_BATCH_TOKEN_BUDGET = 1600;
/** 单批允许的最大操作数（容量边界归 Host，防模型刷爆）。 */
const MAX_OPERATIONS = 8;
/** 单操作允许的最大证据引用数。 */
const MAX_CITATIONS = 16;
/** create/reinforce 文本长度边界（自包含短句，非对话复制）。 */
const MAX_MODEL_TEXT_CHARS = 600;
/** 提示词中展示的已有记忆条目上限与单条截断长度。 */
const MAX_PROMPT_RECORDS = 50;
const MAX_PROMPT_RECORD_CHARS = 200;

// ---------------------------------------------------------------------------
// 模型口：Memory Feature 只依赖窄端口，通道机制由 panel-server 适配（组合根装配）
// ---------------------------------------------------------------------------

export type ConsolidationPromptMessage = {
  readonly role: "system" | "user";
  readonly content: string;
};

export type ConsolidationModelOutcome =
  | { readonly status: "completed"; readonly text: string }
  | { readonly status: "unavailable"; readonly reason: string };

export interface ConsolidationModelPort {
  extract(input: { readonly messages: readonly ConsolidationPromptMessage[] }): Promise<ConsolidationModelOutcome>;
}

export type ConsolidationDeps = {
  readonly controlRepository: MemoryControlRepository;
  readonly contentRepository: MemoryContentRepository;
  readonly evidenceReader: OrdinaryEvidenceReader;
  readonly model: ConsolidationModelPort;
  /** 缺省用 js-tiktoken o200k_base；测试可注入确定性计数。 */
  readonly countTokens?: (text: string) => number;
  readonly batchTokenBudget?: number;
};

export type ConsolidationJobOutcome =
  | { readonly status: "completed"; readonly batches: number; readonly recordsCommitted: number; readonly cursorOrdinal: number }
  | { readonly status: "not_claimed" }
  | { readonly status: "deferred"; readonly reason: string }
  | { readonly status: "retry_queued"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

// ---------------------------------------------------------------------------
// 模型输出 schema：首版仅 create/reinforce/retire（《手册》7.3 状态机边界）
// ---------------------------------------------------------------------------

const evidenceCitationSchema = z.object({
  fromOrdinal: z.number().int().positive(),
  toOrdinal: z.number().int().positive(),
}).strict();

const createOperationSchema = z.object({
  op: z.literal("create"),
  kind: recordKindSchema,
  text: z.string().min(1).max(MAX_MODEL_TEXT_CHARS),
  evidenceClass: evidenceClassSchema,
  evidence: z.array(evidenceCitationSchema).min(1).max(MAX_CITATIONS),
}).strict();

const reinforceOperationSchema = z.object({
  op: z.literal("reinforce"),
  recordId: z.string().min(1),
  text: z.string().min(1).max(MAX_MODEL_TEXT_CHARS).optional(),
  evidence: z.array(evidenceCitationSchema).min(1).max(MAX_CITATIONS),
}).strict();

const retireOperationSchema = z.object({
  op: z.literal("retire"),
  recordId: z.string().min(1),
  evidence: z.array(evidenceCitationSchema).min(1).max(MAX_CITATIONS),
}).strict();

const extractionOutputSchema = z.object({
  operations: z.array(
    z.discriminatedUnion("op", [createOperationSchema, reinforceOperationSchema, retireOperationSchema]),
  ).max(MAX_OPERATIONS),
}).strict();

export type ExtractionOperation = z.infer<typeof extractionOutputSchema>["operations"][number];

// ---------------------------------------------------------------------------
// 提炼提示（Host 拥有输入范围与结构要求；模型只做语义提炼）
// ---------------------------------------------------------------------------

export const CONSOLIDATION_PROMPT_REF = "prompt:memory.consolidation.v1";

function extractionSystemPrompt(): string {
  return [
    "你是 Synech 的记忆提炼助手。给定一段协作对话的连续证据轮次和当前已有记忆条目，提炼少量可能对后续长期协作有帮助的原子记忆。",
    "要求：",
    '- 只输出一个 JSON 对象，形如 {"operations": [...]}，不要输出任何其他内容。',
    "- operations 中每个操作必须是以下三种之一：",
    '  - {"op":"create","kind":"preference|goal|decision|constraint|open_loop|episode","text":"自包含短句","evidenceClass":"quoted_user_evidence|observed_result|derived_synthesis","evidence":[{"fromOrdinal":N,"toOrdinal":M}]}',
    '  - {"op":"reinforce","recordId":"已有记忆条目 id","text":"可选的更新后表述","evidence":[{"fromOrdinal":N,"toOrdinal":M}]}',
    '  - {"op":"retire","recordId":"已有记忆条目 id","evidence":[{"fromOrdinal":N,"toOrdinal":M}]}（该条目已过时、被更正或不再成立时使用）',
    "- 每个操作的 evidence 必须只引用本批证据中真实出现的轮次序号（ordinal，含端点）；引用越界会导致整批被丢弃。",
    "- create 的 text 必须自包含、简短（几十字以内），不照抄整段对话，不得包含密码、密钥、token 等凭据。",
    "- 只提炼对跨对话长期协作可能有用的事实：目标、决定及其更正、稳定约束、持续未决事项、重要结果、真正稳定的协作偏好。",
    "- 寒暄、一次性问答、普通知识问答不要沉淀；没有值得沉淀的内容时返回 {\"operations\":[]}。",
    "- 用户没有明确确认的事实一律按未确认处理；系统不采信你对确认状态的声明。",
  ].join("\n");
}

function truncateForPrompt(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

export function buildExtractionMessages(
  batch: readonly EvidenceTurn[],
  activeRecords: readonly { readonly recordId: string; readonly kind: string; readonly modelText: string }[],
): ConsolidationPromptMessage[] {
  const fromOrdinal = batch[0]?.ordinal ?? 0;
  const toOrdinal = batch.at(-1)?.ordinal ?? 0;
  const recordLines = activeRecords.length === 0
    ? "（当前没有已有记忆条目）"
    : activeRecords
      .slice(0, MAX_PROMPT_RECORDS)
      .map((record) => `- (id=${record.recordId}, kind=${record.kind}) ${truncateForPrompt(record.modelText, MAX_PROMPT_RECORD_CHARS)}`)
      .join("\n");
  const evidenceLines = batch.map((turn) => `[轮 ${turn.ordinal} | ${turn.role}] ${turn.text}`);
  return [
    { role: "system", content: extractionSystemPrompt() },
    {
      role: "user",
      content: [
        "[已有记忆条目]",
        recordLines,
        "",
        `[本批证据轮次 ${fromOrdinal}–${toOrdinal}]`,
        ...evidenceLines,
      ].join("\n"),
    },
  ];
}

// ---------------------------------------------------------------------------
// Token 切块：游标只推进到实际送入模型的最后一轮
// ---------------------------------------------------------------------------

let sharedEncoding: Tiktoken | undefined;

function defaultCountTokens(text: string): number {
  sharedEncoding ??= getEncoding("o200k_base");
  return sharedEncoding.encode(text).length;
}

/** 顺序累加轮次；预算满即截断，但空批必收下一轮（超长单轮独立成批，不丢证据）。 */
export function takeTokenBoundedBatch(
  turns: readonly EvidenceTurn[],
  countTokens: (text: string) => number,
  budget: number,
): EvidenceTurn[] {
  const batch: EvidenceTurn[] = [];
  let used = 0;
  for (const turn of turns) {
    const cost = countTokens(`${turn.role}\n${turn.text}`);
    if (batch.length > 0 && used + cost > budget) break;
    batch.push(turn);
    used += cost;
  }
  return batch;
}

// ---------------------------------------------------------------------------
// Host 校验与输入构造
// ---------------------------------------------------------------------------

type ValidatedOperations = {
  creates: (Omit<ConsolidationRecordInput, "confirmation" | "generation">)[];
  reinforces: (Omit<ConsolidationRecordInput, "confirmation" | "generation">)[];
  retireRecordIds: string[];
};

/**
 * Host 校验（《手册》9.4）：任何一条操作引用越界轮次或指向不存在的目标，
 * 整批废弃（fail-closed），不是丢弃单条。
 */
function validateAndBuildOperations(
  operations: readonly ExtractionOperation[],
  input: {
    readonly batch: readonly EvidenceTurn[];
    readonly activeRecords: readonly {
      readonly recordId: string;
      readonly kind: import("../store/persistence-schema.js").PersistedRecordKind;
      readonly modelText: string;
      readonly evidenceClass: import("../contracts.js").MemoryEvidenceClass;
    }[];
    readonly conversationId: string;
  },
): { readonly ok: true; readonly value: ValidatedOperations } | { readonly ok: false; readonly reason: string } {
  const batchOrdinals = new Set(input.batch.map((turn) => turn.ordinal));
  const turnsByOrdinal = new Map<number, EvidenceTurn[]>();
  for (const turn of input.batch) {
    const turns = turnsByOrdinal.get(turn.ordinal) ?? [];
    turns.push(turn);
    turnsByOrdinal.set(turn.ordinal, turns);
  }
  const activeById = new Map(input.activeRecords.map((record) => [record.recordId, record]));

  const expandSources = (citations: readonly { readonly fromOrdinal: number; readonly toOrdinal: number }[]):
    ConsolidationSourceInput[] => {
    const sources: ConsolidationSourceInput[] = [];
    for (const citation of citations) {
      for (let ordinal = citation.fromOrdinal; ordinal <= citation.toOrdinal; ordinal += 1) {
        for (const turn of turnsByOrdinal.get(ordinal) ?? []) {
          sources.push({
            conversationId: input.conversationId,
            runId: turn.runId,
            turnId: turn.turnId,
            fromOrdinal: turn.ordinal,
            toOrdinal: turn.ordinal,
            sourceRevision: turn.sourceRevision,
          });
        }
      }
    }
    return sources;
  };

  const citationInRange = (citation: { readonly fromOrdinal: number; readonly toOrdinal: number }): boolean => {
    if (citation.fromOrdinal > citation.toOrdinal) return false;
    for (let ordinal = citation.fromOrdinal; ordinal <= citation.toOrdinal; ordinal += 1) {
      if (!batchOrdinals.has(ordinal)) return false;
    }
    return true;
  };

  const creates: ValidatedOperations["creates"] = [];
  const reinforces: ValidatedOperations["reinforces"] = [];
  const retireRecordIds: string[] = [];
  for (const operation of operations) {
    if (!operation.evidence.every(citationInRange)) {
      return { ok: false, reason: "evidence_out_of_batch_range" };
    }
    if (operation.op === "create") {
      creates.push({
        kind: operation.kind,
        modelText: operation.text,
        evidenceClass: operation.evidenceClass,
        contentHash: contentHashOf(operation.text),
        sources: expandSources(operation.evidence),
      });
    } else if (operation.op === "reinforce") {
      const existing = activeById.get(operation.recordId);
      if (existing === undefined) {
        return { ok: false, reason: "unknown_record_target" };
      }
      const text = operation.text ?? existing.modelText;
      reinforces.push({
        // reinforce 保留既有 kind/evidenceClass，仅按模型更新表述与证据。
        recordId: existing.recordId,
        kind: existing.kind,
        modelText: text,
        evidenceClass: existing.evidenceClass,
        contentHash: contentHashOf(text),
        sources: expandSources(operation.evidence),
      });
    } else {
      if (!activeById.has(operation.recordId)) {
        return { ok: false, reason: "unknown_record_target" };
      }
      if (!retireRecordIds.includes(operation.recordId)) {
        retireRecordIds.push(operation.recordId);
      }
    }
  }
  return { ok: true, value: { creates, reinforces, retireRecordIds } };
}

function contentHashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  try {
    return JSON.parse(fenced?.[1] ?? trimmed);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// consolidateJob 主流程
// ---------------------------------------------------------------------------

export async function consolidateJob(deps: ConsolidationDeps, jobId: string): Promise<ConsolidationJobOutcome> {
  // 1. CAS 接单：并发调度下只有一个执行者能拿到 running。
  const job = await deps.controlRepository.transitionJob(jobId, "queued", "running");
  if (job === undefined) {
    return { status: "not_claimed" };
  }

  const requeueQuietly = async (): Promise<void> => {
    try {
      await deps.controlRepository.transitionJob(jobId, "running", "queued");
    } catch {
      // 次生失败不再传播；残留 running 由重启恢复兜底（recoverInterruptedJobs）。
    }
  };
  const failJob = async (reason: string): Promise<ConsolidationJobOutcome> => {
    try {
      await deps.controlRepository.transitionJob(jobId, "running", "failed");
    } catch {
      // 同上：终态写失败时退回 queued 走重启恢复路径。
      await requeueQuietly();
    }
    return { status: "failed", reason };
  };

  try {
    const owner = memoryOwnerFromKey(job.ownerKey);
    const conversationId = job.conversationId;

    // 2. 模型调用前的当次 admission 预检（明显已失效的批次不烧模型调用；
    //    权威结论仍以提交边界锁内重读为准）。
    const [policyRows, ownerLifecycle, conversationLifecycle, existingCursor] = await Promise.all([
      deps.controlRepository.readAllPolicy(),
      deps.controlRepository.getLifecycle(job.ownerKey),
      deps.controlRepository.getLifecycle(`conversation:${conversationId}`),
      deps.contentRepository.getCursor(conversationId),
    ]);
    const admission = resolveAdmissionFromPolicy({
      owner,
      conversationId,
      turnOverrideOff: false,
      policyRows,
      ownerLifecycle,
      conversationLifecycle,
    });
    if (admission.effective === "off") {
      await requeueQuietly();
      return { status: "deferred", reason: admission.reasons[0] ?? "effective_off" };
    }
    if (admission.policyRevision !== job.policyRevision || admission.generation !== job.generation) {
      await requeueQuietly();
      return { status: "deferred", reason: "admission_changed_since_accept" };
    }

    const countTokens = deps.countTokens ?? defaultCountTokens;
    const batchTokenBudget = deps.batchTokenBudget ?? CONSOLIDATION_BATCH_TOKEN_BUDGET;

    // 3. 连续证据批处理循环：每块独立原子提交，游标只到该块实际入模的最后一轮。
    const through: MemoryCaptureSignal["stableThrough"] = {
      turnId: job.coveredThroughTurnId ?? "",
      ordinal: job.coveredThroughOrdinal,
      // job 不携带 accept 时的 sourceRevision；证据的权威 revision 一律取
      // reader 返回的每轮自身值（《手册》6.1），此字段仅满足 reader 入参形状。
      sourceRevision: 0,
    };
    let fromOrdinal = (existingCursor?.coveredThroughOrdinal ?? 0) + 1;
    let batches = 0;
    let recordsCommitted = 0;
    let cursorOrdinal = existingCursor?.coveredThroughOrdinal ?? 0;
    let jobOpen = true;

    while (true) {
      const window = await deps.evidenceReader.readTurnWindow({ conversationId, fromOrdinal, through });
      if (window.turns.length === 0 || window.nextCursor === undefined) break;

      const batch = takeTokenBoundedBatch(window.turns, countTokens, batchTokenBudget);
      const batchToOrdinal = batch.at(-1)?.ordinal;
      if (batchToOrdinal === undefined) break;
      const completeJob = batchToOrdinal >= job.coveredThroughOrdinal;

      // 已有记忆逐批刷新：本 job 早前块 create 的记录对后续块可见（可 reinforce/retire）。
      const activeRecords = await deps.contentRepository.listActiveByOwner(job.ownerKey);
      const outcome = await deps.model.extract({ messages: buildExtractionMessages(batch, activeRecords) });
      if (outcome.status === "unavailable") {
        await requeueQuietly();
        return { status: "retry_queued", reason: outcome.reason };
      }

      const parsed = extractionOutputSchema.safeParse(parseModelJson(outcome.text));
      if (!parsed.success) {
        return await failJob("model_output_invalid");
      }
      const validated = validateAndBuildOperations(parsed.data.operations, { batch, activeRecords, conversationId });
      if (!validated.ok) {
        return await failJob(validated.reason);
      }

      // 4. 提交边界：锁内重读 admission，Record+Source+Cursor+job 同事务原子提交。
      const commit = await deps.contentRepository.commitConsolidationWithAdmission({
        conversationId,
        ownerKey: job.ownerKey,
        jobId,
        expectedPolicyRevision: job.policyRevision,
        expectedGeneration: job.generation,
        records: [...validated.value.creates, ...validated.value.reinforces].map((record) => ({
          ...record,
          confirmation: "unconfirmed" as const,
          generation: job.generation,
        })),
        retireRecordIds: validated.value.retireRecordIds,
        advanceCursorTo: {
          coveredThroughOrdinal: batchToOrdinal,
          sourceFingerprint: `rev:${batch.at(-1)?.sourceRevision ?? 0}`,
        },
        completeJob,
      });
      if (commit.status === "discarded") {
        await requeueQuietly();
        return { status: "deferred", reason: commit.reason };
      }

      batches += 1;
      recordsCommitted += commit.recordRefs.length;
      cursorOrdinal = batchToOrdinal;
      if (completeJob) {
        jobOpen = false;
        break;
      }
      fromOrdinal = batchToOrdinal + 1;
    }

    // 5. 无可处理证据（如重启恢复后游标已到位）时把占用收敛为 done，不留悬挂 running。
    if (jobOpen) {
      await deps.controlRepository.transitionJob(jobId, "running", "done");
    }
    return { status: "completed", batches, recordsCommitted, cursorOrdinal };
  } catch (error) {
    // 未预期失败（含存储完整性错误）：不推进游标、不伪造记录，job 回 queued 可重试；
    // 结构化错误上抛到调度层诊断，不吞进"成功"。
    await requeueQuietly();
    return {
      status: "retry_queued",
      reason: error instanceof Error ? `${error.name}: ${error.message}` : "unexpected_error",
    };
  }
}
