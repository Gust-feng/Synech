/** True for standing resources injected by the conversation Owner. */
export function isConversationOwnerContextRef(
  ref: { readonly automaticSpaceReference?: boolean },
): boolean {
  return ref.automaticSpaceReference === true;
}
