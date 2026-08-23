import type {
  OrdinaryPanelTaskStatus as AgentTaskStatus,
  PanelContextAttachment as ContextAttachment,
  OrdinaryPanelConfirmationRequest as OwnerScopedConfirmationRequest,
  OrdinaryPanelRunEvent as RunEvent,
  OrdinaryPanelTranscriptNode as TranscriptNode,
} from "../panel-api/ordinary-agent.js";
import type { ConfirmationRequest } from "../../domain/confirmation/index.js";
import { toolCallFactId } from "../../domain/tools/index.js";
import type { ConversationOwner } from "../../domain/execution-scope/index.js";
import type {
  OrdinaryConversationReadModel,
  OrdinaryConversationTurnReadModel,
  OrdinaryRunActivity,
  OrdinaryRunActivityCursor,
  OrdinaryRunActivityReplay,
  OrdinaryRunEvent,
  OrdinaryRunState,
} from "../ordinary-agent/contracts.js";
import { toolStreamDetail, toolSummary } from "../panel-read-model/run/panel-stream-tool-projection.js";
import { isConversationOwnerContextRef } from "../context/reference-origin.js";
import { workspaceFolderSummaryFromPath } from "../context/workspace-folder-summary.js";
import type {
  OrdinaryPanelRun,
  OrdinaryPanelCapabilityResolution,
  OrdinaryPanelConversation,
  OrdinaryPanelConversationPendingAction,
  OrdinaryPanelConversationStatus,
  OrdinaryPanelConversationSummary,
  OrdinaryPanelConversationTurn,
  OrdinaryPanelConversationTurnAttachment,
  OrdinaryPanelReplayCursor,
  OrdinaryPanelRunDetail,
  OrdinaryPanelRunView,
  OrdinaryPanelWorkView,
} from "../panel-api/ordinary-agent.js";

export type {
  OrdinaryPanelRun,
  OrdinaryPanelCapabilityResolution,
  OrdinaryPanelReplayCursor,
  OrdinaryPanelRunDetail,
  OrdinaryPanelRunView,
  OrdinaryPanelWorkView,
} from "../panel-api/ordinary-agent.js";

export type OrdinaryPanelActivityBatch = {
  readonly runId: string;
  readonly reset: boolean;
  readonly events: readonly RunEvent[];
  readonly cursor: OrdinaryPanelReplayCursor;
};

export class OrdinaryPanelCursorError extends Error {
  readonly name = "OrdinaryPanelCursorError";
  readonly code = "ordinary_panel_cursor_invalid" as const;
}

export function encodeOrdinaryPanelCursor(cursor: OrdinaryRunActivityCursor): string {
  return Buffer.from(JSON.stringify({ streamId: cursor.streamId, sequence: cursor.sequence }), "utf8")
    .toString("base64url");
}

export function parseOrdinaryPanelCursor(value: string | undefined): OrdinaryRunActivityCursor | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value.length > 1_024 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw invalidCursor();
  let raw: unknown;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw invalidCursor();
    raw = JSON.parse(decoded.toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof OrdinaryPanelCursorError) throw error;
    throw invalidCursor();
  }
  if (!isExactCursorRecord(raw)) throw invalidCursor();
  return { streamId: raw.streamId, sequence: raw.sequence };
}

export function projectOrdinaryPanelActivityBatch(input: {
  readonly run: OrdinaryRunState;
  readonly replay: OrdinaryRunActivityReplay;
}): OrdinaryPanelActivityBatch {
  return {
    runId: input.run.runId,
    reset: input.replay.reset,
    events: input.replay.activities.map((activity) => projectActivity(input.run, activity)),
    cursor: panelCursor(input.replay.cursor),
  };
}

