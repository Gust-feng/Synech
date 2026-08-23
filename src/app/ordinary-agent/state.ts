import type { ModelUsage } from "../../domain/intelligence/index.js";
import type { RunCapabilityResolution } from "../../domain/config/index.js";
import { toolCallFactId, type ToolCallRequest, type ToolCallResult } from "../../domain/tools/index.js";
import type {
  AgentSessionExecutionRefs,
  AgentSessionEntryRef,
  AgentSessionRef,
  AgentSessionWriteCheckpoint,
} from "../model-runtime/agent-session.js";
import type {
  OrdinaryRunBirth,
  OrdinaryRunEvent,
  OrdinaryRunInput,
  OrdinaryPendingNestedToolCall,
  OrdinaryRunState,
  OrdinaryRunStatus,
  OrdinaryRunTurn,
} from "./contracts.js";
import type { OrdinaryToolMetricsSnapshot } from "./tool-runtime-metrics.js";
import { OrdinaryFeatureError } from "./contracts.js";

export type OrdinaryRunTransition =
  | { readonly type: "start" }
  | {
      readonly type: "record_session_checkpoint";
      readonly checkpoint: AgentSessionWriteCheckpoint;
      readonly modelRequestId?: string;
      /** Ephemeral projection material read from the committed Session entry. */
      readonly assistantText?: string;
    }
  | { readonly type: "record_reasoning"; readonly modelRequestId: string; readonly content: string }
  | {
      readonly type: "request_approval";
      readonly status: Extract<OrdinaryRunStatus, { readonly kind: "awaiting_approval" }>;
      readonly session?: AgentSessionExecutionRefs;
      readonly toolCalls: readonly ToolCallResult[];
      readonly usage: ModelUsage;
      readonly capabilityResolution?: RunCapabilityResolution;
      readonly toolMetrics?: OrdinaryToolMetricsSnapshot;
    }
  | { readonly type: "approval_decided"; readonly decision: import("../../domain/confirmation/index.js").ConfirmationDecision }
  | {
      readonly type: "complete";
      readonly session: AgentSessionExecutionRefs;
      readonly toolCalls: readonly ToolCallResult[];
      readonly usage: ModelUsage;
      readonly capabilityResolution?: RunCapabilityResolution;
      readonly toolMetrics?: OrdinaryToolMetricsSnapshot;
    }
  | {
      readonly type: "fail";
      readonly error: { readonly code: string; readonly message: string };
      readonly session?: AgentSessionExecutionRefs;
      readonly toolCalls?: readonly ToolCallResult[];
      readonly usage?: ModelUsage;
      readonly capabilityResolution?: RunCapabilityResolution;
      readonly toolMetrics?: OrdinaryToolMetricsSnapshot;
    }
  | {
      readonly type: "cancel";
      readonly reason: string;
      readonly session?: AgentSessionExecutionRefs;
      readonly toolCalls?: readonly ToolCallResult[];
      readonly usage?: ModelUsage;
      readonly capabilityResolution?: RunCapabilityResolution;
      readonly toolMetrics?: OrdinaryToolMetricsSnapshot;
    }
  | {
      readonly type: "block";
      readonly reason: { readonly code: string; readonly message: string };
      readonly continueBy: "new_turn";
      readonly session?: AgentSessionExecutionRefs;
      readonly toolCalls?: readonly ToolCallResult[];
    };

export function createInitialOrdinaryRunState(input: {
  readonly runId: string;
  readonly sessionRef: AgentSessionRef;
  readonly turn: OrdinaryRunTurn;
  readonly runInput: OrdinaryRunInput;
  readonly birth: OrdinaryRunBirth;
  readonly recordedAt: string;
  readonly eventId: string;
}): OrdinaryRunState {
  if (input.runId.length === 0 || input.turn.conversationId.length === 0 ||
      input.turn.userTurnId.length === 0 || input.turn.assistantTurnId.length === 0) {
    throw new Error("Ordinary run and turn identities must not be empty");
  }
  return {
    runId: input.runId,
    sessionRef: cloneJson(input.sessionRef),
    turn: cloneJson(input.turn),
    input: cloneJson(input.runInput),
    birth: cloneJson(input.birth),
    status: { kind: "queued" },
    session: { phase: "not_started" },
    toolCalls: [],
    toolResultRecordedAt: {},
    usage: {},
    timeline: [{
      eventId: input.eventId,
      runId: input.runId,
      sequence: 1,
      type: "run.created",
      recordedAt: input.recordedAt,
    }],
    timestamps: { createdAt: input.recordedAt, updatedAt: input.recordedAt },
  };
}

export function transitionOrdinaryRun(input: {
  readonly state: OrdinaryRunState;
  readonly transition: OrdinaryRunTransition;
  readonly recordedAt: string;
  readonly eventId: string;
}): OrdinaryRunState {
  const nextStatus = statusAfter(input.state.status, input.transition);
  const terminalAt = isTerminal(nextStatus) ? input.recordedAt : undefined;
  const event = eventForTransition({
    eventId: input.eventId,
    runId: input.state.runId,
    sequence: nextSequence(input.state.timeline),
    recordedAt: input.recordedAt,
  }, input.transition);
  const nextState: OrdinaryRunState = {
    ...input.state,
    status: nextStatus,
    session: sessionAfter(input.state, input.transition),
    pendingToolRound: pendingToolRoundAfter(input.state, input.transition),
    toolCalls: toolCallsAfter(input.state, input.transition),
    toolResultRecordedAt: toolResultRecordedAtAfter(input.state, input.transition, input.recordedAt),
    usage: usageAfter(input.state, input.transition),
    capabilityResolution: capabilityResolutionAfter(input.state, input.transition),
    toolMetrics: toolMetricsAfter(input.state, input.transition),
    timeline: event === undefined ? input.state.timeline : [...input.state.timeline, event],
    timestamps: {
      ...input.state.timestamps,
      updatedAt: input.recordedAt,
      terminalAt,
    },
  };
  if (nextState.status.kind === "completed" && nextState.pendingNestedToolCalls !== undefined) {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      `Completed Ordinary run ${nextState.runId} cannot retain pending nested tool calls`,
    );
  }
  assertAwaitingApprovalFacts(nextState);
  assertOrdinaryToolFactGraph(nextState);
  assertOrdinarySessionState(nextState);
  return nextState;
}

