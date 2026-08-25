import type { OrdinaryExecutionContinuation } from "../contracts.js";

export type OrdinaryExecutionCoordinator = ReturnType<typeof createOrdinaryExecutionCoordinator>;

export type OrdinaryApprovalDecisionLease = {
  readonly runId: string;
  readonly confirmationId: string;
  readonly continuation: OrdinaryExecutionContinuation;
  readonly controller: AbortController;
  readonly createdController: boolean;
};

export function createOrdinaryExecutionCoordinator() {
  const controllers = new Map<string, AbortController>();
  const executions = new Map<string, Promise<void>>();
  const continuations = new Map<string, OrdinaryExecutionContinuation>();
  const approvalReservations = new Map<string, string>();
  const cancellationCleanupTasks = new Map<string, Promise<void>>();
  const cancellationCleanupContinuations = new Map<string, OrdinaryExecutionContinuation>();
  const postExecutionTasks = new Set<Promise<void>>();

  function controller(runId: string): AbortController | undefined {
    return controllers.get(runId);
  }

  function removeController(runId: string, expected?: AbortController): void {
    if (expected === undefined || controllers.get(runId) === expected) controllers.delete(runId);
  }

  function takeContinuation(runId: string): OrdinaryExecutionContinuation | undefined {
    const continuation = continuations.get(runId);
    continuations.delete(runId);
    return continuation;
  }

  function startExecutionTask(runId: string, operation: Promise<void>): void {
    executions.set(runId, operation);
    const cleanup = () => {
      if (executions.get(runId) === operation) executions.delete(runId);
    };
    void operation.then(cleanup, cleanup);
  }

  function trackPostExecutionTask(task: Promise<void>): void {
    postExecutionTasks.add(task);
    void task.then(
      () => { postExecutionTasks.delete(task); },
      () => { postExecutionTasks.delete(task); },
    );
  }

  function beginApprovalDecision(
    runId: string,
    confirmationId: string,
  ): { readonly status: "busy" } | { readonly status: "continuation_missing" } | {
    readonly status: "acquired";
    readonly lease: OrdinaryApprovalDecisionLease;
  } {
    if (approvalReservations.has(runId)) return { status: "busy" };
    const continuation = continuations.get(runId);
    if (continuation === undefined) return { status: "continuation_missing" };
    let controller = controllers.get(runId);
    const createdController = controller === undefined;
    if (controller === undefined) {
      controller = new AbortController();
      controllers.set(runId, controller);
    }
    approvalReservations.set(runId, confirmationId);
    continuations.delete(runId);
    return {
      status: "acquired",
      lease: { runId, confirmationId, continuation, controller, createdController },
    };
  }

  function rollbackApprovalDecision(lease: OrdinaryApprovalDecisionLease): void {
    if (approvalReservations.get(lease.runId) === lease.confirmationId) {
      approvalReservations.delete(lease.runId);
    }
    if (lease.createdController && controllers.get(lease.runId) === lease.controller) {
      controllers.delete(lease.runId);
    }
    continuations.set(lease.runId, lease.continuation);
  }

  function finishApprovalDecision(lease: OrdinaryApprovalDecisionLease, keepController: boolean): void {
    if (!keepController && controllers.get(lease.runId) === lease.controller) {
      controllers.delete(lease.runId);
    }
    if (approvalReservations.get(lease.runId) === lease.confirmationId) {
      approvalReservations.delete(lease.runId);
    }
  }

  async function releaseContinuations(): Promise<void> {
    const failures: unknown[] = [];
    for (const [runId, continuation] of continuations) {
      try {
        await continuation.release();
        if (continuations.get(runId) === continuation) continuations.delete(runId);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const [runId, continuation] of cancellationCleanupContinuations) {
      try {
        await continuation.release();
        if (cancellationCleanupContinuations.get(runId) === continuation) {
          cancellationCleanupContinuations.delete(runId);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to release one or more Ordinary live continuations.");
    }
  }

  return {
    controller,
    hasController: (runId: string) => controllers.has(runId),
    beginExecution(runId: string) {
      if (controllers.has(runId) || executions.has(runId)) {
        throw new Error(`Ordinary run ${runId} already has an active execution.`);
      }
      const controller = new AbortController();
      controllers.set(runId, controller);
      return controller;
    },
    abortController(runId: string, reason: string) { controllers.get(runId)?.abort(reason); },
    removeController,
    releaseControllerIfIdle(runId: string) {
      if (!executions.has(runId) && !approvalReservations.has(runId) && !continuations.has(runId)) {
        controllers.delete(runId);
      }
    },
    hasLiveExecution(runId: string) {
      return executions.has(runId) || approvalReservations.has(runId) || controllers.has(runId);
    },
    hasContinuation: (runId: string) => continuations.has(runId),
    registerApprovalContinuation(runId: string, value: OrdinaryExecutionContinuation) {
      if (continuations.has(runId)) return false;
      continuations.set(runId, value);
      return true;
    },
    takeContinuation,
    beginApprovalDecision,
    rollbackApprovalDecision,
    finishApprovalDecision,
    hasExecution: (runId: string) => executions.has(runId),
    startExecutionTask,
    trackPostExecutionTask,
    retainCancellationContinuation(runId: string, continuation: OrdinaryExecutionContinuation | undefined) {
      if (continuation !== undefined) cancellationCleanupContinuations.set(runId, continuation);
    },
    async releaseCancellationContinuation(runId: string) {
      const continuation = cancellationCleanupContinuations.get(runId);
      if (continuation === undefined) return;
      await continuation.release();
      if (cancellationCleanupContinuations.get(runId) === continuation) {
        cancellationCleanupContinuations.delete(runId);
      }
    },
    hasCancellationCleanup: (runId: string) => cancellationCleanupTasks.has(runId),
    startCancellationCleanup(
      runId: string,
      continuation: OrdinaryExecutionContinuation | undefined,
      createTask: () => Promise<void>,
    ) {
      if (continuation !== undefined) cancellationCleanupContinuations.set(runId, continuation);
      if (cancellationCleanupTasks.has(runId)) return false;
      const task = createTask();
      cancellationCleanupTasks.set(runId, task);
      trackPostExecutionTask(task);
      const cleanup = () => {
        if (cancellationCleanupTasks.get(runId) === task) cancellationCleanupTasks.delete(runId);
      };
      void task.then(cleanup, cleanup);
      return true;
    },
    async waitForRunExecution(runId: string) {
      await executions.get(runId)?.catch(() => undefined);
    },
    async waitForCancellationCleanup(runId: string) {
      await cancellationCleanupTasks.get(runId)?.catch(() => undefined);
    },
    externalSettlementCleared(runId: string) {
      return !approvalReservations.has(runId) &&
        !continuations.has(runId) &&
        !cancellationCleanupContinuations.has(runId) &&
        !controllers.has(runId) &&
        !executions.has(runId);
    },
    schedulingFacts(runId: string) {
      return {
        unsettledToolWork: approvalReservations.has(runId) ||
          continuations.has(runId) ||
          cancellationCleanupContinuations.has(runId),
        cancellationCleanupPending: cancellationCleanupTasks.has(runId),
        executionActive: controllers.has(runId) || executions.has(runId),
      };
    },
    prepareRelease(reason: string) {
      for (const value of controllers.values()) value.abort(reason);
    },
    releaseContinuations,
    async awaitExecutionTasks() { await Promise.allSettled(executions.values()); },
    async awaitCancellationTasks() { await Promise.allSettled(cancellationCleanupTasks.values()); },
    async awaitPostExecutionTasks() { await Promise.allSettled(postExecutionTasks); },
    clear() {
      controllers.clear();
      executions.clear();
      approvalReservations.clear();
      cancellationCleanupTasks.clear();
      cancellationCleanupContinuations.clear();
      postExecutionTasks.clear();
    },
  };
}
