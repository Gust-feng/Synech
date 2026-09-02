import {
  consolidateJob,
  type ConsolidationDeps,
  type ConsolidationModelPort,
} from "../../memory/capture/consolidation.js";
import type { OrdinaryEvidenceReader } from "../../memory/contracts.js";
import type { MemoryContentRepository } from "../../memory/store/content-repository.js";
import type { MemoryControlRepository } from "../../memory/store/control-repository.js";
import type { MemoryJobRow } from "../../memory/store/persistence-schema.js";

/**
 * Memory Capture 空闲调度器（T21，《手册》9.1/9.2/13.2）。
 *
 * durable 化的空闲调度：进程内只持有 270s idle timer 作为触发器，待处理边界
 * 的唯一事实源是 SQLite 里的 durable queued job（T20 accept 落盘）。每次触发
 * 都经 `listJobsByStatus('queued')` 现读现处理，进程重启后由 `recoverQueuedJobs`
 * 用同一条路径补扫，不维护内存队列，也不在启动时全量补处理历史（补扫只消费
 * 已 accept 的 job，不是 backfill）。
 *
 * 纪律：
 * - 稳定 Run / Run birth 等活动都会重置 idle timer（手册 9.2：稳定完成后重置）；
 * - 单飞串行：同一时刻至多一个 drain 在跑，drain 内逐个 job 串行；consolidateJob
 *   自身还有 queued→running CAS 兜底，并发触发也不会双跑同一 job；
 * - 失败只走诊断，绝不向主链路（stable-run 订阅 / Run birth 钩子）抛出；
 * - release 后停止触发，正在进行的 drain 允许自然收尾（job 状态机保证一致性）。
 */

/** 稳定 Run 后重置的空闲整理计时（手册 9.2 首轮实验参数，需由评测校准）。 */
export const IDLE_CONSOLIDATION_DELAY_MS = 270_000;

export type MemoryCaptureScheduler = {
  /** 活动信号（稳定 Run 终结 / Run birth）：重置 idle timer；不抛出、不阻塞。 */
  noteActivity(input: { readonly conversationId: string }): void;
  /** 启动补扫：立即串行消化当前全部 queued job（重启前遗留的 durable 边界）。 */
  recoverQueuedJobs(): Promise<void>;
  /** 停止触发并等待在途 drain 收尾（进程关闭 / restore 前调用）。 */
  release(): Promise<void>;
};

export function createMemoryCaptureScheduler(input: {
  readonly controlRepository: MemoryControlRepository;
  readonly contentRepository: MemoryContentRepository;
  readonly evidenceReader: OrdinaryEvidenceReader;
  readonly model: ConsolidationModelPort;
  readonly idleDelayMs?: number;
  readonly onDiagnostic?: (topic: string, error: unknown) => void;
}): MemoryCaptureScheduler {
  const idleDelayMs = input.idleDelayMs ?? IDLE_CONSOLIDATION_DELAY_MS;
  const onDiagnostic = input.onDiagnostic ?? ((topic, error) => console.error(`[panel-server] ${topic}`, error));

  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let drainPromise: Promise<void> | undefined;
  let drainRequestedAgain = false;

  const consolidationDeps: ConsolidationDeps = {
    controlRepository: input.controlRepository,
    contentRepository: input.contentRepository,
    evidenceReader: input.evidenceReader,
    model: input.model,
  };

  function scheduleTimer(): void {
    if (released) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void runDrain();
    }, idleDelayMs);
    // 不阻止进程退出：调度器只是触发器，durable job 重启后仍会被补扫。
    timer.unref?.();
  }

  async function drainQueuedJobsOnce(): Promise<void> {
    let jobs: readonly MemoryJobRow[];
    try {
      jobs = await input.controlRepository.listJobsByStatus("queued");
    } catch (error) {
      onDiagnostic("Memory consolidation drain could not list queued jobs", error);
      return;
    }
    for (const job of jobs) {
      if (released) return;
      try {
        await consolidateJob(consolidationDeps, job.jobId);
      } catch (error) {
        // consolidateJob 内部已收敛 job 状态；这里只兜底诊断，绝不上抛主链路。
        onDiagnostic(`Memory consolidation job ${job.jobId} failed`, error);
      }
    }
  }

  function runDrain(): Promise<void> {
    if (drainPromise !== undefined) {
      drainRequestedAgain = true;
      return drainPromise;
    }
    drainPromise = (async () => {
      try {
        do {
          drainRequestedAgain = false;
          await drainQueuedJobsOnce();
        } while (drainRequestedAgain && !released);
      } finally {
        drainPromise = undefined;
      }
    })();
    return drainPromise;
  }

  return {
    noteActivity({ conversationId }) {
      // v1 只用全局单一 idle timer：活动只负责重置计时（手册 9.2）；
      // conversationId 保留在合同上，供后续按会话精细调度时使用。
      void conversationId;
      if (released) return;
      scheduleTimer();
    },

    async recoverQueuedJobs() {
      await runDrain();
    },

    async release() {
      released = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await (drainPromise ?? Promise.resolve());
    },
  };
}