function sessionAfter(
  state: OrdinaryRunState,
  transition: OrdinaryRunTransition,
): OrdinaryRunState["session"] {
  if (transition.type === "record_session_checkpoint") {
    if (transition.checkpoint.sessionId !== state.sessionRef.sessionId) {
      throw new OrdinaryFeatureError(
        "ordinary_run_state_conflict",
        "Ordinary Session checkpoint does not match the run Session identity",
      );
    }
    return applySessionCheckpoint(state.session, transition.checkpoint);
  }
  if ("session" in transition && transition.session !== undefined) {
    assertExecutionRefsBelongToSession(state.sessionRef, transition.session);
    if (state.session.phase !== "not_started" &&
        !sameEntryRef(state.session.startLeafRef, transition.session.startLeafRef)) {
      throw new OrdinaryFeatureError(
        "ordinary_run_state_conflict",
        "Ordinary execution cannot change its captured Session start leaf",
      );
    }
    if (transition.type === "complete") {
      if (state.session.phase !== "completion_candidate" || transition.session.latestLeafRef === null ||
          !sameEntryRef(state.session.startLeafRef, transition.session.startLeafRef) ||
          !sameEntryRef(state.session.assistantEntryRef, transition.session.latestLeafRef)) {
        throw new OrdinaryFeatureError(
          "ordinary_run_state_conflict",
          "Ordinary completion requires its Session response candidate as a rollbackable end leaf",
        );
      }
      return {
        phase: "rollbackable",
        startLeafRef: cloneJson(state.session.startLeafRef),
        endLeafRef: cloneJson(state.session.assistantEntryRef),
        compactionEntryRefs: cloneJson(transition.session.compactionEntryRefs),
      };
    }
    return sessionPhaseFromExecutionRefs(transition.session);
  }
  if ((transition.type === "fail" || transition.type === "cancel" || transition.type === "block") &&
      state.session.phase === "completion_candidate") {
    return {
      phase: "rollbackable",
      startLeafRef: cloneJson(state.session.startLeafRef),
      endLeafRef: cloneJson(state.session.rollbackLeafRef),
      compactionEntryRefs: cloneJson(state.session.compactionEntryRefs),
    };
  }
  return state.session;
}

function applySessionCheckpoint(
  current: OrdinaryRunState["session"],
  checkpoint: AgentSessionWriteCheckpoint,
): OrdinaryRunState["session"] {
  assertCheckpointEntrySessions(checkpoint);
  if (checkpoint.kind === "start_leaf_captured") {
    if (current.phase !== "not_started") {
      throw new OrdinaryFeatureError("ordinary_run_state_conflict", "Ordinary run Session start leaf was already captured");
    }
    return {
      phase: "started",
      startLeafRef: cloneJson(checkpoint.startLeafRef),
      compactionEntryRefs: [],
    };
  }
  if (current.phase === "not_started") {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      "Ordinary Session checkpoint arrived before the run captured its start leaf",
    );
  }
  switch (checkpoint.kind) {
    case "input_entry_committed":
      if (current.phase !== "started") {
        throw new OrdinaryFeatureError("ordinary_run_state_conflict", "Ordinary Session input entry was already committed");
      }
      return {
        phase: "rollbackable",
        startLeafRef: cloneJson(current.startLeafRef),
        endLeafRef: cloneJson(checkpoint.inputEntryRef),
        compactionEntryRefs: [],
      };
    case "assistant_tool_call_entry_committed":
      if (current.phase !== "rollbackable") {
        throw new OrdinaryFeatureError("ordinary_run_state_conflict", "Ordinary Session tool round requires a rollbackable prefix");
      }
      return current;
    case "tool_result_entries_committed":
      if (current.phase !== "rollbackable") {
        throw new OrdinaryFeatureError("ordinary_run_state_conflict", "Ordinary Session tool results require a rollbackable prefix");
      }
      return {
        phase: "rollbackable",
        startLeafRef: cloneJson(current.startLeafRef),
        endLeafRef: cloneJson(checkpoint.toolRoundLeafRef),
        compactionEntryRefs: cloneJson(current.compactionEntryRefs),
      };
    case "compaction_entry_committed":
      if (current.phase !== "rollbackable") {
        throw new OrdinaryFeatureError("ordinary_run_state_conflict", "Ordinary Session compaction requires a rollbackable prefix");
      }
      return {
        phase: "rollbackable",
        startLeafRef: cloneJson(current.startLeafRef),
        endLeafRef: cloneJson(checkpoint.compactionEntryRef),
        compactionEntryRefs: [
          ...current.compactionEntryRefs,
          cloneJson(checkpoint.compactionEntryRef),
        ],
      };
    case "assistant_response_entry_committed":
      if (current.phase !== "rollbackable") {
        throw new OrdinaryFeatureError("ordinary_run_state_conflict", "Ordinary Session response requires a rollbackable prefix");
      }
      return {
        phase: "completion_candidate",
        startLeafRef: cloneJson(current.startLeafRef),
        rollbackLeafRef: cloneJson(current.endLeafRef),
        assistantEntryRef: cloneJson(checkpoint.assistantEntryRef),
        compactionEntryRefs: cloneJson(current.compactionEntryRefs),
      };
  }
}

