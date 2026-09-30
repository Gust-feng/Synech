import type {
  OrdinaryPanelRunEvent as RunEvent,
  OrdinaryPanelTranscriptNode as TranscriptNode,
} from "../../panel-api/ordinary-agent.js";
import { toolInvocationId } from "../../../domain/tools/index.js";
import type {
  OrdinaryRunActivity,
  OrdinaryRunEvent,
  OrdinaryRunState,
} from "../../ordinary-agent/contracts.js";
import { toolStreamDetail, toolSummary } from "../../panel-api/read-model/run/panel-stream-tool-projection.js";
import {
  isQuietInterruption,
  modelRequestSummary,
  ownerScopedConfirmation,
} from "./ordinary-run-projection.js";

export function projectOrdinaryActivity(run: OrdinaryRunState, activity: OrdinaryRunActivity): RunEvent {
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
      parentInvocationId: activity.request.parentInvocationId,
      refs: [{ kind: "tool_call", id: toolInvocationId(activity.request) }],
      visibility: "compact",
      detail: toolStreamDetail("tool.requested", payload),
    };
  }
  if (activity.type === "tool.result") {
    const type = activity.result.status === "completed"
      ? "tool.completed"
      : activity.result.status === "cancelled" ? "tool.cancelled" : "tool.failed";
    const payload = {
      callId: activity.result.providerCallId,
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
      parentInvocationId: activity.result.parentInvocationId,
      refs: [{ kind: "tool_call", id: toolInvocationId(activity.result) }],
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
      contentIndex: activity.contentIndex,
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
      contentIndex: activity.contentIndex,
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
      contentIndex: event.contentIndex,
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
      title: "",
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
  const event = projectOrdinaryActivity(run, activity);
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
      parentInvocationId: activity.request.parentInvocationId,
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
      parentInvocationId: activity.result.parentInvocationId,
      delegatedExecution: activity.result.delegatedExecution,
      display: toolStreamDetail(
        event.type === "tool.completed"
          ? "tool.completed"
          : event.type === "tool.cancelled" ? "tool.cancelled" : "tool.failed",
        {
          callId: activity.result.providerCallId,
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
      contentIndex: activity.contentIndex,
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
      contentIndex: activity.contentIndex,
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
    contentIndex: activity.event.type === "model.reasoning.completed" ? activity.event.contentIndex : undefined,
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

export function projectOrdinaryTranscriptNodes(
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
          (outputDeltas[0].modelRequestId !== activity.modelRequestId || outputDeltas[0].contentIndex !== activity.contentIndex)) {
        flushOutputDeltas();
      }
      outputDeltas.push(activity);
      continue;
    }
    if (activity.type === "model.reasoning.delta") {
      flushOutputDeltas();
      if (reasoningDeltas[0]?.modelRequestId !== undefined &&
          (reasoningDeltas[0].modelRequestId !== activity.modelRequestId || reasoningDeltas[0].contentIndex !== activity.contentIndex)) {
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
    callId: activity.request.providerCallId,
    toolName: activity.request.toolName,
    input: activity.request.input,
    output,
  };
}

export function isOrdinaryWorkViewEvent(run: OrdinaryRunState, event: RunEvent): boolean {
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

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
