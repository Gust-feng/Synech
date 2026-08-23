export type LiveConversationState = 'initial' | 'working' | 'attention' | 'completed' | 'failed'

export type VisibleConversationHeaderState = Extract<LiveConversationState, 'working' | 'attention'>

export function visibleConversationHeaderState(
  state: LiveConversationState | undefined,
): VisibleConversationHeaderState | undefined {
  return state === 'working' || state === 'attention' ? state : undefined
}