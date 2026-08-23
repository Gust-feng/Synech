export type TimelineCollapseRunLike = {
  readonly runId: string;
  readonly status: string;
};

export type TimelineCollapseActivityLike = {
  readonly variant?: string;
  readonly tone?: string;
  readonly toolKind?: string;
  readonly phase: string;
  readonly lead?: {
    readonly subject: string;
  };
  readonly copy: {
    readonly label?: string;
    readonly detail: string;
  };
};

export type TimelineCollapseReason =
  | "structure"
  | "turn_settled"
  | "reasoning_settled"
  | "active_or_pending"
  | "empty"
  | "needs_attention"
  | "expanded";

export type TimelineSegmentLifecycle = "open" | "settled" | "attention";

export type TimelineCollapseDecision = {
  readonly collapsed: boolean;
  readonly reason: TimelineCollapseReason;
};

export type ActiveTimelineStatus = {
  readonly label: string;
};

export function shouldCollapseTimelineAfterTurn(input: {
  readonly displayRunId?: string;
  readonly live: boolean;
  readonly pending?: unknown;
  readonly run?: TimelineCollapseRunLike;
  readonly turnStatus: string;
}): boolean {
  if (input.live || input.pending !== undefined) {
    return false;
  }
  const ownerStatus = collapseOwnerStatus(input);
  if (isAttentionTimelineStatus(ownerStatus)) {
    return false;
  }
  return isSettledTimelineStatus(ownerStatus);
}

export function shouldCollapseStandaloneTimeline(input: {
  readonly runStatus?: string;
  readonly hasPendingConfirmation: boolean;
}): boolean {
  if (input.runStatus === undefined || input.hasPendingConfirmation || isAttentionTimelineStatus(input.runStatus)) {
    return false;
  }
  return isSettledTimelineStatus(input.runStatus);
}

export function shouldAutoCollapseTimelineSegment(input: {
  readonly collapseTimeline: boolean;
  readonly defaultCollapsed: boolean;
  readonly lifecycle?: TimelineSegmentLifecycle;
  readonly items: readonly TimelineCollapseActivityLike[];
  readonly hasCurrentConfirmation: boolean;
  readonly hasBodySegments: boolean;
}): boolean {
  return timelineCollapseDecision(input).collapsed;
}

export function timelineCollapseDecision(input: {
  readonly collapseTimeline: boolean;
  readonly defaultCollapsed: boolean;
  readonly lifecycle?: TimelineSegmentLifecycle;
  readonly items: readonly TimelineCollapseActivityLike[];
  readonly hasCurrentConfirmation: boolean;
  readonly hasBodySegments: boolean;
}): TimelineCollapseDecision {
  if (input.hasCurrentConfirmation) {
    return { collapsed: false, reason: "active_or_pending" };
  }
  if (input.items.length === 0) {
    return { collapsed: false, reason: "empty" };
  }
  if (input.lifecycle === "open") {
    return { collapsed: false, reason: "active_or_pending" };
  }
  if (input.items.some((item) => isAttentionTimelinePhase(item.phase))) {
    return { collapsed: false, reason: "needs_attention" };
  }
  if (input.lifecycle === "attention") {
    return { collapsed: false, reason: "active_or_pending" };
  }
  if (input.items.some((item) => item.variant === "context_compaction")) {
    return { collapsed: false, reason: "expanded" };
  }
  if (input.items.some((item) => !isAutoCollapsibleTimelinePhase(item.phase))) {
    return { collapsed: false, reason: "active_or_pending" };
  }
  if (input.items.every(isSettledReasoningActivity)) {
    return { collapsed: true, reason: "reasoning_settled" };
  }
  if (input.defaultCollapsed) {
    return { collapsed: true, reason: "structure" };
  }
  if (input.collapseTimeline === true) {
    return { collapsed: true, reason: "turn_settled" };
  }
  if (input.hasBodySegments) {
    return { collapsed: true, reason: "structure" };
  }
  return { collapsed: false, reason: "expanded" };
}

function isSettledReasoningActivity(item: TimelineCollapseActivityLike): boolean {
  return item.tone === "thinking" && isAutoCollapsibleTimelinePhase(item.phase);
}

export function collapsedTimelineSummary(input: {
  readonly items: readonly TimelineCollapseActivityLike[];
  readonly hasCurrentConfirmation: boolean;
}): string {
  if (input.hasCurrentConfirmation) {
    return "等待处理";
  }
  return `过程 · ${input.items.length}`;
}

export function activeTimelineStatus(input: {
  readonly items: readonly TimelineCollapseActivityLike[];
}): ActiveTimelineStatus {
  const current = [...input.items].reverse().find((item) => isActiveTimelinePhase(item.phase));
  return { label: current === undefined ? "正在处理" : activePhaseCopy(current) };
}

export function isSettledTimelineStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "blocked";
}

function collapseOwnerStatus(input: {
  readonly displayRunId?: string;
  readonly run?: TimelineCollapseRunLike;
  readonly turnStatus: string;
}): string {
  if (input.displayRunId !== undefined && input.run?.runId === input.displayRunId) {
    return input.run.status;
  }
  return input.turnStatus;
}

function isAttentionTimelineStatus(status: string | undefined): boolean {
  return status === "approval_needed" ||
    status === "waiting_approval" ||
    status === "needs_input" ||
    status === "failed" ||
    status === "blocked";
}

function isAutoCollapsibleTimelinePhase(phase: string): boolean {
  return phase === "completed" ||
    phase === "approved" ||
    phase === "denied" ||
    phase === "guidance" ||
    phase === "cancelled";
}

function isAttentionTimelinePhase(phase: string): boolean {
  return phase === "failed" ||
    phase === "blocked" ||
    phase === "waiting_approval";
}

function isActiveTimelinePhase(phase: string): boolean {
  return phase === "noted" || phase === "preparing" || phase === "executing";
}

function activePhaseCopy(item: TimelineCollapseActivityLike): string {
  if (item.variant === "context_compaction" || item.tone === "thinking" || item.tone === "narration") {
    return "正在处理";
  }
  const target = activityStatusTarget(item.lead?.subject);
  if (item.toolKind === "read") return target === undefined ? "正在读取内容" : `正在读取 ${target}`;
  if (item.toolKind === "directory") return target === undefined ? "正在查看目录" : `正在查看 ${target}`;
  if (item.toolKind === "web") return target === undefined ? "正在查看内容" : `正在查看 ${target}`;
  if (item.toolKind === "search") return target === undefined ? "正在搜索" : `正在搜索 ${target}`;
  if (item.toolKind === "edit") return target === undefined ? "正在修改内容" : `正在修改 ${target}`;
  if (item.toolKind === "command") return "正在运行命令";
  const label = item.copy.label?.trim();
  if (label === "读取" || label === "查看") return "正在查看内容";
  if (label === "搜索") return "正在搜索";
  if (label === "编辑" || label === "写入" || label === "创建" || label === "删除" || label === "生成") {
    return "正在修改内容";
  }
  if (label === "网页" || label === "请求") return "正在查看内容";
  if (label === "命令") return "正在运行命令";
  return "正在处理";
}

function activityStatusTarget(value: string | undefined): string | undefined {
  const target = value?.replace(/\s+/g, " ").trim();
  if (target === undefined || target.length === 0) {
    return undefined;
  }
  return target.length <= 56 ? target : `${target.slice(0, 55).trimEnd()}…`;
}
