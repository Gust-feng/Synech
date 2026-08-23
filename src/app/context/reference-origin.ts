/**
 * Distinguishes standing resources injected by the conversation owner from
 * attachments explicitly selected for the current turn.
 */
export function isConversationOwnerContextRef(
  ref: { readonly automaticSpaceReference?: boolean },
): boolean {
  return ref.automaticSpaceReference === true;
}