function assertCheckpointEntrySessions(checkpoint: AgentSessionWriteCheckpoint): void {
  const refs = checkpoint.kind === "start_leaf_captured"
    ? [checkpoint.startLeafRef]
    : checkpoint.kind === "input_entry_committed"
      ? [checkpoint.inputEntryRef]
      : checkpoint.kind === "assistant_tool_call_entry_committed"
        ? [checkpoint.assistantEntryRef]
        : checkpoint.kind === "tool_result_entries_committed"
          ? [checkpoint.toolRoundLeafRef]
          : checkpoint.kind === "compaction_entry_committed"
            ? [checkpoint.compactionEntryRef]
            : [checkpoint.assistantEntryRef];
  if (refs.some((ref) => ref !== null && ref.sessionId !== checkpoint.sessionId)) {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      "Ordinary Session checkpoint contains an entry from a different Session",
    );
  }
}

function sessionPhaseFromExecutionRefs(refs: AgentSessionExecutionRefs): OrdinaryRunState["session"] {
  if (refs.safeLeafRef === null) {
    return {
      phase: "started",
      startLeafRef: cloneJson(refs.startLeafRef),
      compactionEntryRefs: cloneJson(refs.compactionEntryRefs),
    };
  }
  return {
    phase: "rollbackable",
    startLeafRef: cloneJson(refs.startLeafRef),
    endLeafRef: cloneJson(refs.safeLeafRef),
    compactionEntryRefs: cloneJson(refs.compactionEntryRefs),
  };
}

function assertExecutionRefsBelongToSession(
  sessionRef: AgentSessionRef,
  refs: AgentSessionExecutionRefs,
): void {
  const entryRefs = [
    refs.startLeafRef,
    refs.inputEntryRef,
    refs.safeLeafRef,
    refs.latestLeafRef,
    ...refs.compactionEntryRefs,
  ].filter((ref): ref is AgentSessionEntryRef => ref !== null && ref !== undefined);
  if (refs.sessionId !== sessionRef.sessionId || entryRefs.some((ref) => ref.sessionId !== sessionRef.sessionId)) {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      "Ordinary execution Session refs do not belong to the run Session",
    );
  }
}

function assertOrdinarySessionState(state: OrdinaryRunState): void {
  const refs: AgentSessionEntryRef[] = [];
  if (state.session.phase !== "not_started") {
    if (state.session.startLeafRef !== null) refs.push(state.session.startLeafRef);
    refs.push(...state.session.compactionEntryRefs);
  }
  if (state.session.phase === "rollbackable") refs.push(state.session.endLeafRef);
  if (state.session.phase === "completion_candidate") {
    refs.push(state.session.rollbackLeafRef, state.session.assistantEntryRef);
  }
  if (state.pendingToolRound !== undefined) {
    refs.push(state.pendingToolRound.assistantEntryRef);
    if (state.session.phase !== "rollbackable") {
      throw new OrdinaryFeatureError(
        "ordinary_run_state_conflict",
        "An Ordinary pending tool round requires a rollbackable Session phase",
      );
    }
  }
  if (refs.some((ref) => ref.sessionId !== state.sessionRef.sessionId)) {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      "Ordinary run Session positions must belong to its conversation Session",
    );
  }
  if (state.status.kind === "completed" &&
      (state.session.phase !== "rollbackable" || state.pendingToolRound !== undefined)) {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      "An Ordinary completed run requires a rollbackable Session end leaf",
    );
  }
  if (state.session.phase === "completion_candidate" && state.pendingToolRound !== undefined) {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      "An Ordinary Session response candidate cannot coexist with a pending tool round",
    );
  }
}

function sameEntryRef(left: AgentSessionEntryRef | null, right: AgentSessionEntryRef | null): boolean {
  return left === null || right === null
    ? left === right
    : left.sessionId === right.sessionId && left.entryId === right.entryId;
}

/**
 * An approval pause names the exact tool facts that are still awaiting a
 * decision. A prior decision may already have released another tool from the
 * same Pi batch; its original approval fact remains until ToolCenter records a
 * terminal result, so it is justified by the durable decision event instead.
 */
function assertAwaitingApprovalFacts(state: OrdinaryRunState): void {
  if (state.status.kind !== "awaiting_approval") return;
  const approvalFacts = state.toolCalls.filter((result) => result.status === "approval_required");
  const requestsById = new Map(state.status.confirmationRequests.map((request) =>
    [request.confirmationId, request] as const));
  const factsByConfirmationId = new Map(approvalFacts.flatMap((result) => {
    const request = result.confirmationRequest;
    if (request === undefined || request.toolCallFactId !== toolCallFactId(result)) return [];
    return [[request.confirmationId, request] as const];
  }));
  const decidedConfirmationIds = new Set(state.timeline.flatMap((event) =>
    event.type === "run.approval_decided" ? [event.decision.confirmationId] : []));
  if (requestsById.size !== state.status.confirmationRequests.length ||
      factsByConfirmationId.size !== approvalFacts.length ||
      [...requestsById].some(([confirmationId, request]) =>
        JSON.stringify(request) !== JSON.stringify(factsByConfirmationId.get(confirmationId))) ||
      [...factsByConfirmationId.keys()].some((confirmationId) =>
        !requestsById.has(confirmationId) && !decidedConfirmationIds.has(confirmationId))) {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      "An Ordinary approval pause must match its approval tool facts that remain pending or have durable approval decisions",
    );
  }
}

