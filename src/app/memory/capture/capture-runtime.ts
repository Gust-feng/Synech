import { memoryOwnerKey } from "../../../domain/memory/index.js";
import type {
  MemoryCaptureAcceptance,
  MemoryCaptureRuntime,
  MemoryCaptureSignal,
  OrdinaryEvidenceReader,
} from "../contracts.js";
import { resolveAdmissionFromPolicy } from "../policy/policy-snapshot.js";
import type { MemoryContentRepository } from "../store/content-repository.js";
import type { MemoryControlRepository } from "../store/control-repository.js";

/**
 * 真实 Capture Runtime（M3）。Ordinary Run 稳定终结后：
 *   Policy Gate（当次新鲜、fail-closed）→ 连续证据窗（不跳洞）→ 捕获门
 *   → durable job 落盘（进程随后退出也不丢证据段）。
 *
 * 边界（《手册》9.1/9.2/12.2）：
 * - effective=off（未同意/未参与/被排除/被 fence/rollout off）一律 skipped，不读证据、不落 job；
 * - shadow 与 active 在 capture 阶段行为一致（都接单），差别只在注入侧（Provider，T22）；
 * - 只接受连续无洞且达到最小完整轮次门的证据段；证据窗为空或游标不动则 skipped；
 * - accepted 只表示 durable job/checkpoint 已落盘，不保证一定形成长期 Memory（提炼在 T21）。
 *
 * 本层不调模型、不做 idle 计时（T21 Consolidation）；noteActivity 的重启缺口补扫
 * 也在 T21 接入调度后生效，当前保证不阻塞、不向主链路抛出。
 */

/** 新增完整问答轮次下限（手册 9.2 首轮实验参数：至少 2 个完整问答）；token 阈值门在 T21 用 tokenizer 补。 */
const MIN_FULL_TURNS_PER_CAPTURE = 2;
/** 首个 ordinal（OrdinaryRunTurn.ordinal 为 positive integer，从 1 起）。 */
const FIRST_ORDINAL = 1;

export interface CaptureRuntimeDeps {
  readonly controlRepository: MemoryControlRepository;
  readonly contentRepository: MemoryContentRepository;
  readonly evidenceReader: OrdinaryEvidenceReader;
  /** 测试钩子：覆盖最小完整轮次门。 */
  readonly minFullTurns?: number;
}

function skipped(reason: string): MemoryCaptureAcceptance {
  return { status: "skipped", reason };
}

export function createCaptureRuntime(deps: CaptureRuntimeDeps): MemoryCaptureRuntime {
  const minFullTurns = deps.minFullTurns ?? MIN_FULL_TURNS_PER_CAPTURE;

  async function acceptStableSignal(signal: MemoryCaptureSignal): Promise<MemoryCaptureAcceptance> {
    const ownerKey = memoryOwnerKey(signal.owner);
    const conversationKey = `conversation:${signal.conversationId}`;

    const [policyRows, ownerLifecycle, conversationLifecycle, existingCursor] = await Promise.all([
      deps.controlRepository.readAllPolicy(),
      deps.controlRepository.getLifecycle(ownerKey),
      deps.controlRepository.getLifecycle(conversationKey),
      deps.contentRepository.getCursor(signal.conversationId),
    ]);

    // 1. Policy Gate（当次重算，fail-closed）。
    const admission = resolveAdmissionFromPolicy({
      owner: signal.owner,
      conversationId: signal.conversationId,
      turnOverrideOff: false,
      policyRows,
      ownerLifecycle,
      conversationLifecycle,
    });
    if (admission.effective === "off") {
      return skipped(admission.reasons[0] ?? "effective_off");
    }

    // 2. 从连续游标之后读稳定证据窗（适配器保证不跳洞）。
    const fromOrdinal = existingCursor === undefined
      ? FIRST_ORDINAL
      : existingCursor.coveredThroughOrdinal + 1;
    const window = await deps.evidenceReader.readTurnWindow({
      conversationId: signal.conversationId,
      fromOrdinal,
      through: signal.stableThrough,
    });
    if (window.turns.length === 0 || window.nextCursor === undefined) {
      return skipped("no_new_stable_evidence");
    }

    // 3. 捕获门：本次连续覆盖到的新增完整轮次达到下限才接单。
    const previousOrdinal = existingCursor?.coveredThroughOrdinal ?? 0;
    const newFullTurns = window.nextCursor.coveredThroughOrdinal - previousOrdinal;
    if (newFullTurns < minFullTurns) {
      // 不推进游标、不落 job，等后续稳定轮次凑够门限。
      return skipped("below_capture_threshold");
    }

    // 4. durable job：存在活跃 job 则推进其边界，否则新建 queued（durable 边界不丢）。
    const job = await deps.controlRepository.enqueueOrAdvanceJob({
      conversationId: signal.conversationId,
      ownerKey,
      coveredThroughTurnId: signal.stableThrough.turnId,
      coveredThroughOrdinal: window.nextCursor.coveredThroughOrdinal,
      sourceFingerprint: window.nextCursor.sourceFingerprint,
      generation: admission.generation,
      policyRevision: admission.policyRevision,
    });

    return {
      status: "accepted",
      checkpoint: {
        conversationId: signal.conversationId,
        coveredThroughOrdinal: job.coveredThroughOrdinal,
        sourceFingerprint: job.sourceFingerprint,
      },
    };
  }

  return {
    acceptStableSignal,
    async noteActivity(): Promise<void> {
      // T21 接入 idle/consolidation 调度后在此补扫重启遗留缺口；当前不动作且绝不抛出。
    },
    async release(): Promise<void> {
      // 无后台定时器/资源（T21 起持有 idle scheduler 时在此释放）。
    },
  };
}
