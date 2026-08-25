import { toolInvocationId, type ToolCallProgress, type ToolCallRequest, type ToolCallResult } from "../../domain/tools/index.js";
import type { IdFactory } from "../../kernel/id.js";
import type { AgentSessionRepository } from "../model-runtime/agent-session.js";
import {
  OrdinaryFeatureError,
  type OrdinaryRunActivity,
  type OrdinaryRunEvent,
  type OrdinaryRunSnapshotDocument,
  type OrdinaryRunState,
} from "./contracts.js";
import { durableOrdinaryRunReplayFromState } from "./activity-replay.js";
import { isTerminal, isTerminalEvent } from "./run-lifecycle-policy.js";
import { liveToolActivityId, toolActivityId, toolInvocationIds } from "./run-activity-identity.js";
import { ordinaryToolResultKey } from "./state.js";

export type OrdinaryRunActivityStream = {
  readonly streamId: string;
  nextSequence: number;
  activities: OrdinaryRunActivity[];
};

export type OrdinaryRunActivityHub = {
  needsLiveStream(state: OrdinaryRunState): boolean;
  replayStream(document: OrdinaryRunSnapshotDocument): Promise<OrdinaryRunActivityStream>;
  restorePersistedStream(state: OrdinaryRunState): Promise<OrdinaryRunActivityStream>;
  visibleAssistantText(runId: string): string | undefined;
  currentModelRequestId(runId: string): string | undefined;
  recordTransition(event: OrdinaryRunEvent, assistantText?: string): void;
  recordOutputDelta(runId: string, contentIndex: number, delta: string): void;
  recordReasoningDelta(runId: string, contentIndex: number, delta: string): void;
  completeReasoning(runId: string, contentIndex?: number, authoritativeContent?: string): Promise<void>;
  recordModelRequest(runId: string, reason: "initial" | "after_tool" | "after_approval"): void;
  recordToolRequested(runId: string, request: ToolCallRequest): void;
  recordToolProgress(runId: string, update: ToolCallProgress): void;
  recordDurableToolResult(runId: string, result: ToolCallResult, recordedAt: string): void;
  syncDurableToolResults(state: OrdinaryRunState): void;
  hasSubscribers(runId: string): boolean;
  subscribe(runId: string, listener: (activity: OrdinaryRunActivity) => void): () => void;
  releaseStream(runId: string): void;
  releaseRun(runId: string): void;
  prepareRelease(): Promise<void>;
  release(): void;
};