function statusAfter(status: OrdinaryRunStatus, transition: OrdinaryRunTransition): OrdinaryRunStatus {
  switch (transition.type) {
    case "start":
      assertStatus(status, ["queued"], transition.type);
      return { kind: "running" };
    case "record_reasoning":
      assertStatus(status, ["running"], transition.type);
      if (transition.content.length === 0) throw new Error("Recorded model reasoning must not be empty");
      return status;
    case "record_session_checkpoint":
      assertStatus(status, ["running", "failed", "cancelled", "blocked"], transition.type);
      return status;
    case "request_approval":
      assertStatus(status, ["running"], transition.type);
      if (transition.status.confirmationRequests.length === 0) {
        throw new Error("An approval pause must contain at least one confirmation request");
      }
      return cloneJson(transition.status);
    case "approval_decided":
      assertStatus(status, ["awaiting_approval"], transition.type);
      return { kind: "running" };
    case "complete":
      assertStatus(status, ["running"], transition.type);
      return { kind: "completed" };
    case "fail":
      assertStatus(status, ["queued", "running"], transition.type);
      return { kind: "failed", error: cloneJson(transition.error) };
    case "cancel":
      assertStatus(status, ["queued", "running", "awaiting_approval"], transition.type);
      return { kind: "cancelled", reason: transition.reason };
    case "block":
      assertStatus(status, ["queued", "running", "awaiting_approval"], transition.type);
      return {
        kind: "blocked",
        reason: cloneJson(transition.reason),
        continueBy: transition.continueBy,
      };
  }
}

function pendingToolRoundAfter(
  state: OrdinaryRunState,
  transition: OrdinaryRunTransition,
): OrdinaryRunState["pendingToolRound"] {
  if (transition.type !== "record_session_checkpoint") return state.pendingToolRound;
  const checkpoint = transition.checkpoint;
  if (checkpoint.kind === "assistant_tool_call_entry_committed") {
    return acceptedOrdinaryToolRound({
      state,
      assistantEntryRef: checkpoint.assistantEntryRef,
      toolCallIds: checkpoint.toolCallIds,
    });
  }
  if (checkpoint.kind !== "tool_result_entries_committed") return state.pendingToolRound;
  const pending = state.pendingToolRound;
  if (pending === undefined || JSON.stringify(pending.toolCallIds) !== JSON.stringify(checkpoint.toolCallIds)) {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      "Ordinary Session tool result checkpoint does not match its pending provider order",
    );
  }
  const results = pending.toolCallIds.map((callId) => rootToolResultByCallId(state.toolCalls, callId));
  if (results.some((result) => result === undefined || result.status === "approval_required")) {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      "Ordinary Session tool result checkpoint requires every root ToolCallResult fact",
    );
  }
  if (state.pendingNestedToolCalls !== undefined) {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      "Ordinary Session tool result checkpoint cannot close while nested tool outcomes are pending",
    );
  }
  return undefined;
}

function toolCallsAfter(state: OrdinaryRunState, transition: OrdinaryRunTransition): readonly ToolCallResult[] {
  if ("toolCalls" in transition && transition.toolCalls !== undefined) {
    return mergeOrdinaryToolResults(state.toolCalls, transition.toolCalls);
  }
  return state.toolCalls;
}

function toolResultRecordedAtAfter(
  state: OrdinaryRunState,
  transition: OrdinaryRunTransition,
  recordedAt: string,
): Readonly<Record<string, string>> {
  if (!("toolCalls" in transition) || transition.toolCalls === undefined) {
    return state.toolResultRecordedAt;
  }
  const next = { ...state.toolResultRecordedAt };
  for (const result of transition.toolCalls) {
    next[ordinaryToolResultKey(result)] ??= recordedAt;
  }
  return next;
}

/** Durably accepts one validated root assistant turn before any tool enters preflight. */
export function acceptOrdinaryToolRound(input: {
  readonly state: OrdinaryRunState;
  readonly assistantEntryRef: AgentSessionEntryRef;
  readonly toolCallIds: readonly string[];
}): OrdinaryRunState {
  if (input.state.status.kind !== "running") {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      `Ordinary run ${input.state.runId} cannot accept a tool round while ${input.state.status.kind}`,
    );
  }
  const pendingToolRound = acceptedOrdinaryToolRound(input);
  if (input.state.pendingToolRound !== undefined) {
    if (JSON.stringify(input.state.pendingToolRound) === JSON.stringify(pendingToolRound)) {
      return input.state;
    }
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      `Ordinary run ${input.state.runId} already has an unresolved tool round`,
    );
  }
  if (pendingToolRound.toolCallIds.some((callId) => rootToolResultByCallId(input.state.toolCalls, callId) !== undefined)) {
    throw new OrdinaryFeatureError(
      "ordinary_tool_result_conflict",
      `Ordinary run ${input.state.runId} cannot reuse a committed root tool call identity`,
    );
  }
  const nextState: OrdinaryRunState = {
    ...input.state,
    pendingToolRound,
  };
  assertOrdinaryToolFactGraph(nextState);
  return nextState;
}

