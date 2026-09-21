import type { ResearchFeature } from "../../research/index.js";
import type { ResearchApplication } from "../../application/research-application.js";

/**
 * 深度研究执行 worker（Host 拥有）。
 *
 * 与记忆维护调度器同一纪律：durable 队列（research_task 的 status）是唯一事实源，
 * 进程内唤醒只是触发器。
 * - 单并发：同时最多一项研究在跑；认领是 CAS，队列顺序即执行顺序；
 * - 每次唤醒现读队列，没有待处理任务就停下，由下一次入队事件重新唤醒；
 * - 取消：用户请求取消后中止在途执行（AbortController），编排在最接近的步骤边界收敛；
 * - 启动恢复：running 残留标记 interrupted，绝不自动重放；
 * - release 后停止触发，在途执行收尾。
 */

export type ResearchWorker = {
  /** 新任务入队信号：唤醒一次 drain。 */
  noteQueued(): void;
  /** 启动恢复：running 残留回 interrupted，然后消化队列。 */
  ready(): Promise<void>;
  /** 停止触发并等待在途执行收尾（进程关闭 / restore 前调用）。 */
  release(): Promise<void>;
};

export function createResearchWorker(input: {
  readonly feature: Pick<ResearchFeature, "commands" | "queries" | "events" | "ready">;
  readonly application: ResearchApplication;
  readonly now?: () => number;
  readonly onDiagnostic?: (topic: string, error: unknown) => void;
}): ResearchWorker {
  const now = input.now ?? Date.now;
  const onDiagnostic = input.onDiagnostic ?? ((topic, error) => console.error(`[research] ${topic}`, error));
  let released = false;
  let drainPromise: Promise<void> | undefined;
  let drainRequestedAgain = false;
  const active = new Map<string, AbortController>();
  const cancelWatchers = new Map<string, ReturnType<typeof setInterval>>();

  /** 取消标记轮询：编排在步骤边界读取同一标记，这里只负责尽快中止在途调用。 */
  function watchCancellation(taskId: string, controller: AbortController): void {
    if (cancelWatchers.has(taskId)) return;
    const timer = setInterval(() => {
      void input.feature.queries.isCancelRequested(taskId).then((requested) => {
        if (requested) controller.abort();
      }).catch(() => undefined);
    }, 1_000);
    timer.unref?.();
    cancelWatchers.set(taskId, timer);
  }

  function stopWatching(taskId: string): void {
    const watcher = cancelWatchers.get(taskId);
    if (watcher !== undefined) {
      clearInterval(watcher);
      cancelWatchers.delete(taskId);
    }
  }

  /** 依次消化队列：每轮重新认领，直到没有待处理任务或进程开始释放。 */
  async function drainOnce(): Promise<void> {
    while (!released) {
      const claimed = await input.feature.commands.claimNextQueued({ startedAt: now() });
      if (claimed === undefined) return;
      const controller = new AbortController();
      active.set(claimed.id, controller);
      watchCancellation(claimed.id, controller);
      try {
        await input.application.execute(claimed.id, controller.signal);
      } catch (error) {
        // execute 自身收敛终态；这里只记录未预期的失败，绝不让 worker 崩掉。
        onDiagnostic(`research task ${claimed.id} execution failed`, error);
      } finally {
        active.delete(claimed.id);
        stopWatching(claimed.id);
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
          await drainOnce();
        } while (drainRequestedAgain && !released);
      } finally {
        drainPromise = undefined;
      }
    })();
    return drainPromise;
  }

  const unsubscribe = input.feature.events.subscribe((event) => {
    if (released || event.status !== "queued") return;
    void runDrain().catch((error) => onDiagnostic("research drain failed", error));
  });

  return {
    noteQueued() {
      if (released) return;
      void runDrain().catch((error) => onDiagnostic("research drain failed", error));
    },

    async ready() {
      try {
        const recovered = await input.feature.ready();
        if (recovered > 0) {
          console.log(`[research] 启动收敛：${recovered} 个未完成任务标记为 interrupted。`);
        }
      } catch (error) {
        onDiagnostic("research startup recovery failed", error);
        return;
      }
      await runDrain();
    },

    async release() {
      released = true;
      unsubscribe();
      for (const taskId of [...cancelWatchers.keys()]) stopWatching(taskId);
      for (const controller of active.values()) controller.abort();
      await (drainPromise ?? Promise.resolve());
    },
  };
}