export function projectOrdinaryPanelRunView(input: {
  readonly run: OrdinaryRunState;
  /** Complete current-generation activity history for the work view. */
  readonly fullReplay: OrdinaryRunActivityReplay;
  /** Requested incremental replay for the response cursor. */
  readonly replay?: OrdinaryRunActivityReplay;
}): OrdinaryPanelRunView {
  const fullEvents = input.fullReplay.activities.map((activity) => projectActivity(input.run, activity));
  const replay = input.replay ?? input.fullReplay;
  const run = projectOrdinaryRun(input.run, input.fullReplay.cursor, fullEvents.length);
  const pendingConfirmation = pendingConfirmationFrom(input.run);
  const completedAnswer = input.fullReplay.activities
    .filter((activity) => activity.type === "model.output.completed")
    .at(-1)?.content;
  if (input.run.status.kind === "completed" && completedAnswer === undefined) {
    throw new Error(`Completed Ordinary run ${input.run.runId} has no projected Session answer`);
  }
  const answer = input.run.status.kind === "completed"
    ? {
        title: "已回答",
        content: completedAnswer!,
        evidenceRefs: [],
        nextActions: [],
      }
    : undefined;
  const transcriptNodes = projectTranscriptNodes(input.run, input.fullReplay.activities);
  const contextAttachments = projectContextAttachments(input.run);
  const stage = workStage(input.run, fullEvents);
  const workView: OrdinaryPanelWorkView = {
    run,
    stage,
    headline: workHeadline(input.run),
    currentAction: currentAction(input.run),
    contextAttachments,
    pendingConfirmation,
    answer,
    deliverable: undefined,
    visibleEvents: fullEvents.filter((event) => isWorkViewEvent(input.run, event)),
    transcriptNodes,
    workSummary: {
      summary: workSummary(input.run.toolCalls.length, contextAttachments.length, pendingConfirmation !== undefined),
      pendingActionCount: pendingConfirmation === undefined ? 0 : 1,
      toolResultCount: input.run.toolCalls.length,
      contextAttachmentCount: contextAttachments.length,
    },
  };
  return {
    run,
    agentDefinitionRef: input.run.birth.agentDefinitionRef,
    capabilityResolution: projectCapabilityResolution(input.run.capabilityResolution),
    workView,
    detail: {
      runId: input.run.runId,
      status: run.status,
      error: runError(input.run),
      stopReason: stopReason(input.run),
      continuationAvailability: continuationAvailability(input.run),
      transcript: { transcriptNodes },
      toolResults: structuredClone(input.run.toolCalls),
      usage: structuredClone(input.run.usage),
    },
    replay: {
      reset: replay.reset,
      events: replay.activities.map((activity) => projectActivity(input.run, activity)),
      cursor: panelCursor(replay.cursor),
    },
  };
}

export function projectOrdinaryPanelConversation(input: {
  readonly conversation: OrdinaryConversationReadModel;
  readonly owner?: ConversationOwner;
  readonly spaceId?: string;
  readonly currentRun?: OrdinaryPanelRunView;
  readonly workspaceRun?: OrdinaryRunState;
}): OrdinaryPanelConversation {
  const turns = input.conversation.turns.map(projectConversationTurn);
  const activeAssistant = input.conversation.activeRunId === undefined
    ? undefined
    : input.conversation.turns.find((turn) =>
        turn.role === "assistant" && turn.runId === input.conversation.activeRunId);
  const pendingAction = pendingConversationAction(activeAssistant);
  const status = conversationStatus(activeAssistant ?? input.conversation.turns.at(-1));
  const latestText = [...turns].reverse().find((turn) => turn.content.length > 0)?.content ?? "";
  return {
    conversationId: input.conversation.conversationId,
    owner: input.owner,
    spaceId: input.spaceId,
    title: input.conversation.title,
    titleEditedAt: input.conversation.titleEditedAt,
    preview: compact(latestText, 180),
    currentAction: conversationCurrentAction(status, pendingAction, input.currentRun),
    nextStep: conversationNextStep(status),
    createdAt: input.conversation.createdAt,
    updatedAt: input.conversation.updatedAt,
    pinnedAt: input.conversation.pinnedAt,
    status,
    activeRunId: input.conversation.activeRunId,
    latestRunId: input.conversation.latestRunId,
    workspaceFolder: workspaceFolderSummaryFromPath(
      input.workspaceRun?.birth.capabilitySnapshot.executionRoot,
      input.workspaceRun?.birth.workspaceSelection ?? "default",
    ),
    requiresUserAction: pendingAction !== undefined,
    pendingAction,
    queuedRunIds: input.conversation.queuedRunIds,
    queuedRunCount: input.conversation.queuedRunIds.length,
    currentRun: input.currentRun,
    turns,
  };
}

export function projectOrdinaryPanelConversationSummary(
  conversation: OrdinaryConversationReadModel,
  workspaceRun?: OrdinaryRunState,
  spaceId?: string,
  owner?: ConversationOwner,
): OrdinaryPanelConversationSummary {
  const { turns: _turns, currentRun: _currentRun, ...summary } = projectOrdinaryPanelConversation({
    conversation,
    owner,
    workspaceRun,
    spaceId,
  });
  return summary;
}

