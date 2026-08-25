import type { ModelMessage, ModelUsage } from "../../domain/intelligence/index.js";
import type { RunCapabilityResolution } from "../../domain/config/index.js";
import { executionErrorFacts } from "../execution-errors/index.js";
import type {
  AgentSessionEntryRef,
  AgentLoop,
  AgentLoopAgentTool,
  AgentLoopResult,
  AgentLoopToolBoundary,
  AgentLoopToolVisibilityPlan,
} from "../model-runtime/index.js";
import type {
  OrdinaryExecutionContinuation,
  OrdinaryExecutionInput,
  OrdinaryExecutionOutcome,
  OrdinaryExecutionPort,
} from "./contracts.js";

export type AcquireOrdinaryAgentLoopRunResourcesInput = OrdinaryExecutionInput;

export type OrdinaryAgentLoopRunResources = {
  readonly loop: AgentLoop;
  /** Canonical messages with any request-scoped attachments resolved again. */
  readonly resolvedMessages: readonly ModelMessage[];
  readonly tools: AgentLoopToolBoundary;
  readonly agentTools?: readonly AgentLoopAgentTool[];
  readonly toolVisibilityPlan?: AgentLoopToolVisibilityPlan;
  readonly capabilityResolution?: RunCapabilityResolution;
  readonly toolMetrics?: import("./tool-runtime-metrics.js").OrdinaryToolMetricsCollector;
  /** Revokes this run's Session writer to its last feature-accepted protocol boundary. */
  readonly revokeSessionTo?: (target: AgentSessionEntryRef | null) => Promise<void>;
  /** Releases only the Session writer after Ordinary has committed terminal state. */
  readonly releaseSession?: () => Promise<void>;
  /** Releases every run-scoped resource created by the acquirer, including the loop. */
  release(): Promise<void>;
};

export interface OrdinaryAgentLoopRunResourceAcquirer {
  acquire(input: AcquireOrdinaryAgentLoopRunResourcesInput): Promise<OrdinaryAgentLoopRunResources>;
}

/**
 * Adapts the neutral model-tool loop to Ordinary's feature-owned execution outcomes.
 * Agent Session continuations remain live-only inside this lease and never enter durable state.
 */
export function createOrdinaryAgentLoopExecutionPort(input: {
  readonly resources: OrdinaryAgentLoopRunResourceAcquirer;
  readonly onReleaseError?: (error: unknown) => void;
}): OrdinaryExecutionPort {
  const sessionControls = new Map<string, ActiveSessionControl>();
  return {
    async execute(executionInput) {
      if (sessionControls.has(executionInput.runId)) {
        throw new Error(`Ordinary run ${executionInput.runId} already has an active execution control.`);
      }
      const sessionControl = createActiveSessionControl();
      sessionControls.set(executionInput.runId, sessionControl);
      let resources: OrdinaryAgentLoopRunResources;
      try {
        resources = await input.resources.acquire(executionInput);
      } catch (error) {
        sessionControl.finish();
        if (sessionControls.get(executionInput.runId) === sessionControl) {
          sessionControls.delete(executionInput.runId);
        }
        if (executionInput.abortSignal.aborted) {
          return {
            status: "cancelled",
            reason: cancellationReason(executionInput.abortSignal.reason),
            toolCalls: [],
            usage: {},
          };
        }
        const facts = executionErrorFacts(error);
        if (facts !== undefined) {
          return {
            status: "failed",
            error: facts,
            toolCalls: [],
            usage: {},
          };
        }
        throw error;
      }
      const lease = createResourceLease(resources);
      sessionControl.attach(resources, lease);
      try {
        const result = await resources.loop.execute({
          instructions: executionInput.birth.instructions,
          messages: resources.resolvedMessages,
          tools: resources.tools,
          ...(resources.agentTools === undefined ? {} : { agentTools: resources.agentTools }),
          ...(resources.toolVisibilityPlan === undefined
            ? {}
            : { toolVisibilityPlan: resources.toolVisibilityPlan }),
          abortSignal: executionInput.abortSignal,
          onModelContent: executionInput.onModelContent,
          acceptToolInvocations: executionInput.acceptToolInvocations,
          acceptNestedToolInvocations: executionInput.acceptNestedToolInvocations,
          onToolRequested: executionInput.onToolRequested,
          onNestedToolRequestsAccepted: executionInput.onNestedToolRequestsAccepted,
          onToolProgress: executionInput.onToolProgress,
          onSessionWriteCheckpoint: executionInput.onSessionWriteCheckpoint,
          onToolResult: executionInput.onToolResult,
        });
        return await mapAgentLoopResult(
          result,
          lease,
          input.onReleaseError,
          {},
          resources.capabilityResolution,
          resources.toolMetrics,
        );
      } catch (error) {
        await releaseWithoutReplacingOutcome(lease, input.onReleaseError);
        throw error;
      }
    },
    async finalizeSession(runId, target) {
      const control = sessionControls.get(runId);
      if (control === undefined) {
        return { status: "no_session" };
      }
      await control.finalize(target);
      if (sessionControls.get(runId) === control) sessionControls.delete(runId);
      return { status: "finalized" };
    },
  };
}

function cancellationReason(value: unknown): string {
  return typeof value === "string" ? value : "cancelled";
}

type ResourceLease = {
  release(): Promise<void>;
};

function createResourceLease(
  resources: OrdinaryAgentLoopRunResources,
): ResourceLease {
  let releasePromise: Promise<void> | undefined;
  let released = false;
  return {
    release() {
      if (released) return Promise.resolve();
      releasePromise ??= Promise.resolve()
        .then(() => resources.release())
        .then(
          () => { released = true; },
          (error: unknown) => {
            releasePromise = undefined;
            throw error;
          },
        );
      return releasePromise;
    },
  };
}

