export type WorklineTaskStatus =
  | "queued"
  | "planning"
  | "running"
  | "needs_input"
  | "approval_needed"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "pending";

export type WorklineConversationTurnAttachment = {
  readonly attachmentId: string;
  readonly kind: "workspace" | "file" | "project" | "web";
  readonly title: string;
  readonly summary?: string;
  readonly readonlyPreviewMeta?: {
    readonly available?: boolean;
    readonly title?: string;
    readonly byteLength?: number;
    readonly mimeType?: string;
    readonly truncated?: boolean;
  };
  readonly mediaPreview?: {
    readonly kind: "image";
    readonly url: string;
    readonly mimeType: string;
    readonly byteLength?: number;
  };
};

export type WorklineConversationTurn = {
  readonly turnId: string;
  readonly role: "user" | "assistant";
  readonly title?: string;
  readonly content: string;
  readonly status: string;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly interruption?: "user_cancelled" | "runtime_stopped";
  readonly runId?: string;
  readonly attachments?: readonly WorklineConversationTurnAttachment[];
};

export type WorklineTranscriptNode = {
  readonly runId: string;
};

export type WorklineProjectedTurn<TTurn extends WorklineConversationTurn> = {
  readonly turn: TTurn;
  readonly displayRunId?: string;
  readonly claimedCurrentRun: boolean;
};

export type ChatWorklineProjection<TTurn extends WorklineConversationTurn> = {
  readonly turns: readonly WorklineProjectedTurn<TTurn>[];
  readonly standaloneRun: boolean;
};

export function projectChatWorkline<TTurn extends WorklineConversationTurn>(input: {
  readonly turns: readonly TTurn[];
  readonly currentRunId: string | undefined;
  readonly currentRunStatus: WorklineTaskStatus | undefined;
  readonly transcriptNodes: readonly WorklineTranscriptNode[];
  readonly hasAnswer: boolean;
  readonly hasLiveAnswer: boolean;
  readonly hasPendingConfirmation: boolean;
  readonly hasDeliverable: boolean;
}): ChatWorklineProjection<TTurn> {
  const runIdsWithVisibleNodes = new Set<string>();
  for (const node of input.transcriptNodes) {
    runIdsWithVisibleNodes.add(node.runId);
  }
  const currentRunHasMaterial = hasCurrentRunMaterial(input, runIdsWithVisibleNodes);
  let hasAssistantTurnForCurrentRun = false;
  let latestClaimableAssistantTurnId: string | undefined;
  if (input.currentRunId !== undefined) {
    for (const turn of input.turns) {
      if (turn.role !== "assistant") continue;
      if (turn.runId === input.currentRunId) {
        hasAssistantTurnForCurrentRun = true;
      }
      if (
        turn.runId === undefined &&
        turn.content.trim().length === 0 &&
        (turn.status === "running" || turn.status === "pending")
      ) {
        latestClaimableAssistantTurnId = turn.turnId;
      }
    }
  }
  const claimableTurnId = hasAssistantTurnForCurrentRun || !currentRunHasMaterial
    ? undefined
    : latestClaimableAssistantTurnId;

  const projectedTurns: WorklineProjectedTurn<TTurn>[] = [];
  let projectedAssistantOwnsCurrentRun = false;
  for (const turn of input.turns) {
    const claimedCurrentRun = claimableTurnId !== undefined && turn.turnId === claimableTurnId;
    const projection: WorklineProjectedTurn<TTurn> = {
      turn,
      displayRunId: turn.runId ?? (claimedCurrentRun ? input.currentRunId : undefined),
      claimedCurrentRun,
    };
    if (!shouldShowTurn(projection, input.currentRunId, runIdsWithVisibleNodes, currentRunHasMaterial)) {
      continue;
    }
    if (turn.role === "assistant" && projection.displayRunId === input.currentRunId) {
      projectedAssistantOwnsCurrentRun = true;
    }
    projectedTurns.push(projection);
  }

  return {
    turns: projectedTurns,
    standaloneRun: input.currentRunId !== undefined &&
      !projectedAssistantOwnsCurrentRun &&
      currentRunHasMaterial,
  };
}

function hasCurrentRunMaterial(
  input: {
    readonly currentRunId: string | undefined;
    readonly currentRunStatus: WorklineTaskStatus | undefined;
    readonly hasAnswer: boolean;
    readonly hasLiveAnswer: boolean;
    readonly hasPendingConfirmation: boolean;
    readonly hasDeliverable: boolean;
  },
  runIdsWithVisibleNodes: ReadonlySet<string>
): boolean {
  if (input.currentRunId === undefined) return false;
  return runIdsWithVisibleNodes.has(input.currentRunId) ||
    input.hasAnswer ||
    input.hasLiveAnswer ||
    input.hasPendingConfirmation ||
    input.hasDeliverable ||
    input.currentRunStatus === "queued" ||
    input.currentRunStatus === "planning" ||
    input.currentRunStatus === "running" ||
    input.currentRunStatus === "approval_needed" ||
    input.currentRunStatus === "needs_input";
}

function shouldShowTurn<TTurn extends WorklineConversationTurn>(
  projection: WorklineProjectedTurn<TTurn>,
  currentRunId: string | undefined,
  runIdsWithVisibleNodes: ReadonlySet<string>,
  currentRunHasMaterial: boolean
): boolean {
  const turn = projection.turn;
  if (turn.role === "user") return true;
  if (turn.content.trim().length > 0) return true;
  if (projection.displayRunId !== undefined && runIdsWithVisibleNodes.has(projection.displayRunId)) return true;
  if (projection.claimedCurrentRun) return true;
  if (turn.status !== "running" && turn.status !== "pending") return false;
  if (turn.runId !== undefined) return turn.runId === currentRunId;
  return currentRunId === undefined || !currentRunHasMaterial;
}
