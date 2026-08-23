import type {
  OrdinaryConversationControlDocument,
  OrdinaryConversationReadModel,
  OrdinaryRunState,
} from "./contracts.js";
import type { AgentSessionEntryRef } from "../model-runtime/agent-session.js";

export function visibleOrdinaryConversationRuns(
  control: OrdinaryConversationControlDocument,
  allRuns: readonly OrdinaryRunState[],
  activeBranchEntryRefs: readonly AgentSessionEntryRef[],
): readonly OrdinaryRunState[] {
  const conversationRuns = allRuns.filter((run) => run.turn.conversationId === control.state.conversationId);
  assertConversationSessionOwnership(control, conversationRuns, activeBranchEntryRefs);
  if (activeBranchEntryRefs.length === 0 && conversationRuns.some(hasDurableSessionEntry)) {
    throw new Error(`Ordinary conversation ${control.state.conversationId} has durable runs but no active Session branch`);
  }
  const branchIndex = new Map(activeBranchEntryRefs.map((entry, index) => [sessionEntryKey(entry), index]));
  const onBranch = conversationRuns
    .map((run) => ({ run, index: activeBranchIndex(run, branchIndex) }))
    .filter((item): item is { readonly run: OrdinaryRunState; readonly index: number } => item.index !== undefined)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.run);
  const visible = [...onBranch];
  const included = new Set(visible.map((run) => run.runId));
  let predecessorRunId = visible.at(-1)?.runId;
  while (true) {
    const candidates = conversationRuns.filter((run) =>
      !included.has(run.runId) &&
      run.turn.predecessorRunId === predecessorRunId &&
      isPendingOrPreSessionTerminal(run)
    );
    if (candidates.length === 0) break;
    if (candidates.length > 1) {
      throw new Error(`Ordinary conversation ${control.state.conversationId} has multiple pending successors`);
    }
    const next = candidates[0]!;
    visible.push(next);
    included.add(next.runId);
    predecessorRunId = next.runId;
  }
  return visible;
}

function assertConversationSessionOwnership(
  control: OrdinaryConversationControlDocument,
  runs: readonly OrdinaryRunState[],
  activeBranchEntryRefs: readonly AgentSessionEntryRef[],
): void {
  const sessionId = control.state.sessionRef.sessionId;
  for (const run of runs) {
    if (run.sessionRef.sessionId !== sessionId) {
      throw new Error(`Ordinary run ${run.runId} does not belong to conversation Session ${sessionId}`);
    }
  }
  for (const entryRef of activeBranchEntryRefs) {
    if (entryRef.sessionId !== sessionId) {
      throw new Error(`Ordinary conversation ${control.state.conversationId} received a foreign Session branch entry`);
    }
  }
}

function hasDurableSessionEntry(run: OrdinaryRunState): boolean {
  switch (run.session.phase) {
    case "not_started": return false;
    case "started": return run.session.startLeafRef !== null ||
      run.session.compactionEntryRefs.length > 0 ||
      run.pendingToolRound !== undefined;
    case "rollbackable":
    case "completion_candidate":
      return true;
  }
}

function isPendingOrPreSessionTerminal(run: OrdinaryRunState): boolean {
  if (run.status.kind === "queued" || run.status.kind === "running" || run.status.kind === "awaiting_approval") {
    return true;
  }
  // A run cancelled or failed before its first Session write has no branch
  // entry of its own. It remains a product turn and must not hide successors.
  return run.session.phase === "not_started";
}