function acceptedOrdinaryToolRound(input: {
  readonly state: OrdinaryRunState;
  readonly assistantEntryRef: AgentSessionEntryRef;
  readonly toolCallIds: readonly string[];
}): NonNullable<OrdinaryRunState["pendingToolRound"]> {
  if (input.state.session.phase !== "rollbackable") {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      "An Ordinary pending tool round requires a rollbackable Session prefix",
    );
  }
  if (input.assistantEntryRef.sessionId !== input.state.sessionRef.sessionId) {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      "An Ordinary pending tool round cannot reference a different Session",
    );
  }
  if (input.toolCallIds.length === 0) throw new Error("An Ordinary pending tool round requires tool call identities");
  if (new Set(input.toolCallIds).size !== input.toolCallIds.length) {
    throw new Error("An Ordinary pending tool round cannot contain duplicate tool call identities");
  }
  return {
    assistantEntryRef: cloneJson(input.assistantEntryRef),
    toolCallIds: [...input.toolCallIds],
  };
}

/** Atomically accepts one provider-emitted nested batch before any call can execute. */
export function recordOrdinaryNestedToolRequests(input: {
  readonly state: OrdinaryRunState;
  readonly requests: readonly ToolCallRequest[];
  readonly recordedAt: string;
}): OrdinaryRunState {
  if (input.requests.length === 0) return input.state;
  if (input.state.status.kind !== "running") {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      `Ordinary run ${input.state.runId} cannot accept nested tools while ${input.state.status.kind}`,
    );
  }
  const accepted = input.requests.map(requirePendingNestedToolCall);
  const acceptedFactIds = accepted.map((request) => request.factId);
  if (new Set(acceptedFactIds).size !== acceptedFactIds.length) {
    throw new OrdinaryFeatureError(
      "ordinary_tool_result_conflict",
      `Ordinary run ${input.state.runId} received duplicate nested tool facts in one batch`,
    );
  }
  const pending = [...(input.state.pendingNestedToolCalls ?? [])];
  for (const request of accepted) {
    const existing = pending.find((item) => item.factId === request.factId);
    if (existing !== undefined) {
      if (JSON.stringify(existing) === JSON.stringify(request)) continue;
      throw new OrdinaryFeatureError(
        "ordinary_tool_result_conflict",
        `Ordinary run ${input.state.runId} already accepted a different nested request for ${request.factId}`,
      );
    }
    if (input.state.toolCalls.some((result) => toolCallFactId(result) === request.factId)) {
      throw new OrdinaryFeatureError(
        "ordinary_tool_result_conflict",
        `Ordinary run ${input.state.runId} cannot reuse committed nested tool fact ${request.factId}`,
      );
    }
    pending.push(request);
  }
  if (pending.length === (input.state.pendingNestedToolCalls?.length ?? 0)) return input.state;
  const nextState: OrdinaryRunState = {
    ...input.state,
    pendingNestedToolCalls: pending,
    timestamps: { ...input.state.timestamps, updatedAt: input.recordedAt },
  };
  assertOrdinaryToolFactGraph(nextState);
  return nextState;
}

/** Records one factual tool result; Session checkpoint commits the ordered round boundary. */
export function recordOrdinaryToolResult(input: {
  readonly state: OrdinaryRunState;
  readonly result: ToolCallResult;
  readonly recordedAt: string;
}): OrdinaryRunState {
  const key = ordinaryToolResultKey(input.result);
  const factId = toolCallFactId(input.result);
  const existing = input.state.toolCalls.find((result) =>
    toolCallFactId(result) === factId);
  const pendingNested = input.state.pendingNestedToolCalls ?? [];
  const pendingRequest = pendingNested.find((request) => request.factId === factId);
  if (pendingRequest !== undefined && !toolResultMatchesPendingNestedCall(input.result, pendingRequest)) {
    throw new OrdinaryFeatureError(
      "ordinary_tool_result_conflict",
      `Ordinary nested tool result ${factId} does not match its accepted request`,
    );
  }
  const nextPendingNested = input.result.status === "approval_required"
    ? pendingNested
    : pendingNested.filter((request) => request.factId !== factId);
  assertOrdinaryToolFactGraph({
    ...input.state,
    pendingNestedToolCalls: nextPendingNested.length === 0 ? undefined : nextPendingNested,
    toolCalls: [...input.state.toolCalls, input.result],
  });
  if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(input.result) &&
      nextPendingNested.length === pendingNested.length) {
    return input.state;
  }
  const recorded: OrdinaryRunState = {
    ...input.state,
    toolCalls: mergeOrdinaryToolResults(input.state.toolCalls, [input.result]),
    pendingNestedToolCalls: nextPendingNested.length === 0 ? undefined : nextPendingNested,
    toolResultRecordedAt: {
      ...input.state.toolResultRecordedAt,
      [key]: input.state.toolResultRecordedAt[key] ?? input.recordedAt,
    },
    timestamps: {
      ...input.state.timestamps,
      updatedAt: input.recordedAt,
    },
  };
  assertOrdinaryToolFactGraph(recorded);
  return recorded;
}