async function mapAgentLoopResult(
  result: AgentLoopResult,
  lease: ResourceLease,
  onReleaseError?: (error: unknown) => void,
  previousUsage: ModelUsage = {},
  capabilityResolution?: RunCapabilityResolution,
  toolMetrics?: import("./tool-runtime-metrics.js").OrdinaryToolMetricsCollector,
): Promise<OrdinaryExecutionOutcome> {
  const usage = latestCumulativeUsage(previousUsage, result.usage);
  const facts = {
    ...(result.session === undefined ? {} : { session: result.session }),
    toolCalls: result.toolResults,
    usage,
    ...(toolMetrics === undefined ? {} : { toolMetrics: toolMetrics.snapshot() }),
    ...(capabilityResolution === undefined ? {} : { capabilityResolution }),
  } as const;

  if (result.status === "approval_required") {
    return {
      ...facts,
      status: "approval_required",
      confirmationRequests: result.confirmationRequests,
      continuation: mapContinuation(result.continuation, lease, onReleaseError, usage, capabilityResolution, toolMetrics),
    };
  }

  await releaseWithoutReplacingOutcome(lease, onReleaseError);
  if (result.status === "completed") {
    if (result.session === undefined) {
      throw new Error("A completed Agent session loop must return durable session refs.");
    }
    return { ...facts, session: result.session, status: "completed", answer: result.finalText };
  }
  if (result.status === "cancelled") {
    return { ...facts, status: "cancelled", reason: result.error ?? "cancelled" };
  }
  return {
    ...facts,
    status: "failed",
    error: { code: result.errorCode ?? "agent_loop_failed", message: result.error },
  };
}

function mapContinuation(
  continuation: Extract<AgentLoopResult, { readonly status: "approval_required" }>["continuation"],
  lease: ResourceLease,
  onReleaseError?: (error: unknown) => void,
  previousUsage: ModelUsage = {},
  capabilityResolution?: RunCapabilityResolution,
  toolMetrics?: import("./tool-runtime-metrics.js").OrdinaryToolMetricsCollector,
): OrdinaryExecutionContinuation {
  let consumed = false;
  return {
    availability: "live_only",
    async decide(input) {
      if (consumed) throw new Error("Ordinary approval continuation has already been decided");
      consumed = true;
      try {
        return await mapAgentLoopResult(
          await continuation.decide(input),
          lease,
          onReleaseError,
          previousUsage,
          capabilityResolution,
          toolMetrics,
        );
      } catch (error) {
        await releaseWithoutReplacingOutcome(lease, onReleaseError);
        throw error;
      }
    },
    async release() {
      consumed = true;
      try {
        await lease.release();
      } catch (error) {
        reportReleaseError(error, onReleaseError);
        throw error;
      }
    },
  };
}

/** AgentLoop usage is cumulative; missing fields on a later failure must not erase prior observed totals. */
function latestCumulativeUsage(previous: ModelUsage, current: ModelUsage): ModelUsage {
  return { ...previous, ...current };
}

async function releaseWithoutReplacingOutcome(
  lease: ResourceLease,
  onReleaseError?: (error: unknown) => void,
): Promise<void> {
  try {
    await lease.release();
  } catch (error) {
    reportReleaseError(error, onReleaseError);
  }
}

function reportReleaseError(error: unknown, onReleaseError?: (error: unknown) => void): void {
  try {
    onReleaseError?.(error);
  } catch {
    // Diagnostics cannot replace the already-known model/tool outcome.
  }
}

type ActiveSessionControl = {
  attach(resources: OrdinaryAgentLoopRunResources, lease: ResourceLease): void;
  finalize(target?: AgentSessionEntryRef | null): Promise<void>;
  finish(): void;
};

function createActiveSessionControl(): ActiveSessionControl {
  let resources: OrdinaryAgentLoopRunResources | undefined;
  let resourceLease: ResourceLease | undefined;
  let requested = false;
  let targetLeaf: AgentSessionEntryRef | null = null;
  let finished = false;
  let revokePromise: Promise<void> | undefined;
  let pending: ReturnType<typeof deferred<void>> | undefined;

  const startRevoke = (): Promise<void> => {
    if (!requested || finished) return Promise.resolve();
    if (resources?.revokeSessionTo === undefined) return Promise.resolve();
    revokePromise ??= resources.revokeSessionTo(targetLeaf).catch((error: unknown) => {
      revokePromise = undefined;
      throw error;
    });
    return revokePromise;
  };

  return {
    attach(acquired, lease) {
      if (resources !== undefined) throw new Error("Ordinary Session control already has acquired resources.");
      resources = acquired;
      resourceLease = lease;
      if (requested) {
        void startRevoke().then(
          () => pending?.resolve(),
          (error: unknown) => pending?.reject(error),
        );
      } else {
        pending?.resolve();
      }
    },
    async finalize(target) {
      const shouldRevoke = target !== undefined;
      if (requested && shouldRevoke && JSON.stringify(targetLeaf) !== JSON.stringify(target)) {
        return Promise.reject(new Error("Ordinary Session revoke target cannot change."));
      }
      if (shouldRevoke) {
        requested = true;
        targetLeaf = target;
      }
      if (finished) return;
      if (resources === undefined) {
        pending ??= deferred<void>();
        await pending.promise;
      }
      if (shouldRevoke) await startRevoke();
      await resourceLease?.release();
      await resources?.releaseSession?.();
      finished = true;
    },
    finish() {
      finished = true;
      pending?.resolve();
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
