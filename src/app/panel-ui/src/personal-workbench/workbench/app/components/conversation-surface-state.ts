import type { AgentDeliverable, OrdinaryWorkView, PendingConfirmation, TranscriptNode } from '@ui/contracts/run'
import type { ChatActiveViewProjection } from '@ui/features/conversations/transcript/live-view'
import { projectConversationState } from '../../../../workbench/conversation-state-policy'

export type LiveConversationState = 'initial' | 'working' | 'attention' | 'completed' | 'failed'

export type ConversationPendingConfirmation = NonNullable<OrdinaryWorkView['pendingConfirmation']> | PendingConfirmation

export type ConversationSurfaceProjection = ChatActiveViewProjection<AgentDeliverable, ConversationPendingConfirmation>

export type VisibleConversationHeaderState = Extract<LiveConversationState, 'working' | 'attention'>

export function visibleConversationHeaderState(
  state: LiveConversationState | undefined,
): VisibleConversationHeaderState | undefined {
  return state === 'working' || state === 'attention' ? state : undefined
}

export function projectLiveConversationState(input: {
  readonly projection: ConversationSurfaceProjection
  readonly error?: string
  readonly runStatus?: string
}): LiveConversationState {
  return projectConversationState({
    pending: input.projection.pending !== undefined,
    running: input.projection.running,
    failed: input.error !== undefined || isFailedRun(input.runStatus),
    hasVisibleContent: input.projection.hasVisibleContent,
  })
}
function isFailedRun(status: string | undefined): boolean {
  return status === 'failed' || status === 'blocked' || status === 'cancelled'
}