export const LONG_TRANSCRIPT_PROGRESSIVE_THRESHOLD = 96;
export const INITIAL_VISIBLE_TRANSCRIPT_TURNS = 40;
export const TRANSCRIPT_REVEAL_BATCH = 32;
export const MANUAL_TRANSCRIPT_REVEAL_BATCH = 80;

export type TranscriptVisibleTurnWindow = {
  readonly startIndex: number;
  readonly visibleCount: number;
  readonly complete: boolean;
};

export type TranscriptVisibilityState = {
  readonly conversationId?: string;
  readonly totalTurns: number;
  readonly visibleCount: number;
};

export function initialVisibleTranscriptTurnCount(totalTurns: number): number {
  if (totalTurns <= 0) return 0;
  if (totalTurns <= LONG_TRANSCRIPT_PROGRESSIVE_THRESHOLD) return totalTurns;
  return Math.min(totalTurns, INITIAL_VISIBLE_TRANSCRIPT_TURNS);
}

export function reconcileTranscriptVisibilityState(input: {
  readonly previous?: TranscriptVisibilityState;
  readonly conversationId?: string;
  readonly totalTurns: number;
}): TranscriptVisibilityState {
  const totalTurns = Math.max(0, input.totalTurns);
  const previous = input.previous;
  if (previous === undefined || previous.conversationId !== input.conversationId) {
    return {
      conversationId: input.conversationId,
      totalTurns,
      visibleCount: initialVisibleTranscriptTurnCount(totalTurns),
    };
  }

  if (totalTurns === previous.totalTurns) {
    return previous;
  }

  if (totalTurns <= previous.totalTurns) {
    return {
      conversationId: input.conversationId,
      totalTurns,
      visibleCount: Math.min(previous.visibleCount, totalTurns),
    };
  }

  const addedTurns = totalTurns - previous.totalTurns;
  const wasFullyVisible = previous.visibleCount >= previous.totalTurns;
  const nextVisibleCount = wasFullyVisible && addedTurns <= TRANSCRIPT_REVEAL_BATCH
    ? totalTurns
    : Math.max(previous.visibleCount, initialVisibleTranscriptTurnCount(totalTurns));
  return {
    conversationId: input.conversationId,
    totalTurns,
    visibleCount: Math.min(nextVisibleCount, totalTurns),
  };
}

export function nextTranscriptVisibleTurnCount(
  totalTurns: number,
  visibleCount: number,
  batchSize = TRANSCRIPT_REVEAL_BATCH
): number {
  return Math.min(Math.max(0, totalTurns), Math.max(0, visibleCount) + Math.max(1, batchSize));
}

export function previousTranscriptVisibleTurnCount(
  totalTurns: number,
  visibleCount: number
): number {
  return nextTranscriptVisibleTurnCount(totalTurns, visibleCount, MANUAL_TRANSCRIPT_REVEAL_BATCH);
}

export function transcriptVisibleTurnWindow(
  totalTurns: number,
  visibleCount: number
): TranscriptVisibleTurnWindow {
  const boundedTotal = Math.max(0, totalTurns);
  const boundedVisible = Math.min(boundedTotal, Math.max(0, visibleCount));
  return {
    startIndex: boundedTotal - boundedVisible,
    visibleCount: boundedVisible,
    complete: boundedVisible >= boundedTotal,
  };
}

export function runIdsForTurnWindow<TTurn extends { readonly role: "user" | "assistant"; readonly runId?: string }>(
  turns: readonly TTurn[],
  startIndex: number,
  endIndex = turns.length
): readonly string[] {
  const runIds = new Set<string>();
  const start = Math.max(0, startIndex);
  const end = Math.min(turns.length, Math.max(start, endIndex));
  for (let index = start; index < end; index += 1) {
    const turn = turns[index];
    if (turn?.role !== "assistant") continue;
    const runId = turn.runId;
    if (runId !== undefined && runId.trim().length > 0) {
      runIds.add(runId);
    }
  }
  return [...runIds];
}