function projectCapabilityResolution(
  resolution: OrdinaryRunState["capabilityResolution"],
): OrdinaryPanelCapabilityResolution | undefined {
  if (resolution === undefined) return undefined;
  if (resolution.runMode !== "agent") {
    throw new Error("Ordinary capability resolution must use agent mode");
  }
  return structuredClone(resolution) as OrdinaryPanelCapabilityResolution;
}

function projectOrdinaryRun(
  state: OrdinaryRunState,
  cursor: OrdinaryRunActivityCursor,
  eventCount: number,
): OrdinaryPanelRun {
  return {
    runId: state.runId,
    conversationId: state.turn.conversationId,
    title: compact(state.input.userMessage, 120),
    goalSummary: compact(state.input.userMessage, 240),
    status: panelStatus(state),
    runMode: "agent",
    agentDefinitionRef: state.birth.agentDefinitionRef,
    createdAt: state.timestamps.createdAt,
    updatedAt: state.timestamps.updatedAt,
    currentStep: currentAction(state) || undefined,
    nextStep: nextStep(state) || undefined,
    requiresUserAction: state.status.kind === "awaiting_approval",
    eventCursor: { lastSequence: cursor.sequence, eventCount },
  };
}

function projectActivity(run: OrdinaryRunState, activity: OrdinaryRunActivity): RunEvent {
  if (activity.type === "tool.requested" || activity.type === "tool.progress") {
    const payload = liveToolPayload(activity);
    return {
      id: activity.activityId,
      runId: activity.runId,
      sequence: activity.sequence,
      type: activity.type,
      title: "",
      summary: toolSummary("tool.requested", payload),
      status: "running",
      timestamp: activity.recordedAt,
      toolName: activity.request.toolName,
      parentToolCallFactId: activity.request.parentToolCallFactId,
      refs: [{ kind: "tool_call", id: toolCallFactId(activity.request) }],
      visibility: "compact",
      detail: toolStreamDetail("tool.requested", payload),
    };
  }
  if (activity.type === "tool.result") {
    const type = activity.result.status === "completed"
      ? "tool.completed"
      : activity.result.status === "cancelled" ? "tool.cancelled" : "tool.failed";
    const payload = {
      callId: activity.result.callId,
      toolName: activity.result.toolName,
      input: activity.result.input,
      output: activity.result.output,
      error: activity.result.error,
      errorDomain: activity.result.errorDomain,
      errorFacts: activity.result.errorFacts,
      failureAttribution: activity.result.failureAttribution,
      delegatedExecution: activity.result.delegatedExecution,
    };
    return {
      id: activity.activityId,
      runId: activity.runId,
      sequence: activity.sequence,
      type,
      title: "",
      summary: toolSummary(type, payload),
      status: activity.result.status === "completed"
        ? "completed"
        : activity.result.status === "cancelled" ? "cancelled" : "failed",
      timestamp: activity.recordedAt,
      toolName: activity.result.toolName,
      parentToolCallFactId: activity.result.parentToolCallFactId,
      refs: [{ kind: "tool_call", id: toolCallFactId(activity.result) }],
      visibility: "compact",
      detail: toolStreamDetail(type, payload),
    };
  }
  if (activity.type === "model.output.delta") {
    return {
      id: activity.activityId,
      runId: activity.runId,
      sequence: activity.sequence,
      type: activity.type,
      title: "",
      delta: activity.delta,
      status: "running",
      timestamp: activity.recordedAt,
      refs: [{ kind: "model_call", id: activity.modelRequestId }],
      visibility: "compact",
    };
  }
  if (activity.type === "model.output.completed") {
    return {
      id: activity.activityId,
      runId: activity.runId,
      sequence: activity.sequence,
      type: activity.type,
      title: "",
      delta: activity.content,
      status: "completed",
      timestamp: activity.recordedAt,
      refs: [{ kind: "model_call", id: activity.modelRequestId }],
      visibility: "compact",
    };
  }
  if (activity.type === "model.reasoning.delta") {
    return {
      id: activity.activityId,
      runId: activity.runId,
      sequence: activity.sequence,
      type: activity.type,
      title: "思考",
      delta: activity.delta,
      status: "running",
      timestamp: activity.recordedAt,
      refs: [{ kind: "model_call", id: activity.modelRequestId }],
      visibility: "compact",
    };
  }
  if (activity.type === "model.request") {
    return {
      id: activity.activityId,
      runId: activity.runId,
      sequence: activity.sequence,
      type: "model.requested",
      title: "",
      summary: modelRequestSummary(activity.reason),
      status: "running",
      timestamp: activity.recordedAt,
      refs: [{ kind: "model_call", id: activity.activityId }],
      visibility: "compact",
    };
  }
  return projectTransition(run, activity, activity.event);
}