/** Closes nested write-ahead facts after their live delegated execution owner is gone. */
export function reconcileInterruptedOrdinaryNestedToolCalls(input: {
  readonly state: OrdinaryRunState;
  readonly recordedAt: string;
}): OrdinaryRunState {
  let state = input.state;
  for (const request of input.state.pendingNestedToolCalls ?? []) {
    const existing = state.toolCalls.find((result) => toolCallFactId(result) === request.factId);
    if (existing !== undefined && !toolResultMatchesPendingNestedCall(existing, request)) {
      throw new OrdinaryFeatureError(
        "ordinary_tool_result_conflict",
        `Interrupted nested tool result ${request.factId} does not match its accepted request`,
      );
    }
    if (existing !== undefined && existing.status !== "approval_required") {
      state = recordOrdinaryToolResult({ state, result: existing, recordedAt: input.recordedAt });
      continue;
    }
    const result: ToolCallResult = existing?.status === "approval_required"
      ? interruptedOrdinaryApprovalResult(state, existing)
      : {
          ...request,
          output: undefined,
          status: "failed",
          error: "The process stopped before the nested tool outcome could be determined. Do not automatically retry this call.",
          errorDomain: "runtime_error",
          errorFacts: { code: "tool_execution_outcome_unknown", doNotBlindlyRetry: true },
          durationMs: 0,
        };
    state = recordOrdinaryToolResult({ state, result, recordedAt: input.recordedAt });
  }
  return state;
}

/**
 * Closes a durable write-ahead round after its live execution owner is gone.
 * Missing results are explicitly unknown and therefore must never be replayed.
 */
export function reconcileInterruptedOrdinaryToolRound(input: {
  readonly state: OrdinaryRunState;
  readonly orderedToolCalls: readonly ToolCallRequest[];
  readonly recordedAt: string;
}): OrdinaryRunState {
  const pending = input.state.pendingToolRound;
  if (pending === undefined) return input.state;
  if (JSON.stringify(input.orderedToolCalls.map((call) => call.callId)) !== JSON.stringify(pending.toolCallIds)) {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      "Interrupted tool reconciliation does not match its provider-ordered Session tool calls",
    );
  }
  let state = input.state;
  for (const call of input.orderedToolCalls) {
    const existing = rootToolResultByCallId(state.toolCalls, call.callId);
    if (existing !== undefined && !toolResultMatchesAcceptedCall(existing, call)) {
      throw new OrdinaryFeatureError(
        "ordinary_tool_result_conflict",
        `Ordinary root tool result ${existing.callId} does not match its accepted assistant call`,
      );
    }
    if (existing !== undefined && existing.status !== "approval_required") continue;
    const result: ToolCallResult = existing?.status === "approval_required"
      ? interruptedOrdinaryApprovalResult(input.state, existing)
      : {
          callId: existing?.callId ?? call.callId,
          ...(existing?.factId === undefined ? {} : { factId: existing.factId }),
          toolName: existing?.toolName ?? call.toolName,
          input: cloneJson(existing?.input ?? call.input),
          output: undefined,
          status: "failed",
          error: "The process stopped before the tool outcome could be determined. Do not automatically retry this call.",
          errorDomain: "runtime_error",
          errorFacts: { code: "tool_execution_outcome_unknown", doNotBlindlyRetry: true },
          durationMs: existing?.durationMs ?? 0,
        };
    state = recordOrdinaryToolResult({ state, result, recordedAt: input.recordedAt });
  }
  return state;
}

/** Closes one approval fact according to the exact durable decision, without replay. */
export function interruptedOrdinaryApprovalResult(
  state: OrdinaryRunState,
  result: ToolCallResult,
): ToolCallResult {
  if (result.status !== "approval_required") {
    throw new Error("Only an approval-required tool fact can be closed as a lost approval");
  }
  if (approvalFactWasNotExecuted(state, result)) {
    return {
      ...withoutConfirmationRequest(result),
      status: "cancelled",
      error: "The tool was not executed because its live confirmation continuation was lost.",
      errorDomain: "runtime_error",
      errorFacts: { code: "confirmation_continuation_lost" },
    };
  }
  return {
    ...withoutConfirmationRequest(result),
    status: "failed",
    error: "The process stopped before the approved tool outcome could be determined. Do not automatically retry this call.",
    errorDomain: "runtime_error",
    errorFacts: {
      ...(result.errorFacts ?? {}),
      code: "tool_execution_outcome_unknown",
      doNotBlindlyRetry: true,
    },
  };
}

function approvalFactWasNotExecuted(
  state: OrdinaryRunState,
  result: ToolCallResult,
): boolean {
  const confirmationId = result.confirmationRequest?.confirmationId;
  if (confirmationId === undefined) return false;
  const decision = [...state.timeline].reverse().find((event) =>
    event.type === "run.approval_decided" && event.decision.confirmationId === confirmationId);
  return decision === undefined || decision.type === "run.approval_decided" &&
    decision.decision.decision !== "approve_once";
}

function rootToolResultByCallId(
  results: readonly ToolCallResult[],
  callId: string,
): ToolCallResult | undefined {
  return [...results].reverse().find((result) =>
    result.callId === callId && isRootOrdinaryToolResult(result));
}

function isRootOrdinaryToolResult(
  result: Pick<ToolCallResult, "callId" | "factId" | "parentToolCallFactId">,
): boolean {
  return result.parentToolCallFactId === undefined &&
    (result.factId === undefined || result.factId === result.callId);
}

function toolResultMatchesAcceptedCall(result: ToolCallResult, call: ToolCallRequest): boolean {
  return result.toolName === call.toolName && JSON.stringify(result.input) === JSON.stringify(call.input);
}

/**
 * Nested mechanical calls belong to one already-known root invocation in this run.
 * Keeping this graph one level deep prevents orphan activity and recursive ownership
 * from being manufactured by a provider-scoped call id.
 */
