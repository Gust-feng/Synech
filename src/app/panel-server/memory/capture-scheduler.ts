import type { OrdinaryEvidenceReader } from "../../memory/contracts.js";
import {
  maintainConversationJob,
  type MaintenanceDeps,
  type MaintenanceJobOutcome,
} from "../../memory/capture/consolidation.js";
import type { MemoryMaintenanceModelPort } from "../../memory/contracts.js";
import type { MemoryDocumentRepository } from "../../memory/store/content-repository.js";
import type { MemoryControlRepository } from "../../memory/store/control-repository.js";
import type { MemoryJobRow } from "../../memory/store/persistence-schema.js";
import { MAINTENANCE_IDLE_DELAY_MS } from "../../memory/capture/capture-runtime.js";

/**
 * Memory 维护调度器（0.6.0 正式设计 §7）：每会话空闲资格 + 全局单 worker。
 *
 * durable 化调度：进程内 timer 只是唤醒器，待处理边界的唯一事实源是 SQLite 里的
 * memory_job（信号接单落盘：requestedThrough / eligibleAt）。每次唤醒经
 * `listDueJobs`（eligible_at/next_attempt_at 过滤，按 ready_queued_at 排序）现读
 * 现处理；恢复活动的会话在领取前由宿主注入的活动端口延后，worker 跳过继续其他
 * 任务，不在队首等待。
 *
 * 纪律：
 * - 全局同时至多一个 Memory 模型请求在途（drain 串行 + claimJob CAS 兜底）；
 * - 一个长会话每 claim 只处理一批，剩余范围由提交事务重排到就绪队列尾
 *   （不重新等 270 秒，也不持续占据队首）；
 * - 失败只走诊断与 onOutcome，绝不向主链路（stable-run 订阅）抛出；
 * - release 后停止触发，在途 drain 自然收尾。
 */

export type MemoryMaintenanceScheduler = {
  /** 活动信号（稳定 Run 终结）：按空闲时长安排下一次唤醒；不抛出、不阻塞。 */
  noteActivity(input: { readonly conversationId: string }): void;
  /** 启动恢复：running 残留回队列后立即消化当前到期任务。 */
  recoverQueuedJobs(): Promise<void>;
  /** 停止触发并等待在途 drain 收尾（进程关闭 / restore 前调用）。 */
  release(): Promise<void>;
};

export function createMemoryMaintenanceScheduler(input: {
  readonly controlRepository: MemoryControlRepository;
  readonly documentRepository: MemoryDocumentRepository;
  readonly evidenceReader: OrdinaryEvidenceReader;
  readonly model: MemoryMaintenanceModelPort;
  /** 宿主注入的会话活动端口：true 表示该会话当前有运行/审批在途，延后整理。 */
  readonly isConversationActive?: (conversationId: string) => Promise<boolean>;
  readonly idleDelayMs?: number;
  readonly now?: () => number;
  readonly onDiagnostic?: (topic: string, error: unknown) => void;
  readonly onOutcome?: (outcome: MaintenanceJobOutcome) => void;
}): MemoryMaintenanceScheduler {
  const idleDelayMs = input.idleDelayMs ?? MAINTENANCE_IDLE_DELAY_MS;
  const now = input.now ?? Date.now;
  const onDiagnostic = input.onDiagnostic ?? ((topic, error) => console.error(`[panel-server] ${topic}`, error));
  const isConversationActive = input.isConversationActive ?? (async () => false);

  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let drainPromise: Promise<void> | undefined;
  let drainRequestedAgain = false;

  const maintenanceDeps: MaintenanceDeps = {
    controlRepository: input.controlRepository,
    documentRepository: input.documentRepository,
    evidenceReader: input.evidenceReader,
    model: input.model,
    now,
  };

  function scheduleWake(delayMs: number): void {
    if (released) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void runDrain();
    }, Math.max(delayMs, 250));
    // 不阻止进程退出：调度器只是唤醒器，durable job 重启后仍会被补扫。
    timer.unref?.();
  }

  /** drain 收尾后按最近的到期任务安排下一次唤醒；无到期任务时低频兜底轮询。 */
  async function scheduleNextWakeFromJobs(): Promise<void> {
    try {
      const queued = await input.controlRepository.listJobsByStatus("queued");
      const nowMs = now();
      const nextDue = queued
        .map((job) => Math.max(job.eligibleAt, job.nextAttemptAt ?? 0))
        .filter((due) => due > nowMs)
        .sort((left, right) => left - right)[0];
      if (nextDue !== undefined) {
        scheduleWake(nextDue - nowMs);
        return;
      }
    } catch (error) {
      onDiagnostic("Memory scheduler could not schedule next wake", error);
    }
    // 没有未来到期任务时不再轮询：下一次活动信号会重新安排唤醒。
  }

  async function drainDueJobsOnce(): Promise<void> {
    let jobs: readonly MemoryJobRow[];
    try {
      jobs = await input.controlRepository.listDueJobs({ now: now(), limit: 16 });
    } catch (error) {
      onDiagnostic("Memory maintenance drain could not list due jobs", error);
      return;
    }
    for (const job of jobs) {
      if (released) return;
      if (await isConversationActive(job.conversationId)) {
        // 恢复活动的会话延后：worker 继续其他任务，不在队首等待
        // （其下一次稳定终结会重算 eligibleAt）。
        continue;
      }
      try {
        const outcome = await maintainConversationJob(maintenanceDeps, job.jobId);
        input.onOutcome?.(outcome);
      } catch (error) {
        onDiagnostic(`Memory maintenance job ${job.jobId} failed`, error);
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
          await drainDueJobsOnce();
          await scheduleNextWakeFromJobs();
        } while (drainRequestedAgain && !released);
      } finally {
        drainPromise = undefined;
      }
    })();
    return drainPromise;
  }

  return {
    noteActivity({ conversationId }) {
      void conversationId;
      if (released) return;
      scheduleWake(idleDelayMs);
    },

    async recoverQueuedJobs() {
      try {
        await input.controlRepository.recoverInterruptedJobs();
      } catch (error) {
        onDiagnostic("Memory maintenance recovery failed", error);
        return;
      }
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