function projectTransition(
  run: OrdinaryRunState,
  activity: OrdinaryRunActivity,
  event: OrdinaryRunEvent,
): RunEvent {
  const base = {
    id: activity.activityId,
    runId: activity.runId,
    sequence: activity.sequence,
    timestamp: activity.recordedAt,
    refs: [{ kind: "event" as const, id: event.eventId }],
    visibility: "compact" as const,
  };
  switch (event.type) {
    case "run.created": return { ...base, type: event.type, title: "", status: "queued" };
    case "run.started": return { ...base, type: event.type, title: "", status: "running" };
    case "model.output.completed": return {
      ...base, type: event.type, title: "", status: "completed",
      refs: [{ kind: "model_call", id: event.modelRequestId }],
    };
    case "model.reasoning.completed": return {
      ...base,
      type: event.type,
      title: "思考",
      delta: event.content,
      status: "completed",
      refs: [{ kind: "model_call", id: event.modelRequestId }],
    };
    case "context.compaction.completed": return {
      ...base,
      type: event.type,
      title: "整理上下文",
      summary: "上下文压缩完成",
      status: "completed",
    };
    case "run.approval_requested": {
      const request = event.confirmationRequests[0];
      return {
        ...base,
        type: "confirmation.needed",
        title: request?.title ?? "待确认",
        summary: request?.actionSummary,
        status: "approval_needed",
      };
    }
    case "run.approval_decided": return {
      ...base,
      type: event.decision.decision === "guidance" ? "user.guidance" : "user_approval.received",
      title: "",
      summary: event.decision.guidance,
      status: "running",
    };
    case "run.completed": return {
      ...base,
      type: "final.result",
      title: "已回答",
      summary: undefined,
      status: "completed",
    };
    case "run.failed": return {
      ...base,
      type: event.type,
      title: "未完成",
      summary: run.status.kind === "failed" ? run.status.error.message : event.code,
      status: "failed",
    };
    case "run.cancelled": return {
      ...base,
      type: event.type,
      title: "已取消",
      summary: event.reason,
      status: "cancelled",
    };
    case "run.blocked": return {
      ...base,
      type: event.type,
      title: "需要处理",
      summary: run.status.kind === "blocked" ? run.status.reason.message : event.code,
      status: "blocked",
    };
  }
}

