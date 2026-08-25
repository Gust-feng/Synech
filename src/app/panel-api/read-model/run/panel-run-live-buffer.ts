import {
  appendTextStreamAssembly,
  emptyTextStreamAssembly,
  textStreamFragmentSourceFromEventId,
  type TextStreamAssembly,
} from "../transcript/readable-text-fragments.js";
import type { ToolDisplayProjection } from "../../tool-display.js";

export type LiveRunBuffer = {
  readonly runId: string;
  readonly turns: readonly LiveModelTurnBuffer[];
  readonly tools: readonly LiveToolActivity[];
  readonly appliedEventKeys: readonly string[];
};

export type LiveToolActivity = {
  readonly invocationId: string;
  readonly nodeId: string;
  readonly sequence: number;
  readonly toolName?: string;
  readonly summary?: string;
  readonly timestamp: string;
  readonly display?: ToolDisplayProjection;
  readonly parentInvocationId?: string;
  readonly refs: RunEventLike["refs"];
};

export type LiveModelTurnBuffer = {
  readonly requestId: string;
  /** First observed sequence for this model request; groups its content blocks. */
  readonly requestStartSequence: number;
  readonly contentIndex: number;
  /** First observed sequence for this block; later deltas do not reorder it. */
  readonly outputStartSequence?: number;
  readonly output: TextStreamAssembly;
  readonly outputSequence?: number;
  readonly outputCompleted?: boolean;
  readonly sideText: string;
  readonly sideTextSequence?: number;
  readonly reasoning: TextStreamAssembly;
  /** First observed sequence for this reasoning block. */
  readonly reasoningStartSequence?: number;
  readonly reasoningSequence?: number;
  readonly reasoningCompleted: boolean;
  readonly modelRefs: readonly string[];
  readonly updatedAtSequence: number;
};

type RunEventLike = {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly type: string;
  readonly contentIndex?: number;
  readonly timestamp?: string;
  readonly toolName?: string;
  readonly parentInvocationId?: string;
  readonly summary?: string;
  readonly delta?: string;
  readonly refs: readonly {
    readonly kind: string;
    readonly id: string;
  }[];
  readonly detail?: {
    readonly preview?: string;
    readonly display?: ToolDisplayProjection;
  };
};

export function emptyLiveRun(runId: string): LiveRunBuffer {
  return {
    runId,
    turns: [],
    tools: [],
    appliedEventKeys: [],
  };
}

export function liveRunHasVisibleText(live: LiveRunBuffer | undefined): boolean {
  return live?.turns.some((turn) =>
    turn.output.text.trim().length > 0 ||
    turn.sideText.trim().length > 0 ||
    turn.reasoning.text.trim().length > 0
  ) === true;
}

export function appendLiveRunEvents(
  runId: string,
  previous: LiveRunBuffer | undefined,
  events: readonly RunEventLike[]
): LiveRunBuffer {
  return events.reduce((current, event) => appendLiveRunEvent(runId, current, event), previous?.runId === runId ? previous : emptyLiveRun(runId));
}

