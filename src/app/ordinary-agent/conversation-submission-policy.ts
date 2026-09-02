import {
  OrdinaryFeatureError,
  type OrdinaryConversationControlDocument,
  type OrdinaryRunInput,
} from "./contracts.js";

export function assertConversationWritable(document: OrdinaryConversationControlDocument): void {
  if (document.state.deletedAt !== undefined) {
    throw new OrdinaryFeatureError(
      "ordinary_conversation_deleted",
      `Ordinary conversation ${document.state.conversationId} was deleted`,
    );
  }
}

export function normalizedSubmissionId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0 || value.length > 200 || value.includes("\0")) {
    throw new OrdinaryFeatureError("ordinary_submission_conflict", "Ordinary submission id is invalid.");
  }
  return value;
}

export function sameSubmissionInput(left: OrdinaryRunInput, right: OrdinaryRunInput): boolean {
  if (left.userMessage !== right.userMessage) return false;
  if (left.turnMemoryOverrideOff !== right.turnMemoryOverrideOff) return false;
  const leftRefs = left.context?.contextRefs ?? [];
  const rightRefs = right.context?.contextRefs ?? [];
  if (leftRefs.length !== rightRefs.length) return false;
  for (let index = 0; index < leftRefs.length; index += 1) {
    const a = leftRefs[index]!;
    const b = rightRefs[index]!;
    if (a.attachmentId !== b.attachmentId || a.ref !== b.ref || a.kind !== b.kind) return false;
  }
  return true;
}