function projectTranscriptNode(run: OrdinaryRunState, activity: OrdinaryRunActivity): TranscriptNode {
  const event = projectActivity(run, activity);
  if (activity.type === "tool.requested" || activity.type === "tool.progress") {
    return {
      nodeId: activity.activityId,
      runId: activity.runId,
      sequence: activity.sequence,
      // Progress replaces the requested live row instead of creating a log entry.
      eventType: "tool.requested",
      kind: "tool",
      phase: "executing",
      title: "",
      summary: event.summary,
      timestamp: activity.recordedAt,
      toolName: activity.request.toolName,
      parentToolCallFactId: activity.request.parentToolCallFactId,
      display: toolStreamDetail("tool.requested", liveToolPayload(activity)).display,
      refs: event.refs,
    };
  }
  if (activity.type === "tool.result") {
    return {
      nodeId: activity.activityId,
      runId: activity.runId,
      sequence: activity.sequence,
      eventType: event.type,
      kind: "tool",
      phase: activity.result.status === "completed"
        ? "completed"
        : activity.result.status === "cancelled" ? "cancelled" : "failed",
      title: "",
      summary: event.summary,
      timestamp: activity.recordedAt,
      toolName: activity.result.toolName,
      failureAttribution: activity.result.failureAttribution,
      error: activity.result.error,
      parentToolCallFactId: activity.result.parentToolCallFactId,
      delegatedExecution: activity.result.delegatedExecution,
      display: toolStreamDetail(
        event.type === "tool.completed"
          ? "tool.completed"
          : event.type === "tool.cancelled" ? "tool.cancelled" : "tool.failed",
        {
          callId: activity.result.callId,
          toolName: activity.result.toolName,
          input: activity.result.input,
          output: activity.result.output,
          error: activity.result.error,
          errorDomain: activity.result.errorDomain,
          errorFacts: activity.result.errorFacts,
          failureAttribution: activity.result.failureAttribution,
          delegatedExecution: activity.result.delegatedExecution,
        },
      ).display,
      refs: event.refs,
    };
  }
  if (activity.type === "model.output.delta") {
    return {
      nodeId: activity.activityId,
      runId: activity.runId,
      sequence: activity.sequence,
      eventType: activity.type,
      kind: "body",
      phase: "executing",
      title: "",
      text: activity.delta,
      timestamp: activity.recordedAt,
      refs: event.refs,
    };
  }
  if (activity.type === "model.output.completed") {
    return {
      nodeId: activity.activityId,
      runId: activity.runId,
      sequence: activity.sequence,
      eventType: activity.type,
      kind: "body",
      phase: "completed",
      title: "",
      text: activity.content,
      timestamp: activity.recordedAt,
      refs: event.refs,
    };
  }
  if (activity.type === "model.reasoning.delta") {
    return {
      nodeId: activity.activityId,
      runId: activity.runId,
      sequence: activity.sequence,
      eventType: activity.type,
      kind: "thinking",
      phase: "noted",
      title: "思考",
      summary: compact(activity.delta, 180),
      text: activity.delta,
      timestamp: activity.recordedAt,
      refs: event.refs,
    };
  }
  if (activity.type === "model.request") {
    return {
      nodeId: activity.activityId,
      runId: activity.runId,
      sequence: activity.sequence,
      eventType: "model.requested",
      kind: "system",
      phase: "executing",
      title: "",
      summary: modelRequestSummary(activity.reason),
      timestamp: activity.recordedAt,
      refs: event.refs,
    };
  }
  const confirmation = activity.event.type === "run.approval_requested"
    ? ownerScopedConfirmation(activity.runId, activity.event.confirmationRequests[0])
    : undefined;
  return {
    nodeId: activity.activityId,
    runId: activity.runId,
    sequence: activity.sequence,
    eventType: event.type,
    kind: transcriptKind(activity.event),
    phase: transcriptPhase(activity.event),
    title: event.title,
    summary: event.summary,
    text: activity.event.type === "model.reasoning.completed" ? activity.event.content : undefined,
    timestamp: activity.recordedAt,
    confirmation,
    modelUsage: activity.event.type === "run.approval_requested" ||
      activity.event.type === "run.completed" ||
      activity.event.type === "run.failed" ||
      activity.event.type === "run.cancelled"
      ? structuredClone(run.usage)
      : undefined,
    refs: event.refs,
  };
}

function projectTranscriptNodes(
  run: OrdinaryRunState,
  activities: readonly OrdinaryRunActivity[],
): readonly TranscriptNode[] {
  // Output deltas are transport fragments. Keep their exact text in the replay
  // stream, but expose one logical body node to the transcript read-model.
  const nodes: TranscriptNode[] = [];
  let outputDeltas: Array<Extract<OrdinaryRunActivity, { readonly type: "model.output.delta" }>> = [];
  let reasoningDeltas: Array<Extract<OrdinaryRunActivity, { readonly type: "model.reasoning.delta" }>> = [];
  const flushOutputDeltas = (): void => {
    const first = outputDeltas[0];
    if (first === undefined) return;
    const node = projectTranscriptNode(run, first);
    nodes.push({
      ...node,
      text: outputDeltas.map((activity) => activity.delta).join(""),
    });
    outputDeltas = [];
  };
  const flushReasoningDeltas = (): void => {
    const first = reasoningDeltas[0];
    if (first === undefined) return;
    const node = projectTranscriptNode(run, first);
    nodes.push({
      ...node,
      summary: compact(reasoningDeltas.map((activity) => activity.delta).join(""), 180),
      text: reasoningDeltas.map((activity) => activity.delta).join(""),
    });
    reasoningDeltas = [];
  };

  for (const activity of activities) {
    if (activity.type === "model.output.delta") {
      flushReasoningDeltas();
      if (outputDeltas[0]?.modelRequestId !== undefined &&
          outputDeltas[0].modelRequestId !== activity.modelRequestId) {
        flushOutputDeltas();
      }
      outputDeltas.push(activity);
      continue;
    }
    if (activity.type === "model.reasoning.delta") {
      flushOutputDeltas();
      if (reasoningDeltas[0]?.modelRequestId !== undefined &&
          reasoningDeltas[0].modelRequestId !== activity.modelRequestId) {
        flushReasoningDeltas();
      }
      reasoningDeltas.push(activity);
      continue;
    }
    flushOutputDeltas();
    flushReasoningDeltas();
    if (isTranscriptActivity(run, activity)) {
      nodes.push(projectTranscriptNode(run, activity));
    }
  }
  flushOutputDeltas();
  flushReasoningDeltas();
  return nodes;
}

