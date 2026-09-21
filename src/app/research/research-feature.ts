import { randomUUID } from "node:crypto";

import {
  ResearchError,
  type ResearchEvent,
  type ResearchFeature,
  type ResearchPlan,
  type ResearchRepository,
  type ResearchStage,
  type ResearchTask,
  type ResearchUsage,
} from "./contracts.js";

/** 新建任务的初始用量：审计字段从零开始，随实际发生的调用累加。 */
function emptyUsage(): ResearchUsage {
  return {
    searchRequests: 0,
    fetchRequests: 0,
    modelRequests: 0,
    inputTokens: null,
    outputTokens: null,
    elapsedMs: 0,
  };
}

/**
 * 深度研究 Feature：研究任务、来源、检索记录与报告的长期事实 owner。
 *
 * 与其他 Feature 相同的纪律：
 * - 所有命令经同一串行队列执行，Feature 内的 read-modify-write 只有一个入口；
 * - released 后拒绝新命令；
 * - 事件发布不与已提交结果互相影响（observer 抛错不改变命令结果）；
 * - 这里不做编排：轮数、模型调用与降级都由 Application 决定，本层只保存事实。
 */
export function createResearchFeature(options: {
  readonly repository: ResearchRepository;
  readonly now?: () => number;
  readonly idFactory?: (prefix: string) => string;
}): ResearchFeature {
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  let released = false;
  let queue = Promise.resolve();
  const listeners = new Set<(event: ResearchEvent) => void>();

  const ensureActive = (): void => {
    if (released) throw new ResearchError("research_released", "Research feature is released.");
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    ensureActive();
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return await result;
  };
  const publish = (taskId: string, status: ResearchTask["status"]): void => {
    const event: ResearchEvent = { type: "research.task_changed", taskId, status };
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* Observers cannot change the committed research command result. */ }
    }
  };

  return {
    commands: {
      async createTask(input): Promise<ResearchTask> {
        return await run(async () => {
          const question = input.question.trim();
          if (question.length === 0) {
            throw new ResearchError("research_invalid_input", "研究问题不能为空。");
          }
          const task: ResearchTask = {
            id: idFactory("research"),
            question,
            status: "queued",
            stage: null,
            plan: null,
            coverage: [],
            reportTitle: null,
            reportMarkdown: null,
            errorCode: null,
            errorMessage: null,
            usage: emptyUsage(),
            createdAt: now(),
            startedAt: null,
            endedAt: null,
          };
          await options.repository.insertTask(task);
          publish(task.id, task.status);
          return task;
        });
      },

      async claimNextQueued(input): Promise<ResearchTask | undefined> {
        return await run(async () => {
          const task = await options.repository.claimNextQueued({ startedAt: input?.startedAt ?? now() });
          if (task !== undefined) publish(task.id, task.status);
          return task;
        });
      },

      async updateProgress(input: {
        readonly id: string;
        readonly stage: ResearchStage;
        readonly usage: ResearchUsage;
      }): Promise<void> {
        await run(async () => {
          await options.repository.updateProgress(input);
          publish(input.id, "running");
        });
      },

      async savePlan(input: { readonly id: string; readonly plan: ResearchPlan }): Promise<void> {
        await run(async () => {
          await options.repository.savePlan(input);
          publish(input.id, "running");
        });
      },

      async saveCoverage(input): Promise<void> {
        await run(async () => {
          await options.repository.saveCoverage(input);
          publish(input.id, "running");
        });
      },

      async appendSources(input) {
        return await run(async () => {
          const accepted = await options.repository.appendSources({
            taskId: input.taskId,
            drafts: input.drafts,
            limit: input.limit,
            retrievedAt: now(),
          });
          if (accepted.length > 0) publish(input.taskId, "running");
          return accepted;
        });
      },

      async markSourceContent(input): Promise<void> {
        await run(async () => {
          await options.repository.markSourceContent(input);
          publish(input.taskId, "running");
        });
      },

      async appendQueries(input): Promise<void> {
        await run(async () => {
          await options.repository.appendQueries(input);
          publish(input.taskId, "running");
        });
      },

      async finishTask(input) {
        return await run(async () => {
          const finished = await options.repository.finishTask({ ...input, endedAt: now() });
          if (finished !== undefined) publish(finished.id, finished.status);
          return finished;
        });
      },
    },

    queries: {
      async summaryList(input) {
        return await options.repository.listTasks({ limit: Math.min(Math.max(input?.limit ?? 30, 1), 100) });
      },
      async detail(id: string) {
        const task = await options.repository.readTask(id);
        if (task === undefined) return undefined;
        const [sources, queries] = await Promise.all([
          options.repository.listSources(id),
          options.repository.listQueries(id),
        ]);
        return { task, sources, queries };
      },
      async isCancelRequested(id: string): Promise<boolean> {
        return await options.repository.isCancelRequested(id);
      },
      async hasQueuedTasks(): Promise<boolean> {
        return await options.repository.hasQueuedTasks();
      },
    },

    async cancel(id: string) {
      await run(async () => {
        await options.repository.requestCancel(id);
        publish(id, "running");
      });
    },

    events: {
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },

    async ready(): Promise<number> {
      return await run(async () => {
        const recovered = await options.repository.recoverInterrupted({ endedAt: now() });
        return recovered;
      });
    },

    async release(): Promise<void> {
      released = true;
      listeners.clear();
      await queue;
    },
  };
}