export function createOrdinaryRunActivityHub(options: {
  readonly streamEpoch: string;
  readonly checkpointIntervalMs: number;
  readonly idFactory: IdFactory;
  readonly now: () => string;
  readonly sessionRepository: Pick<AgentSessionRepository, "readAssistantEntries">;
  readonly isReleased: () => boolean;
  readonly getCachedRun: (runId: string) => OrdinaryRunSnapshotDocument | undefined;
  readonly loadRun: (runId: string) => Promise<OrdinaryRunSnapshotDocument | undefined>;
  readonly persistVisibleAssistantText: (runId: string, text: string) => Promise<void>;
  readonly recordReasoning: (input: {
    readonly runId: string;
    readonly modelRequestId: string;
    readonly contentIndex: number;
    readonly content: string;
  }) => Promise<void>;
  readonly trackBackgroundTask: (task: Promise<void>) => void;
  readonly onLastSubscriberRemoved: (runId: string) => void;
}): OrdinaryRunActivityHub {
  const streams = new Map<string, OrdinaryRunActivityStream>();
  const listeners = new Map<string, Set<(activity: OrdinaryRunActivity) => void>>();
  const activeModelRequestIds = new Map<string, string>();
  const reasoningBuffers = new Map<string, {
    readonly modelRequestId: string;
    readonly contentIndex: number;
    content: string;
  }>();
  const visibleAssistantBuffers = new Map<string, string>();
  const visibleAssistantCheckpointTimers = new Map<string, NodeJS.Timeout>();

  const needsLiveStream = (state: OrdinaryRunState): boolean =>
    !isTerminal(state) ||
    state.pendingToolRound !== undefined ||
    state.pendingNestedToolCalls !== undefined ||
    state.toolCalls.some((result) => result.status === "approval_required");

  async function readRunAssistantEntries(state: OrdinaryRunState) {
    const entryRefs = state.timeline.flatMap((event) =>
      event.type === "model.output.completed" ? [event.assistantEntryRef] : []);
    if (entryRefs.length === 0) return [];
    return options.sessionRepository.readAssistantEntries({
      sessionRef: state.sessionRef,
      entryRefs,
    });
  }

  function streamFor(
    runId: string,
    durableActivities: readonly OrdinaryRunActivity[] = [],
  ): OrdinaryRunActivityStream {
    const existing = streams.get(runId);
    if (existing !== undefined) return existing;
    const activities = [...durableActivities];
    const created = {
      streamId: options.idFactory("ordinary-activity-stream"),
      nextSequence: activities.length + 1,
      activities,
    };
    streams.set(runId, created);
    return created;
  }

  async function restorePersistedStream(state: OrdinaryRunState): Promise<OrdinaryRunActivityStream> {
    const existing = streams.get(state.runId);
    if (existing !== undefined) return existing;
    const replay = durableOrdinaryRunReplayFromState(state, await readRunAssistantEntries(state));
    return streamFor(state.runId, replay.activities);
  }

  async function terminalReplayStream(document: OrdinaryRunSnapshotDocument): Promise<OrdinaryRunActivityStream> {
    const assistantEntries = await readRunAssistantEntries(document.state);
    const replay = durableOrdinaryRunReplayFromState(document.state, assistantEntries);
    return {
      streamId: `${options.streamEpoch}:terminal:${document.state.runId}:${document.revision}`,
      nextSequence: replay.activities.length + 1,
      activities: [...replay.activities],
    };
  }

  async function replayStream(document: OrdinaryRunSnapshotDocument): Promise<OrdinaryRunActivityStream> {
    return streams.get(document.state.runId) ?? (
      needsLiveStream(document.state)
        ? await restorePersistedStream(document.state)
        : await terminalReplayStream(document)
    );
  }

  function emit(activity: OrdinaryRunActivity): void {
    for (const listener of listeners.get(activity.runId) ?? []) {
      try { listener(clone(activity)); }
      catch { /* A projection subscriber cannot roll back an already committed feature fact. */ }
    }
  }

  function clearVisibleAssistantCheckpoint(runId: string): void {
    const timer = visibleAssistantCheckpointTimers.get(runId);
    if (timer !== undefined) clearTimeout(timer);
    visibleAssistantCheckpointTimers.delete(runId);
    visibleAssistantBuffers.delete(runId);
  }

  function recordTransition(event: OrdinaryRunEvent, assistantText?: string): void {
    const stream = streamFor(event.runId);
    if (event.type === "model.output.completed") {
      if (assistantText === undefined) {
        throw new OrdinaryFeatureError(
          "ordinary_run_state_conflict",
          "Committed assistant output must be projected from its Session entry",
        );
      }
      stream.activities = stream.activities.filter((activity) =>
        activity.type !== "model.output.delta" || activity.modelRequestId !== event.modelRequestId);
      const activity: OrdinaryRunActivity = {
        activityId: `transition:${event.eventId}`,
        runId: event.runId,
        sequence: stream.nextSequence++,
        recordedAt: event.recordedAt,
        type: "model.output.completed",
        durability: "durable",
        modelRequestId: event.modelRequestId,
        assistantEntryRef: clone(event.assistantEntryRef),
        content: assistantText,
      };
      stream.activities.push(activity);
      emit(activity);
      return;
    }
    if (event.type === "model.reasoning.completed") {
      stream.activities = stream.activities.filter((activity) =>
        activity.type !== "model.reasoning.delta" ||
          activity.modelRequestId !== event.modelRequestId ||
          activity.contentIndex !== event.contentIndex);
    }
    const durableInvocationIds = toolInvocationIds(event);
    stream.activities = stream.activities.map((activity) =>
      activity.type === "tool.result" && durableInvocationIds.includes(toolInvocationId(activity.result))
        ? { ...activity, durability: "durable" }
        : activity);
    const activity: OrdinaryRunActivity = {
      activityId: `transition:${event.eventId}`,
      runId: event.runId,
      sequence: stream.nextSequence++,
      recordedAt: event.recordedAt,
      type: "run.transition",
      durability: "durable",
      event: clone(event),
    };
    stream.activities.push(activity);
    emit(activity);
    if (isTerminalEvent(event)) {
      stream.activities = stream.activities.filter((item) => item.durability === "durable");
      activeModelRequestIds.delete(event.runId);
      for (const key of reasoningBuffers.keys()) {
        if (key.startsWith(`${event.runId}:`)) reasoningBuffers.delete(key);
      }
      clearVisibleAssistantCheckpoint(event.runId);
    }
  }

  function scheduleVisibleAssistantCheckpoint(runId: string): void {
    if (visibleAssistantCheckpointTimers.has(runId)) return;
    const timer = setTimeout(() => {
      visibleAssistantCheckpointTimers.delete(runId);
      const text = visibleAssistantBuffers.get(runId);
      if (text === undefined) return;
      options.trackBackgroundTask(options.persistVisibleAssistantText(runId, text).catch(() => undefined));
    }, options.checkpointIntervalMs);
    timer.unref?.();
    visibleAssistantCheckpointTimers.set(runId, timer);
  }

  function recordOutputDelta(runId: string, contentIndex: number, delta: string): void {
    if (options.isReleased() || delta.length === 0) return;
    const document = options.getCachedRun(runId);
    if (document?.state.status.kind !== "running") return;
    const modelRequestId = activeModelRequestIds.get(runId);
    if (modelRequestId === undefined) return;
    const visibleAssistantText = `${visibleAssistantBuffers.get(runId) ?? document.state.visibleAssistantText ?? ""}${delta}`;
    visibleAssistantBuffers.set(runId, visibleAssistantText);
    scheduleVisibleAssistantCheckpoint(runId);
    const stream = streamFor(runId);
    const activity: OrdinaryRunActivity = {
      activityId: options.idFactory("ordinary-activity"),
      runId,
      sequence: stream.nextSequence++,
      recordedAt: options.now(),
      type: "model.output.delta",
      durability: "live_only",
      modelRequestId,
      contentIndex,
      delta,
    };
    stream.activities.push(activity);
    emit(activity);
  }

  function reasoningBufferKey(runId: string, modelRequestId: string, contentIndex: number): string {
    return `${runId}:${modelRequestId}:${contentIndex}`;
  }

  function recordReasoningDelta(runId: string, contentIndex: number, delta: string): void {
    if (options.isReleased() || delta.length === 0) return;
    const state = options.getCachedRun(runId)?.state;
    if (state?.status.kind !== "running") return;
    const modelRequestId = activeModelRequestIds.get(runId);
    if (modelRequestId === undefined) return;
    if (state.timeline.some((event) =>
      event.type === "model.reasoning.completed" && event.modelRequestId === modelRequestId && event.contentIndex === contentIndex)) return;
    const bufferKey = reasoningBufferKey(runId, modelRequestId, contentIndex);
    const buffer = reasoningBuffers.get(bufferKey);
    if (buffer === undefined || buffer.modelRequestId !== modelRequestId || buffer.contentIndex !== contentIndex) {
      reasoningBuffers.set(bufferKey, { modelRequestId, contentIndex, content: delta });
    } else {
      buffer.content += delta;
    }
    const stream = streamFor(runId);
    const activity: OrdinaryRunActivity = {
      activityId: options.idFactory("ordinary-activity"),
      runId,
      sequence: stream.nextSequence++,
      recordedAt: options.now(),
      type: "model.reasoning.delta",
      durability: "live_only",
      modelRequestId,
      contentIndex,
      delta,
    };
    stream.activities.push(activity);
    emit(activity);
  }

  async function completeReasoning(runId: string, contentIndex?: number, authoritativeContent?: string): Promise<void> {
    const modelRequestId = activeModelRequestIds.get(runId);
    if (modelRequestId === undefined) return;
    let buffered = contentIndex === undefined
      ? undefined
      : reasoningBuffers.get(reasoningBufferKey(runId, modelRequestId, contentIndex));
    if (buffered === undefined && contentIndex === undefined) {
      const entries = [...reasoningBuffers.entries()];
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, value] = entries[index]!;
        if (key.startsWith(`${runId}:${modelRequestId}:`) && value.modelRequestId === modelRequestId) {
          buffered = value;
          break;
        }
      }
    }
    const targetContentIndex = contentIndex ?? (buffered?.modelRequestId === modelRequestId ? buffered.contentIndex : 0);
    if (buffered?.modelRequestId === modelRequestId && buffered.contentIndex === targetContentIndex) {
      reasoningBuffers.delete(reasoningBufferKey(runId, modelRequestId, targetContentIndex));
    }
    const content = authoritativeContent !== undefined && authoritativeContent.length > 0
      ? authoritativeContent
      : buffered?.modelRequestId === modelRequestId && buffered.contentIndex === targetContentIndex ? buffered.content : undefined;
    if (content === undefined || content.length === 0) return;
    const document = await options.loadRun(runId);
    if (document?.state.status.kind !== "running") return;
    const existing = document.state.timeline.find((event) =>
      event.type === "model.reasoning.completed" && event.modelRequestId === modelRequestId && event.contentIndex === targetContentIndex);
    if (existing?.type === "model.reasoning.completed") return;
    await options.recordReasoning({ runId, modelRequestId, contentIndex: targetContentIndex, content });
  }

  function recordModelRequest(runId: string, reason: "initial" | "after_tool" | "after_approval"): void {
    if (options.isReleased() || options.getCachedRun(runId)?.state.status.kind !== "running") return;
    const stream = streamFor(runId);
    const latest = stream.activities.at(-1);
    if (latest?.type === "model.request" && latest.reason === reason) return;
    const activity: OrdinaryRunActivity = {
      activityId: options.idFactory("ordinary-activity"),
      runId,
      sequence: stream.nextSequence++,
      recordedAt: options.now(),
      type: "model.request",
      durability: "live_only",
      reason,
    };
    stream.activities.push(activity);
    activeModelRequestIds.set(runId, activity.activityId);
    emit(activity);
  }

  function hasTerminalToolFact(runId: string, identity: Pick<ToolCallRequest, "invocationId">): boolean {
    const invocationId = toolInvocationId(identity);
    return options.getCachedRun(runId)?.state.toolCalls.some((result) =>
      toolInvocationId(result) === invocationId && result.status !== "approval_required") === true;
  }

  function recordToolRequested(runId: string, request: ToolCallRequest): void {
    if (options.isReleased() || options.getCachedRun(runId)?.state.status.kind !== "running") return;
    const stream = streamFor(runId);
    const activityId = liveToolActivityId(request);
    if (stream.activities.some((activity) => activity.activityId === activityId) || hasTerminalToolFact(runId, request)) return;
    const activity: OrdinaryRunActivity = {
      activityId,
      runId,
      sequence: stream.nextSequence++,
      recordedAt: options.now(),
      type: "tool.requested",
      durability: "live_only",
      request: clone(request),
    };
    stream.activities.push(activity);
    emit(activity);
  }

  function recordToolProgress(runId: string, update: ToolCallProgress): void {
    if (options.isReleased() || options.getCachedRun(runId)?.state.status.kind !== "running") return;
    const stream = streamFor(runId);
    const activityId = liveToolActivityId(update);
    const existingIndex = stream.activities.findIndex((activity) => activity.activityId === activityId);
    const existing = stream.activities[existingIndex];
    if (existing === undefined || (existing.type !== "tool.requested" && existing.type !== "tool.progress")) return;
    if (existing.request.toolName !== update.toolName || hasTerminalToolFact(runId, update)) return;
    const activity: OrdinaryRunActivity = {
      activityId,
      runId,
      sequence: stream.nextSequence++,
      recordedAt: existing.recordedAt,
      type: "tool.progress",
      durability: "live_only",
      request: existing.request,
      progress: clone(update.progress),
    };
    stream.activities[existingIndex] = activity;
    emit(activity);
  }

  function recordDurableToolResult(runId: string, result: ToolCallResult, recordedAt: string): void {
    const stream = streamFor(runId);
    const activityId = toolActivityId(result);
    const existingIndex = stream.activities.findIndex((activity) => activity.activityId === activityId);
    const existing = stream.activities[existingIndex];
    if (existing?.type === "tool.result" && existing.durability === "durable") return;
    if (existing?.type === "tool.result") {
      stream.activities[existingIndex] = { ...existing, durability: "durable" };
      return;
    }
    const activity: OrdinaryRunActivity = {
      activityId,
      runId,
      sequence: stream.nextSequence++,
      recordedAt,
      type: "tool.result",
      durability: "durable",
      result: clone(result),
    };
    stream.activities.push(activity);
    emit(activity);
  }

  function syncDurableToolResults(state: OrdinaryRunState): void {
    for (const result of state.toolCalls) {
      if (result.status === "approval_required") continue;
      const recordedAt = state.toolResultRecordedAt[ordinaryToolResultKey(result)];
      if (recordedAt !== undefined) recordDurableToolResult(state.runId, result, recordedAt);
    }
  }

  return {
    needsLiveStream,
    replayStream,
    restorePersistedStream,
    visibleAssistantText: (runId) => visibleAssistantBuffers.get(runId),
    currentModelRequestId: (runId) => activeModelRequestIds.get(runId),
    recordTransition,
    recordOutputDelta,
    recordReasoningDelta,
    completeReasoning,
    recordModelRequest,
    recordToolRequested,
    recordToolProgress,
    recordDurableToolResult,
    syncDurableToolResults,
    hasSubscribers: (runId) => (listeners.get(runId)?.size ?? 0) > 0,
    subscribe(runId, listener) {
      const runListeners = listeners.get(runId) ?? new Set();
      runListeners.add(listener);
      listeners.set(runId, runListeners);
      return () => {
        runListeners.delete(listener);
        if (runListeners.size > 0) return;
        listeners.delete(runId);
        options.onLastSubscriberRemoved(runId);
      };
    },
    releaseStream(runId) {
      streams.delete(runId);
    },
    releaseRun(runId) {
      streams.delete(runId);
      listeners.delete(runId);
      clearVisibleAssistantCheckpoint(runId);
      activeModelRequestIds.delete(runId);
      for (const key of reasoningBuffers.keys()) {
        if (key.startsWith(`${runId}:`)) reasoningBuffers.delete(key);
      }
    },
    async prepareRelease() {
      for (const timer of visibleAssistantCheckpointTimers.values()) clearTimeout(timer);
      visibleAssistantCheckpointTimers.clear();
      await Promise.allSettled([...visibleAssistantBuffers].map(([runId, text]) =>
        options.persistVisibleAssistantText(runId, text)));
    },
    release() {
      listeners.clear();
      streams.clear();
      activeModelRequestIds.clear();
      reasoningBuffers.clear();
      visibleAssistantBuffers.clear();
      for (const timer of visibleAssistantCheckpointTimers.values()) clearTimeout(timer);
      visibleAssistantCheckpointTimers.clear();
    },
  };
}

function clone<T>(value: T): T {
  return globalThis.structuredClone(value);
}