function isTranscriptActivity(run: OrdinaryRunState, activity: OrdinaryRunActivity): boolean {
  if (activity.type === "model.output.delta" || activity.type === "model.reasoning.delta") return false;
  if (activity.type === "run.transition" && isQuietInterruption(run) &&
      (activity.event.type === "run.cancelled" || activity.event.type === "run.blocked")) {
    return false;
  }
  return activity.type === "model.output.completed" || activity.type === "model.request" ||
    activity.type === "tool.requested" ||
    activity.type === "tool.progress" || activity.type === "tool.result" ||
    (activity.type === "run.transition" &&
      activity.event.type !== "run.created" && activity.event.type !== "run.started");
}

function liveToolPayload(
  activity: Extract<OrdinaryRunActivity, { readonly type: "tool.requested" | "tool.progress" }>,
): Readonly<Record<string, unknown>> {
  const output = activity.type === "tool.progress" && activity.progress.kind === "command_output"
    ? {
        stdout: activity.progress.stdoutTail,
        stderr: activity.progress.stderrTail,
        stdoutChars: activity.progress.stdoutChars,
        stderrChars: activity.progress.stderrChars,
      }
    : undefined;
  return {
    callId: activity.request.callId,
    toolName: activity.request.toolName,
    input: activity.request.input,
    output,
  };
}

function isWorkViewEvent(run: OrdinaryRunState, event: RunEvent): boolean {
  if (isQuietInterruption(run) && (event.type === "run.cancelled" || event.type === "run.blocked")) {
    return false;
  }
  return event.type !== "run.created" && event.type !== "run.started" &&
    event.type !== "model.output.delta" && event.type !== "final.result";
}

function transcriptKind(event: OrdinaryRunEvent): TranscriptNode["kind"] {
  if (event.type === "model.output.completed") return "body";
  if (event.type === "model.reasoning.completed") return "thinking";
  if (event.type === "run.approval_requested") return "confirmation";
  if (event.type === "run.approval_decided") return "user_decision";
  if (event.type === "run.completed") return "answer";
  return "system";
}

function transcriptPhase(event: OrdinaryRunEvent): TranscriptNode["phase"] {
  switch (event.type) {
    case "run.created": return "noted";
    case "run.started": return "executing";
    case "model.output.completed": return "completed";
    case "model.reasoning.completed": return "completed";
    case "context.compaction.completed": return "completed";
    case "run.approval_requested": return "waiting_approval";
    case "run.approval_decided": return event.decision.decision === "deny"
      ? "denied"
      : event.decision.decision === "guidance" ? "guidance" : "approved";
    case "run.completed": return "completed";
    case "run.failed": return "failed";
    case "run.cancelled": return "cancelled";
    case "run.blocked": return "blocked";
  }
}

function projectContextAttachments(run: OrdinaryRunState): readonly ContextAttachment[] {
  const permissionRefs = run.input.context?.permissionBoundaryRefs ?? [];
  return (run.input.context?.contextRefs ?? []).map((ref, index) => ({
    attachmentId: ref.attachmentId ?? `${run.runId}:context:${index}`,
    kind: ref.kind,
    ref: ref.ref,
    title: ref.title ?? attachmentTitle(ref.kind, ref.ref),
    summary: ref.summary ?? ref.ref,
    readonlyPreview: ref.readonlyPreview === undefined
      ? undefined
      : {
          title: ref.readonlyPreview.title,
          text: ref.readonlyPreview.text,
          truncated: ref.metadata?.truncated ?? false,
        },
    permissionRefs,
    readonlyPreviewMeta: {
      available: ref.metadata?.available ?? true,
      title: ref.title ?? ref.readonlyPreview?.title,
      byteLength: ref.metadata?.byteLength,
      mimeType: ref.metadata?.mimeType,
      truncated: ref.metadata?.truncated,
    },
    status: ref.metadata?.available === false ? "blocked" : "ready",
    warning: ref.metadata?.available === false ? "��上下文当前不可用。" : undefined,
  }));
}

