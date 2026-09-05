import { memoryOwnerKey } from "../../../domain/memory/index.js";
import type {
  MemoryCaptureAcceptance,
  MemoryCaptureRuntime,
  MemoryCaptureSignal,
  OrdinaryEvidenceReader,
} from "../contracts.js";
import { resolveAdmissionFromPolicy } from "../policy/policy-snapshot.js";
import type { MemoryDocumentRepository } from "../store/content-repository.js";
import type { MemoryControlRepository } from "../store/control-repository.js";

/**
 * 稳定信号接单（0.6.0）。Ordinary Run 稳定终结后：
 *   Policy Gate（当次新鲜、fail-closed）→ transcript 索引增量覆盖 →
 *   每会话待办登记（eligibleAt = stableAt + 空闲时长）。
 *
 * 边界：
 * - effective=off（未同意/未参与/被 fence/rollout off）一律 skipped；不逐信号推进
 *   游标——启用/重新启用时由 Admin 按 Ordinary 高水位写 excludedThrough 覆盖关闭区间，
 *   保证重新开启不回填（正式设计 §11.2）；
 * - shadow 与 active 在接单阶段行为一致，差别只在注入侧；
 * - transcript 索引是独立原文查询职责的派生投影：从上次覆盖点起做连续增量索引，
 *   不触发整理、不推进整理进度；
 * - 同会话新信号只扩大 requestedThrough 并重算 eligibleAt（durable 边界不丢，
 *   迟到的旧信号不缩小边界）。
 *
 * 本层不调模型、不做 idle 等待（panel-server 的维护调度器持有唤醒器并领取任务）。
 */

/** 稳定 Run 后的会话空闲整理计时（正式设计 §13 首版行为，实验参数）。 */
export const MAINTENANCE_IDLE_DELAY_MS = 270_000;

export interface MemorySignalAcceptorDeps {
  readonly controlRepository: MemoryControlRepository;
  readonly documentRepository: MemoryDocumentRepository;
  readonly evidenceReader: OrdinaryEvidenceReader;
  readonly idleDelayMs?: number;
  readonly now?: () => number;
}

function skipped(reason: string): MemoryCaptureAcceptance {
  return { status: "skipped", reason };
}

export function createMemoryCaptureRuntime(deps: MemorySignalAcceptorDeps): MemoryCaptureRuntime {
  const idleDelayMs = deps.idleDelayMs ?? MAINTENANCE_IDLE_DELAY_MS;
  const now = deps.now ?? Date.now;

  async function acceptStableSignal(signal: MemoryCaptureSignal): Promise<MemoryCaptureAcceptance> {
    const ownerKey = memoryOwnerKey(signal.owner);
    const conversationKey = `conversation:${signal.conversationId}`;
    const at = now();

    // 1. Policy Gate（当次重算，fail-closed）。
    const [policyRows, ownerLifecycle, conversationLifecycle, progress] = await Promise.all([
      deps.controlRepository.readAllPolicy(),
      deps.controlRepository.getLifecycle(ownerKey),
      deps.controlRepository.getLifecycle(conversationKey),
      deps.documentRepository.getProgress(signal.conversationId),
    ]);
    const admission = resolveAdmissionFromPolicy({
      owner: signal.owner,
      conversationId: signal.conversationId,
      policyRows,
      ownerLifecycle,
      conversationLifecycle,
    });
    if (admission.effective === "off") {
      return skipped(admission.reasons[0] ?? "effective_off");
    }

    // 2. 没有越过处理/排除边界的新证据时不登记待办（无新增合格内容不调模型）。
    const processedFloor = Math.max(
      progress?.processedThroughOrdinal ?? 0,
      progress?.excludedThroughOrdinal ?? 0,
    );
    if (signal.stableThrough.ordinal <= processedFloor) {
      return skipped("no_new_stable_evidence");
    }

    // 3. transcript 索引增量覆盖（独立于整理进度；连续块止于第一个缺口）。
    const coverage = await deps.documentRepository.getTranscriptCoverage(signal.conversationId);
    const indexFromOrdinal = (coverage?.indexedThroughOrdinal ?? 0) + 1;
    if (indexFromOrdinal <= signal.stableThrough.ordinal) {
      const window = await deps.evidenceReader.readTurnWindow({
        conversationId: signal.conversationId,
        fromOrdinal: indexFromOrdinal,
        through: signal.stableThrough,
      });
      if (window.turns.length > 0) {
        const entries = collectOrdinalTexts(window.turns);
        await deps.documentRepository.indexTranscriptRange({
          conversationId: signal.conversationId,
          ownerKey,
          entries,
          now: at,
        });
      }
    }

    // 4. 每会话待办：存在活跃 job 则扩大边界并重算 eligibleAt，否则新建。
    const job = await deps.controlRepository.acceptConversationSignal({
      conversationId: signal.conversationId,
      ownerKey,
      stableThroughOrdinal: signal.stableThrough.ordinal,
      sourceFingerprint: `rev:${signal.stableThrough.sourceRevision}`,
      eligibleAt: at + idleDelayMs,
      now: at,
      generation: admission.generation,
      policyRevision: admission.policyRevision,
    });
    if (job === undefined) {
      return skipped("no_new_stable_evidence");
    }
    return { status: "accepted", conversationId: signal.conversationId, eligibleAt: job.eligibleAt };
  }

  return {
    acceptStableSignal,
    async release(): Promise<void> {
      // 无后台定时器/资源（唤醒器归维护调度器所有）。
    },
  };
}

/** 同一 ordinal 的 user/assistant 文本合并为一条索引记录（检索按轮命中）。 */
function collectOrdinalTexts(
  turns: readonly { readonly ordinal: number; readonly role: "user" | "assistant"; readonly text: string; readonly sourceRevision: number }[],
): readonly { readonly ordinal: number; readonly text: string; readonly sourceRevision: number }[] {
  const byOrdinal = new Map<number, { ordinal: number; text: string; sourceRevision: number }>();
  for (const turn of turns) {
    const existing = byOrdinal.get(turn.ordinal);
    if (existing === undefined) {
      byOrdinal.set(turn.ordinal, {
        ordinal: turn.ordinal,
        text: `[${turn.role}]\n${turn.text}`,
        sourceRevision: turn.sourceRevision,
      });
      continue;
    }
    existing.text = `${existing.text}\n[${turn.role}]\n${turn.text}`;
  }
  return [...byOrdinal.values()].sort((left, right) => left.ordinal - right.ordinal);
}