export function assertOrdinaryToolFactGraph(
  state: {
    readonly runId: string;
    readonly pendingToolRound?: {
      readonly toolCallIds: readonly string[];
    };
    readonly pendingNestedToolCalls?: readonly {
      readonly callId: string;
      readonly factId: string;
      readonly parentToolCallFactId: string;
    }[];
    readonly toolCalls: readonly {
      readonly callId: string;
      readonly factId?: string;
      readonly parentToolCallFactId?: string;
    }[];
  },
): void {
  const pendingRootFactIds = new Set(state.pendingToolRound?.toolCallIds ?? []);
  const rootFactIds = new Set<string>(pendingRootFactIds);

  const nestedResults: Array<{
    readonly callId: string;
    readonly factId: string;
    readonly parentToolCallFactId: string;
  }> = [];
  for (const result of state.toolCalls) {
    if (result.parentToolCallFactId === undefined) {
      if (result.factId !== undefined && result.factId !== result.callId) {
        throw new OrdinaryFeatureError(
          "ordinary_tool_result_conflict",
          `Ordinary nested tool fact ${result.factId} must reference its parent root tool fact`,
        );
      }
      rootFactIds.add(toolCallFactId(result));
      continue;
    }
    if (result.factId === undefined || result.factId === result.callId) {
      throw new OrdinaryFeatureError(
        "ordinary_tool_result_conflict",
        `Ordinary nested tool result ${result.callId} must have a factId different from its provider callId`,
      );
    }
    nestedResults.push({
      callId: result.callId,
      factId: result.factId,
      parentToolCallFactId: result.parentToolCallFactId,
    });
  }

  const nestedFactIds = new Set(nestedResults.map((result) => result.factId));
  const pendingNestedFactIds = new Set<string>();
  for (const request of state.pendingNestedToolCalls ?? []) {
    if (request.factId === request.callId) {
      throw new OrdinaryFeatureError(
        "ordinary_tool_result_conflict",
        `Ordinary pending nested tool ${request.callId} must have a distinct fact identity`,
      );
    }
    if (pendingNestedFactIds.has(request.factId)) {
      throw new OrdinaryFeatureError(
        "ordinary_tool_result_conflict",
        `Ordinary pending nested tool fact ${request.factId} is duplicated`,
      );
    }
    pendingNestedFactIds.add(request.factId);
  }
  const allNestedFactIds = new Set([...nestedFactIds, ...pendingNestedFactIds]);
  for (const result of nestedResults) {
    if (rootFactIds.has(result.factId)) {
      throw new OrdinaryFeatureError(
        "ordinary_tool_result_conflict",
        `Ordinary nested tool fact ${result.factId} identity conflicts with a root tool fact`,
      );
    }
    if (allNestedFactIds.has(result.parentToolCallFactId)) {
      throw new OrdinaryFeatureError(
        "ordinary_tool_result_conflict",
        `Ordinary nested tool fact ${result.factId} cannot reference nested tool fact ${result.parentToolCallFactId} as its parent`,
      );
    }
    if (!rootFactIds.has(result.parentToolCallFactId)) {
      throw new OrdinaryFeatureError(
        "ordinary_tool_result_conflict",
        `Ordinary nested tool fact ${result.factId} references unknown root tool fact ${result.parentToolCallFactId} in run ${state.runId}`,
      );
    }
  }
  for (const request of state.pendingNestedToolCalls ?? []) {
    if (rootFactIds.has(request.factId)) {
      throw new OrdinaryFeatureError(
        "ordinary_tool_result_conflict",
        `Ordinary pending nested tool fact ${request.factId} conflicts with a root tool fact`,
      );
    }
    if (allNestedFactIds.has(request.parentToolCallFactId)) {
      throw new OrdinaryFeatureError(
        "ordinary_tool_result_conflict",
        `Ordinary pending nested tool fact ${request.factId} cannot reference nested parent ${request.parentToolCallFactId}`,
      );
    }
    if (!pendingRootFactIds.has(request.parentToolCallFactId)) {
      throw new OrdinaryFeatureError(
        "ordinary_tool_result_conflict",
        `Ordinary pending nested tool fact ${request.factId} references inactive root ${request.parentToolCallFactId}`,
      );
    }
    const result = nestedResults.find((item) => item.factId === request.factId);
    if (result !== undefined &&
        (result.callId !== request.callId || result.parentToolCallFactId !== request.parentToolCallFactId)) {
      throw new OrdinaryFeatureError(
        "ordinary_tool_result_conflict",
        `Ordinary nested tool fact ${request.factId} has conflicting request and result identities`,
      );
    }
  }
}

function requirePendingNestedToolCall(request: ToolCallRequest): OrdinaryPendingNestedToolCall {
  if (request.factId === undefined || request.parentToolCallFactId === undefined ||
      request.factId === request.callId) {
    throw new OrdinaryFeatureError(
      "ordinary_tool_result_conflict",
      `Ordinary nested tool request ${request.callId} is missing its scoped fact identity`,
    );
  }
  return cloneJson(request) as OrdinaryPendingNestedToolCall;
}

function toolResultMatchesPendingNestedCall(
  result: ToolCallResult,
  request: OrdinaryPendingNestedToolCall,
): boolean {
  return result.callId === request.callId && result.factId === request.factId &&
    result.parentToolCallFactId === request.parentToolCallFactId && result.toolName === request.toolName &&
    JSON.stringify(result.input) === JSON.stringify(request.input);
}