export function appendLiveRunEvent(
  runId: string,
  previous: LiveRunBuffer | undefined,
  event: RunEventLike
): LiveRunBuffer {
  const current = previous?.runId === runId ? previous : emptyLiveRun(runId);
  const eventKey = liveRunEventKey(event);
  if (current.appliedEventKeys.includes(eventKey)) {
    return current;
  }
  const nextRun = {
    ...current,
    appliedEventKeys: [...current.appliedEventKeys, eventKey],
  };
  const requestId = liveModelRequestId(event) ?? current.turns.at(-1)?.requestId ?? "unknown";
  const requestTurns = nextRun.turns.filter((item) => item.requestId === requestId);
  // A completion/settlement event may omit contentIndex. Resolve it only from
  // this request's blocks; the last global turn can belong to another request.
  const contentIndex = event.contentIndex ?? requestTurns.at(-1)?.contentIndex ?? 0;
  const observedSequence = event.sequence > 0 ? event.sequence : nextRun.appliedEventKeys.length;
  const requestStartSequence = requestTurns[0]?.requestStartSequence ?? observedSequence;
  const turn = nextRun.turns.find((item) => item.requestId === requestId && item.contentIndex === contentIndex) ??
    emptyLiveModelTurn(requestId, contentIndex, requestStartSequence);
  const modelRefs = uniqueStrings([
    ...turn.modelRefs,
    ...event.refs.filter((ref) => ref.kind === "model_call").map((ref) => ref.id),
  ]);
  if (event.type === "model.output.delta") {
    return withLiveModelTurn(nextRun, {
      ...turn,
      requestStartSequence,
      output: appendLiveTextFragment(turn.output, event.delta ?? "", event),
      outputStartSequence: turn.outputStartSequence ?? event.sequence,
      outputSequence: Math.max(turn.outputSequence ?? 0, event.sequence),
      outputCompleted: turn.outputCompleted,
      reasoningCompleted: turn.reasoning.text.trim().length > 0 ? true : turn.reasoningCompleted,
      modelRefs,
      updatedAtSequence: Math.max(turn.updatedAtSequence, event.sequence),
    });
  }
  if (event.type === "model.output.completed") {
    return withLiveModelTurn(nextRun, {
      ...turn,
      requestStartSequence,
      output: appendCompletedOutputSnapshot(turn.output, event),
      outputStartSequence: turn.outputStartSequence ?? event.sequence,
      outputSequence: Math.max(turn.outputSequence ?? 0, event.sequence),
      outputCompleted: true,
      reasoningCompleted: turn.reasoning.text.trim().length > 0 ? true : turn.reasoningCompleted,
      modelRefs,
      updatedAtSequence: Math.max(turn.updatedAtSequence, event.sequence),
    });
  }
  if (event.type === "model.reasoning.delta") {
    return withLiveModelTurn(nextRun, {
      ...turn,
      requestStartSequence,
      reasoning: appendLiveTextFragment(turn.reasoning, event.delta ?? event.detail?.preview ?? event.summary ?? "", event),
      reasoningStartSequence: turn.reasoningStartSequence ?? event.sequence,
      reasoningSequence: Math.max(turn.reasoningSequence ?? 0, event.sequence),
      modelRefs,
      updatedAtSequence: Math.max(turn.updatedAtSequence, event.sequence),
    });
  }
  if (event.type === "model.reasoning.completed") {
    return withLiveModelTurn(nextRun, {
      ...turn,
      requestStartSequence,
      reasoning: appendCompletedReasoningSnapshot(turn.reasoning, event),
      // 思考的展示位置由首次出现（流式 delta）决定；完成的持久事实只是同一
      // 事实的终态，其记录时间可能晚于正文/工具，不能把思考挤到后面。
      reasoningSequence: (turn.reasoningSequence ?? 0) > 0 ? (turn.reasoningSequence ?? 0) : event.sequence,
      reasoningStartSequence: turn.reasoningStartSequence ?? event.sequence,
      reasoningCompleted: true,
      modelRefs,
      updatedAtSequence: Math.max(turn.updatedAtSequence, event.sequence),
    });
  }
  if (event.type === "tool.requested" || event.type === "tool.progress") {
    const callId = event.refs.find((ref) => ref.kind === "tool_call")?.id;
    const withTool = callId === undefined
      ? nextRun
      : withLiveToolActivity(nextRun, {
          invocationId: callId,
          nodeId: event.id,
          sequence: event.sequence,
          toolName: event.toolName,
          summary: event.summary,
          timestamp: event.timestamp ?? "",
          display: event.detail?.display,
          parentInvocationId: event.parentInvocationId,
          refs: event.refs,
        });
    return withLiveModelTurn(withTool, {
      ...turn,
      requestStartSequence,
      reasoningCompleted: turn.reasoning.text.trim().length > 0 ? true : turn.reasoningCompleted,
      modelRefs,
      updatedAtSequence: Math.max(turn.updatedAtSequence, event.sequence),
    });
  }
  if (isTerminalToolEvent(event)) {
    const callIds = event.refs.filter((ref) => ref.kind === "tool_call").map((ref) => ref.id);
    return withLiveModelTurn({
      ...nextRun,
      tools: nextRun.tools.filter((tool) => !callIds.includes(tool.invocationId)),
    }, {
      ...turn,
      requestStartSequence,
      reasoningCompleted: turn.reasoning.text.trim().length > 0 ? true : turn.reasoningCompleted,
      modelRefs,
      updatedAtSequence: Math.max(turn.updatedAtSequence, event.sequence),
    });
  }
  if (event.type === "confirmation.needed") {
    return withLiveModelTurn(nextRun, {
      ...turn,
      requestStartSequence,
      reasoningCompleted: turn.reasoning.text.trim().length > 0 ? true : turn.reasoningCompleted,
      modelRefs,
      updatedAtSequence: Math.max(turn.updatedAtSequence, event.sequence),
    });
  }
  if (isLiveReasoningSettlementEvent(event)) {
    return withLiveModelTurn(nextRun, {
      ...turn,
      requestStartSequence,
      reasoningCompleted: turn.reasoning.text.trim().length > 0 ? true : turn.reasoningCompleted,
      modelRefs,
      updatedAtSequence: Math.max(turn.updatedAtSequence, event.sequence),
    });
  }
  return withLiveModelTurn(nextRun, {
    ...turn,
    requestStartSequence,
    modelRefs,
    updatedAtSequence: Math.max(turn.updatedAtSequence, event.sequence),
  });
}

export function isLiveAppendOnlyEvent(event: RunEventLike): boolean {
  return event.type === "model.output.delta" || event.type === "model.reasoning.delta" ||
    event.type === "model.reasoning.completed" || event.type === "tool.requested" ||
    event.type === "tool.progress";
}

function isTerminalToolEvent(event: RunEventLike): boolean {
  return event.type === "tool.completed" || event.type === "tool.failed" || event.type === "tool.cancelled";
}

