import { randomUUID } from "node:crypto";

import {
  ResearchError,
  assertConflictSidesBalanced,
  assertQuestionOrigin,
  type ResearchConflictDraft,
  type ResearchEvent,
  type ResearchFeature,
  type ResearchLedger,
  type ResearchObservationResult,
  type ResearchQuestionNode,
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
 *
 * 账本段的结构校验在串行队列内完成（无交错，读到的即当前状态）：
 * - Conflict 双边各 ≥2 个不同来源的 Evidence，单边一律拒绝；
 * - 新增 Question 必须携带 origin；
 * - ID 由框架分配、不回收（草稿不携带 ID，strict 校验在 repository 边界复验）。
 * 规则实现只有一份（contracts.ts 的 assert*）：这里预检，repository 事务内复验。
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

  /**
   * Conflict 双边预检：串行队列内读当前证据，按同一规则函数校验。
   * repository 在事务内用同一函数复验（port 边界的最后防线）。
   */
  const assertConflictsTwoSided = async (
    taskId: string,
    conflicts: readonly ResearchConflictDraft[],
  ): Promise<void> => {
    if (conflicts.length === 0) return;
    const evidence = await options.repository.listEvidenceItems(taskId);
    const evidenceSourceIds = new Map(evidence.map((item) => [item.id, item.sourceId]));
    for (const conflict of conflicts) {
      assertConflictSidesBalanced({
        evidenceAIds: conflict.evidenceAIds,
        evidenceBIds: conflict.evidenceBIds,
        evidenceSourceIds,
      });
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
            // 账本结构字段：范围批准与 brief 落账前均为 null；终态事实由 finishTask 写。
            completion: null,
            reason: null,
            ceilingHit: null,
            scopeApproval: null,
            briefId: null,
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
        readonly stage?: ResearchStage;
        readonly usage: ResearchUsage;
      }): Promise<void> {
        await run(async () => {
          await options.repository.updateProgress(input);
          publish(input.id, "running");
        });
      },

      async finishTask(input) {
        return await run(async () => {
          const finished = await options.repository.finishTask({ ...input, endedAt: now() });
          if (finished !== undefined) publish(finished.id, finished.status);
          return finished;
        });
      },

      // ---- 账本段命令 ----
      // 这些命令不发布 research.task_changed：它们不改队列状态（queued/running 转换
      // 才是 worker 的唤醒信号），账本的界面投影随研究 read-model 一起到位。

      async approveScope(input) {
        return await run(async () =>
          await options.repository.approveScope({
            taskId: input.taskId,
            approval: input.approval,
            brief: input.brief,
          }));
      },

      async appendQuestions(input): Promise<readonly ResearchQuestionNode[]> {
        return await run(async () => {
          // 结构预检：每个新问题必须携带 origin（形状规则，无需读库）。
          for (const question of input.questions) assertQuestionOrigin(question.origin);
          return await options.repository.appendQuestions({
            taskId: input.taskId,
            questions: input.questions,
            ...(input.edges === undefined ? {} : { edges: input.edges }),
          });
        });
      },

      async appendSourceEntries(input) {
        return await run(async () =>
          await options.repository.appendSourceEntries({
            taskId: input.taskId,
            drafts: input.drafts,
          }));
      },

      async markSourceAccess(input): Promise<void> {
        await run(async () => {
          await options.repository.markSourceAccess(input);
        });
      },

      async markSourceProvenance(input): Promise<void> {
        await run(async () => {
          await options.repository.markSourceProvenance(input);
        });
      },

      async appendEvidenceItems(input) {
        return await run(async () =>
          await options.repository.appendEvidenceItems({
            taskId: input.taskId,
            items: input.items,
          }));
      },

      async appendClaims(input) {
        return await run(async () =>
          await options.repository.appendClaims({
            taskId: input.taskId,
            claims: input.claims,
          }));
      },

      async appendGaps(input) {
        return await run(async () =>
          await options.repository.appendGaps({
            taskId: input.taskId,
            gaps: input.gaps,
          }));
      },

      async createConflict(input) {
        return await run(async () => {
          // 结构预检：双边各 ≥2 个不同来源的 Evidence（串行队列内读当前证据）。
          await assertConflictsTwoSided(input.taskId, [input.conflict]);
          return await options.repository.createConflict({
            taskId: input.taskId,
            conflict: input.conflict,
          });
        });
      },

      async appendCitationChecks(input) {
        return await run(async () =>
          await options.repository.appendCitationChecks({
            taskId: input.taskId,
            checks: input.checks,
          }));
      },

      async appendActionEvents(input) {
        return await run(async () =>
          await options.repository.appendActionEvents({
            taskId: input.taskId,
            events: input.events,
          }));
      },

      async applyObservations(input): Promise<ResearchObservationResult> {
        return await run(async () => {
          // 结构预检：新问题 origin 必填；新冲突双边各 ≥2 个不同来源的 Evidence。
          for (const question of input.batch.newQuestions ?? []) {
            assertQuestionOrigin(question.origin);
          }
          await assertConflictsTwoSided(input.taskId, input.batch.newConflicts ?? []);
          return await options.repository.applyObservations({
            taskId: input.taskId,
            batch: input.batch,
          });
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
      async ledger(taskId: string): Promise<ResearchLedger | undefined> {
        return await options.repository.readLedger(taskId);
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