function withoutConfirmationRequest(
  result: ToolCallResult,
): Omit<ToolCallResult, "confirmationRequest" | "status"> {
  const { confirmationRequest: _confirmationRequest, status: _status, ...base } = result;
  return base;
}

export function ordinaryToolResultKey(result: ToolCallResult): string {
  return `${toolCallFactId(result)}:${result.status}`;
}

function mergeOrdinaryToolResults(
  existing: readonly ToolCallResult[],
  incoming: readonly ToolCallResult[],
): readonly ToolCallResult[] {
  const merged = existing.map(cloneJson);
  const indexes = new Map(merged.map((result, index) => [toolCallFactId(result), index] as const));
  const normalizedIncoming: ToolCallResult[] = [];
  const incomingIndexes = new Map<string, number>();
  for (const result of incoming) {
    const stored = cloneJson(result);
    const factId = toolCallFactId(stored);
    const duplicateIndex = incomingIndexes.get(factId);
    if (duplicateIndex === undefined) {
      incomingIndexes.set(factId, normalizedIncoming.length);
      normalizedIncoming.push(stored);
    } else {
      normalizedIncoming[duplicateIndex] = stored;
    }
  }
  for (const stored of normalizedIncoming) {
    const factId = toolCallFactId(stored);
    const index = indexes.get(factId);
    if (index === undefined) {
      indexes.set(factId, merged.length);
      merged.push(stored);
      continue;
    }
    const current = merged[index]!;
    if (JSON.stringify(current) === JSON.stringify(stored)) continue;
    if (current.status === "approval_required" && stored.status !== "approval_required") {
      merged[index] = stored;
      continue;
    }
    throw new OrdinaryFeatureError(
      "ordinary_tool_result_conflict",
      `Ordinary tool call ${stored.callId} already has a different resolved result`,
    );
  }
  return merged;
}

function eventForTransition(
  base: Omit<OrdinaryRunEvent, "type">,
  transition: OrdinaryRunTransition,
): OrdinaryRunEvent | undefined {
  switch (transition.type) {
    case "record_session_checkpoint":
      if (transition.checkpoint.kind === "compaction_entry_committed") {
        return {
            ...base,
            type: "context.compaction.completed",
            compactionEntryRef: cloneJson(transition.checkpoint.compactionEntryRef),
            tokensBefore: transition.checkpoint.tokensBefore,
          };
      }
      if ((transition.checkpoint.kind === "assistant_tool_call_entry_committed" ||
          transition.checkpoint.kind === "assistant_response_entry_committed") &&
          transition.modelRequestId !== undefined) {
        return {
          ...base,
          type: "model.output.completed",
          modelRequestId: transition.modelRequestId,
          assistantEntryRef: cloneJson(transition.checkpoint.assistantEntryRef),
        };
      }
      return undefined;
    case "start": return { ...base, type: "run.started" };
    case "record_reasoning": return {
      ...base,
      type: "model.reasoning.completed",
      modelRequestId: transition.modelRequestId,
      content: transition.content,
    };
    case "request_approval": return {
      ...base,
      type: "run.approval_requested",
      confirmationRequests: cloneJson(transition.status.confirmationRequests),
      toolCallIds: transition.toolCalls.map(toolCallFactId),
    };
    case "approval_decided": return {
      ...base,
      type: "run.approval_decided",
      decision: cloneJson(transition.decision),
    };
    case "complete": return { ...base, type: "run.completed", toolCallIds: transition.toolCalls.map(toolCallFactId) };
    case "fail": return {
      ...base,
      type: "run.failed",
      code: transition.error.code,
      toolCallIds: (transition.toolCalls ?? []).map(toolCallFactId),
    };
    case "cancel": return {
      ...base,
      type: "run.cancelled",
      reason: transition.reason,
      toolCallIds: (transition.toolCalls ?? []).map(toolCallFactId),
    };
    case "block": return { ...base, type: "run.blocked", code: transition.reason.code };
  }
}

function usageAfter(state: OrdinaryRunState, transition: OrdinaryRunTransition): ModelUsage {
  return "usage" in transition && transition.usage !== undefined
    ? cloneJson(transition.usage)
    : state.usage;
}

function capabilityResolutionAfter(
  state: OrdinaryRunState,
  transition: OrdinaryRunTransition,
): RunCapabilityResolution | undefined {
  return "capabilityResolution" in transition && transition.capabilityResolution !== undefined
    ? cloneJson(transition.capabilityResolution)
    : state.capabilityResolution;
}

function toolMetricsAfter(
  state: OrdinaryRunState,
  transition: OrdinaryRunTransition,
): OrdinaryToolMetricsSnapshot | undefined {
  return "toolMetrics" in transition && transition.toolMetrics !== undefined
    ? cloneJson(transition.toolMetrics)
    : state.toolMetrics;
}

function assertStatus(status: OrdinaryRunStatus, allowed: readonly OrdinaryRunStatus["kind"][], action: string): void {
  if (!allowed.includes(status.kind)) {
    throw new Error(`Cannot ${action} an Ordinary run in ${status.kind} status`);
  }
}

function isTerminal(status: OrdinaryRunStatus): boolean {
  return status.kind === "completed" || status.kind === "failed" ||
    status.kind === "cancelled" || status.kind === "blocked";
}

function nextSequence(events: readonly OrdinaryRunEvent[]): number {
  return (events.at(-1)?.sequence ?? 0) + 1;
}

function cloneJson<T>(value: T): T {
  return globalThis.structuredClone(value);
}