function isLiveReasoningSettlementEvent(event: RunEventLike): boolean {
  return event.type === "model.output.completed" ||
    event.type === "model.failed" ||
    event.type === "model.side.completed" ||
    event.type === "agent.note.completed" ||
    event.type === "tool.completed" ||
    event.type === "tool.failed" ||
    event.type === "tool.cancelled" ||
    event.type === "user_approval.received" ||
    event.type === "user.guidance" ||
    event.type === "context.compaction.requested" ||
    event.type === "context.compaction.completed" ||
    event.type === "context.compaction.failed" ||
    event.type === "final.result" ||
    event.type === "run.failed" ||
    event.type === "run.blocked" ||
    event.type === "run.cancelled";
}

function emptyLiveModelTurn(requestId: string, contentIndex = 0, requestStartSequence = 0): LiveModelTurnBuffer {
  return {
    requestId,
    requestStartSequence,
    contentIndex,
    output: emptyTextStreamAssembly(),
    outputSequence: 0,
    outputCompleted: false,
    sideText: "",
    sideTextSequence: 0,
    reasoning: emptyTextStreamAssembly(),
    reasoningSequence: 0,
    reasoningCompleted: false,
    modelRefs: [],
    updatedAtSequence: 0,
  };
}

function liveRunEventKey(event: RunEventLike): string {
  if (event.sequence > 0) return `${event.runId}:${event.sequence}:${event.type}`;
  return event.id.length > 0 ? event.id : `${event.runId}:${event.type}:${event.delta ?? ""}`;
}

function withLiveModelTurn(live: LiveRunBuffer, turn: LiveModelTurnBuffer): LiveRunBuffer {
  const exists = live.turns.some((item) =>
    item.requestId === turn.requestId && item.contentIndex === turn.contentIndex);
  return {
    ...live,
    turns: exists
      ? live.turns.map((item) =>
          item.requestId === turn.requestId && item.contentIndex === turn.contentIndex ? turn : item)
      : [...live.turns, turn],
  };
}

function withLiveToolActivity(live: LiveRunBuffer, activity: LiveToolActivity): LiveRunBuffer {
  const exists = live.tools.some((item) => item.invocationId === activity.invocationId);
  return {
    ...live,
    tools: exists
      ? live.tools.map((item) => item.invocationId === activity.invocationId ? activity : item)
      : [...live.tools, activity],
  };
}

function liveModelRequestId(event: RunEventLike): string | undefined {
  return event.refs.find((ref) => ref.kind === "model_call")?.id;
}

function appendLiveTextFragment(
  current: TextStreamAssembly,
  next: string,
  event: RunEventLike
): TextStreamAssembly {
  return appendTextStreamAssembly(
    current,
    next,
    textStreamFragmentSourceFromEventId(event.id)
  );
}

function appendCompletedReasoningSnapshot(
  current: TextStreamAssembly,
  event: RunEventLike
): TextStreamAssembly {
  const authoritative = event.delta ?? event.detail?.preview;
  const summary = event.summary?.trim() ?? "";
  const next = (authoritative ?? (current.text.trim().length === 0 || !isGenericCompletedReasoningSummary(summary)
    ? summary
    : "")).trim();
  if (next.length === 0) return current;
  return {
    text: next,
    replayCatchupText: "",
    liveSourceObserved: current.liveSourceObserved || textStreamFragmentSourceFromEventId(event.id) === "live",
  };
}

function appendCompletedOutputSnapshot(
  current: TextStreamAssembly,
  event: RunEventLike
): TextStreamAssembly {
  const next = completedOutputFragment(current.text, event);
  const hasAuthoritativePreview = (event.detail?.preview?.trim().length ?? 0) > 0;
  const text = hasAuthoritativePreview
    ? next
    : current.text.trim().length > 0 ? current.text : next;
  if (text.length === 0) return current;
  return {
    text,
    replayCatchupText: "",
    liveSourceObserved: current.liveSourceObserved || textStreamFragmentSourceFromEventId(event.id) === "live",
  };
}

function completedOutputFragment(
  currentText: string,
  event: Pick<RunEventLike, "summary" | "detail">
): string {
  const preview = event.detail?.preview?.trim();
  if (preview !== undefined && preview.length > 0) {
    return preview;
  }
  const summary = event.summary?.trim() ?? "";
  if (summary.length === 0) {
    return "";
  }
  if (currentText.trim().length > 0 && isGenericCompletedBodySummary(summary)) {
    return "";
  }
  return summary;
}

function isGenericCompletedBodySummary(value: string): boolean {
  const normalized = value.replace(/[。.!！?？；;:：、，,\s]/g, "");
  return normalized === "内容已整理" ||
    normalized === "内容已整理并已进入报告或详情" ||
    normalized === "回答完成" ||
    normalized === "回复完成" ||
    normalized === "已回答";
}

function isGenericCompletedReasoningSummary(value: string): boolean {
  const normalized = value.replace(/[。.!！?？；;:：、，,\s]/g, "");
  return normalized === "思考完成" || normalized === "推理完成" || normalized === "已完成思考";
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}
