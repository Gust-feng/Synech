export type ConversationState = "initial" | "working" | "attention" | "completed" | "failed";

export function projectConversationState(input: {
  readonly pending: boolean;
  readonly running: boolean;
  readonly failed: boolean;
  readonly hasVisibleContent: boolean;
}): ConversationState {
  if (input.pending) return "attention";
  if (input.running) return "working";
  if (input.failed) return "failed";
  return input.hasVisibleContent ? "completed" : "initial";
}