function projectConversationTurn(turn: OrdinaryConversationTurnReadModel): OrdinaryPanelConversationTurn {
  if (turn.role === "user") {
    return {
      turnId: turn.turnId,
      role: turn.role,
      title: "你的消息",
      content: turn.content,
      status: turn.status,
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt,
      runId: turn.runId,
      attachments: projectConversationAttachments(turn),
    };
  }
  return {
    turnId: turn.turnId,
    role: turn.role,
    title: "",
    content: turn.content,
    status: conversationTurnStatus(turn.status),
    interruption: turn.interruption,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    runId: turn.runId,
    responseModel: {
      profileId: turn.model.profileId,
      label: turn.model.label,
      providerKind: turn.model.providerKind,
      protocolKind: turn.model.protocolKind,
      baseUrl: turn.model.baseUrl,
      model: turn.model.model,
    },
  };
}

function projectConversationAttachments(
  turn: Extract<OrdinaryConversationTurnReadModel, { readonly role: "user" }>,
): readonly OrdinaryPanelConversationTurnAttachment[] | undefined {
  const attachments = (turn.input.context?.contextRefs ?? [])
    .filter((ref) => !isConversationOwnerContextRef(ref))
    .map((ref): OrdinaryPanelConversationTurnAttachment => ({
      attachmentId: ref.attachmentId ?? ref.ref,
      kind: ref.kind,
      title: ref.title ?? attachmentTitle(ref.kind, ref.ref),
      summary: ref.summary,
      readonlyPreviewMeta: {
        available: ref.metadata?.available,
        title: ref.title ?? ref.readonlyPreview?.title,
        byteLength: ref.metadata?.byteLength,
        mimeType: ref.metadata?.mimeType,
        truncated: ref.metadata?.truncated,
      },
      mediaPreview: ref.attachmentId !== undefined && ref.metadata?.mimeType?.startsWith("image/")
        ? {
            kind: "image",
            url: `/api/context/attachments/media/${encodeURIComponent(ref.attachmentId)}`,
            mimeType: ref.metadata.mimeType,
            byteLength: ref.metadata.byteLength,
          }
        : undefined,
    }));
  return attachments.length === 0 ? undefined : attachments;
}

function pendingConfirmationFrom(run: OrdinaryRunState): OwnerScopedConfirmationRequest | undefined {
  if (run.status.kind !== "awaiting_approval") return undefined;
  const request = run.status.confirmationRequests[0];
  return ownerScopedConfirmation(run.runId, request);
}

function ownerScopedConfirmation(
  ownerRunId: string,
  request: ConfirmationRequest | undefined,
): OwnerScopedConfirmationRequest | undefined {
  return request === undefined
    ? undefined
    : { ...structuredClone(request), ownerRunId };
}

function panelStatus(run: OrdinaryRunState): AgentTaskStatus {
  return run.status.kind === "awaiting_approval" ? "approval_needed" : run.status.kind;
}

function conversationTurnStatus(
  status: Extract<OrdinaryConversationTurnReadModel, { readonly role: "assistant" }>["status"],
): OrdinaryPanelConversationTurn["status"] {
  if (status === "queued") return "pending";
  if (status === "awaiting_approval") return "running";
  return status;
}

function conversationStatus(
  turn: OrdinaryConversationTurnReadModel | undefined,
): OrdinaryPanelConversationStatus {
  if (turn === undefined) return "idle";
  if (turn.role === "user") return turn.status === "pending" ? "pending" : "idle";
  if (turn.status === "queued") return "pending";
  if (turn.status === "awaiting_approval") return "approval_needed";
  return turn.status;
}

function pendingConversationAction(
  turn: OrdinaryConversationTurnReadModel | undefined,
): OrdinaryPanelConversationPendingAction | undefined {
  if (turn?.role !== "assistant" || turn.status !== "awaiting_approval") return undefined;
  return { kind: "approval", runId: turn.runId, assistantTurnId: turn.turnId };
}

function workStage(run: OrdinaryRunState, events: readonly RunEvent[]): OrdinaryPanelWorkView["stage"] {
  switch (run.status.kind) {
    case "queued": return "queued";
    case "awaiting_approval": return "awaiting_approval";
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "blocked": return "blocked";
    case "running": return events.at(-1)?.type === "model.output.delta" ? "composing_result" : "understanding";
  }
}

function workHeadline(run: OrdinaryRunState): string {
  if (isQuietInterruption(run)) return "";
  switch (run.status.kind) {
    case "awaiting_approval": return "待处理";
    case "completed": return "已回答";
    case "failed": return "未完成";
    case "cancelled": return "已取消";
    case "blocked": return "需要处理";
    default: return "";
  }
}