export function projectOrdinaryConversation(input: {
  readonly control: OrdinaryConversationControlDocument;
  readonly runs: readonly OrdinaryRunState[];
  readonly completedAssistantTextByRunId?: ReadonlyMap<string, string>;
}): OrdinaryConversationReadModel | undefined {
  if (input.control.state.deletedAt !== undefined || input.runs.length === 0) return undefined;
  const first = input.runs[0]!;
  const latest = input.runs.at(-1)!;
  const active = input.runs.find((run) => run.status.kind === "running" || run.status.kind === "awaiting_approval");
  const queued = input.runs.filter((run) => run.status.kind === "queued").map((run) => run.runId);
  const updatedAt = input.runs.reduce(
    (latestTime, run) => run.timestamps.updatedAt.localeCompare(latestTime) > 0 ? run.timestamps.updatedAt : latestTime,
    input.control.savedAt,
  );
  return {
    conversationId: input.control.state.conversationId,
    title: input.control.state.titleOverride ?? input.control.state.autoTitle ?? compactTitle(first.input.userMessage),
    titleEditedAt: input.control.state.titleEditedAt,
    pinnedAt: input.control.state.pinnedAt,
    createdAt: input.control.state.createdAt,
    updatedAt,
    activeRunId: active?.runId,
    latestRunId: latest.runId,
    queuedRunIds: queued,
    turns: input.runs.flatMap((run) => [{
      role: "user" as const,
      turnId: run.turn.userTurnId,
      runId: run.runId,
      content: run.input.userMessage,
      input: structuredClone(run.input),
      status: run.status.kind === "queued" ? "pending" as const : "completed" as const,
      createdAt: run.timestamps.createdAt,
      updatedAt: run.timestamps.updatedAt,
    }, {
      role: "assistant" as const,
      turnId: run.turn.assistantTurnId,
      runId: run.runId,
      content: assistantContent(run, input.completedAssistantTextByRunId?.get(run.runId)),
      status: run.status.kind,
      ...interruptionProjection(run),
      model: structuredClone(run.birth.config),
      createdAt: run.timestamps.createdAt,
      updatedAt: run.timestamps.updatedAt,
    }]),
  };
}

function activeBranchIndex(
  run: OrdinaryRunState,
  branchIndex: ReadonlyMap<string, number>,
): number | undefined {
  const entryRef = run.session.phase === "rollbackable"
    ? run.session.endLeafRef
    : run.session.phase === "completion_candidate"
      ? run.session.assistantEntryRef
      : undefined;
  return entryRef === undefined ? undefined : branchIndex.get(sessionEntryKey(entryRef));
}

function sessionEntryKey(ref: AgentSessionEntryRef): string {
  return `${ref.sessionId}\u0000${ref.entryId}`;
}

export function normalizeOrdinaryConversationTitle(value: string): string {
  const title = value.replace(/\s+/gu, " ").trim();
  if (title.length === 0) throw new Error("Ordinary conversation title cannot be empty");
  return compactTitle(title);
}

function compactTitle(value: string): string {
  const title = value.replace(/\s+/gu, " ").trim();
  return title.length <= 80 ? title : `${title.slice(0, 79)}…`;
}

function assistantContent(run: OrdinaryRunState, completedAssistantText: string | undefined): string {
  if (interruptionProjection(run).interruption !== undefined) {
    return run.visibleAssistantText ?? "";
  }
  switch (run.status.kind) {
    case "completed": {
      if (completedAssistantText === undefined) {
        throw new Error(`Completed Ordinary run ${run.runId} has no projected Session answer`);
      }
      return completedAssistantText;
    }
    case "failed": return run.status.error.message;
    case "cancelled": return "";
    case "blocked": return run.status.reason.message;
    default: return "";
  }
}

function interruptionProjection(
  run: OrdinaryRunState,
): { readonly interruption?: "user_cancelled" | "runtime_stopped" } {
  if (run.status.kind === "cancelled") {
    return {
      interruption: run.status.reason === "cancelled_by_user"
        ? "user_cancelled"
        : "runtime_stopped",
    };
  }
  if (run.status.kind === "blocked" && (
    run.status.reason.code === "execution_continuation_lost" ||
    run.status.reason.code === "confirmation_continuation_lost" ||
    run.status.reason.code === "tool_execution_outcome_unknown"
  )) {
    return { interruption: "runtime_stopped" };
  }
  return {};
}