function currentAction(run: OrdinaryRunState): string {
  if (isQuietInterruption(run)) return "";
  if (run.status.kind === "awaiting_approval") {
    return run.status.confirmationRequests[0]?.actionSummary ?? "等待确认";
  }
  if (run.status.kind === "running") return "正在处理";
  if (run.status.kind === "queued") return "等待上一轮完成";
  if (run.status.kind === "failed") return run.status.error.message;
  if (run.status.kind === "blocked") return run.status.reason.message;
  return "";
}

function nextStep(run: OrdinaryRunState): string {
  if (run.status.kind === "queued") return "上一轮完成后继续";
  if (run.status.kind === "awaiting_approval") return "等待你的决定";
  if (run.status.kind === "running") return "继续运行";
  return "";
}

function runError(run: OrdinaryRunState): { readonly code: string; readonly message: string } | undefined {
  if (run.status.kind === "failed") return structuredClone(run.status.error);
  if (run.status.kind === "blocked") return structuredClone(run.status.reason);
  if (run.status.kind === "cancelled") return { code: "run_cancelled", message: run.status.reason };
  return undefined;
}

function stopReason(run: OrdinaryRunState): string | undefined {
  if (run.status.kind === "awaiting_approval") return "approval_required";
  if (run.status.kind === "completed") return "completed";
  if (run.status.kind === "failed") return run.status.error.code;
  if (run.status.kind === "blocked") return run.status.reason.code;
  if (run.status.kind === "cancelled") return "cancelled";
  return undefined;
}

function isQuietInterruption(run: OrdinaryRunState): boolean {
  return run.status.kind === "cancelled" || (
    run.status.kind === "blocked" && (
      run.status.reason.code === "execution_continuation_lost" ||
      run.status.reason.code === "confirmation_continuation_lost"
    )
  );
}

function continuationAvailability(run: OrdinaryRunState): OrdinaryPanelRunDetail["continuationAvailability"] {
  if (run.status.kind === "awaiting_approval") return "live";
  if (run.status.kind === "blocked") {
    return run.status.reason.code === "confirmation_continuation_lost" ? "lost_after_restart" : "new_turn";
  }
  return "none";
}

function conversationCurrentAction(
  status: OrdinaryPanelConversationStatus,
  pending: OrdinaryPanelConversationPendingAction | undefined,
  currentRun: OrdinaryPanelRunView | undefined,
): string {
  if (pending !== undefined) return currentRun?.workView.pendingConfirmation?.actionSummary ?? "等待确认";
  if (status === "running") return currentRun?.workView.currentAction ?? "正在处理";
  if (status === "pending") return "等待处理";
  return "";
}

function conversationNextStep(status: OrdinaryPanelConversationStatus): string {
  if (status === "approval_needed") return "等待你的决定";
  if (status === "running" || status === "pending") return "继续运行";
  return "";
}

function workSummary(toolCount: number, contextCount: number, pending: boolean): string {
  const parts = [
    contextCount > 0 ? `上下文 ${contextCount}` : undefined,
    toolCount > 0 ? `工具结果 ${toolCount}` : undefined,
    pending ? "待处理 1" : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? "本轮没有额外上下文。" : parts.join("；");
}

function modelRequestSummary(reason: "initial" | "after_tool" | "after_approval"): string {
  if (reason === "after_tool") return "分析工具结果";
  if (reason === "after_approval") return "继续处理确认结果";
  return "思考中";
}

function attachmentTitle(kind: "workspace" | "file" | "project" | "web", ref: string): string {
  const value = ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref;
  if (kind === "workspace") return "当前工作区";
  if (kind === "file") return value.split(/[\\/]/u).at(-1) || value;
  return value;
}

function panelCursor(cursor: OrdinaryRunActivityCursor): OrdinaryPanelReplayCursor {
  return { token: encodeOrdinaryPanelCursor(cursor), lastSequence: cursor.sequence };
}

function isExactCursorRecord(value: unknown): value is { readonly streamId: string; readonly sequence: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  return keys.length === 2 && keys[0] === "sequence" && keys[1] === "streamId" &&
    typeof record.streamId === "string" && record.streamId.length > 0 &&
    typeof record.sequence === "number" && Number.isSafeInteger(record.sequence) && record.sequence >= 0;
}

function invalidCursor(): OrdinaryPanelCursorError {
  return new OrdinaryPanelCursorError("Ordinary activity cursor is invalid.");
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
