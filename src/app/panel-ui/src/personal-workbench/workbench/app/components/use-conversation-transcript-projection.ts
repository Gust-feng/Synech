import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ConversationTurn } from '@ui/contracts/conversation'
import type { AgentDeliverable, OrdinaryRun, OrdinaryWorkView, TranscriptNode } from '@ui/contracts/run'
import type { ChatModelOption } from '@ui/contracts/composer'
import type { PanelToolCallResult as ToolCallResult } from '@panel-api/ordinary-agent'
import type { LiveRunBuffer, LiveRunTranscriptProjection, WorklineProjectedTurn } from '@panel-api/ui-read-model'
import { projectConversationDisplayList, shouldCollapseStandaloneTimeline } from '@panel-api/ui-read-model'
import {
  getTranscriptCache,
  subscribeTranscriptCache,
  transcriptNodesCacheForConversation,
  transcriptToolResultsCacheForConversation,
} from '@ui/features/conversations/transcript/store'
import type { ConfirmationProjection } from './ConfirmationCard'

export type ConversationStandaloneRun = {
  readonly currentRunId?: string
  readonly runStatus?: string
  readonly answer?: string
  readonly failure?: { readonly code: string; readonly message: string }
  readonly deliverable?: AgentDeliverable
  readonly runProjection: LiveRunTranscriptProjection & { readonly nodes: readonly TranscriptNode[] }
  readonly pending?: ConfirmationProjection
}

export type ConversationTranscriptProjectionInput = {
  readonly conversationId?: string
  readonly projectedTurns: readonly WorklineProjectedTurn<ConversationTurn>[]
  readonly turns: readonly ConversationTurn[]
  readonly currentRunId?: string
  readonly currentRunNodes: readonly TranscriptNode[]
  readonly currentRunToolResults: readonly ToolCallResult[]
  readonly run?: OrdinaryRun
  readonly live?: LiveRunBuffer
  readonly workView?: OrdinaryWorkView
  readonly pending?: ConfirmationProjection
  readonly standaloneRun?: ConversationStandaloneRun
}

export function useConversationTranscriptProjection(input: ConversationTranscriptProjectionInput) {
  const cachedHistoricalSnapshot = useSyncExternalStore(
    useCallback(
      (listener: () => void) => subscribeTranscriptCache(input.conversationId, listener),
      [input.conversationId],
    ),
    getTranscriptCache,
    getTranscriptCache,
  )
  const cachedHistoricalNodes = transcriptNodesCacheForConversation(cachedHistoricalSnapshot, input.conversationId)
  const cachedHistoricalToolResults = transcriptToolResultsCacheForConversation(
    cachedHistoricalSnapshot,
    input.conversationId,
  )
  const toolResultsByRunId = useMemo(() => input.currentRunId === undefined
    ? cachedHistoricalToolResults
    : {
        ...cachedHistoricalToolResults,
        [input.currentRunId]: input.currentRunToolResults,
      }, [cachedHistoricalToolResults, input.currentRunId, input.currentRunToolResults])
  const conversationDisplay = useMemo(() => {
    const collapseTimeline = shouldCollapseStandaloneTimeline({
      runStatus: input.standaloneRun?.runStatus,
      hasPendingConfirmation: input.standaloneRun?.pending !== undefined,
    })
    return projectConversationDisplayList({
      conversationId: input.conversationId,
      projectedTurns: input.projectedTurns,
      turns: input.turns,
      cachedNodesByRunId: cachedHistoricalNodes,
      currentRunId: input.currentRunId,
      currentRunNodes: input.currentRunNodes,
      run: input.run,
      live: input.live,
      workView: input.workView,
      pending: input.pending,
      standaloneRun: input.standaloneRun === undefined ? undefined : { ...input.standaloneRun, collapseTimeline },
    })
  }, [
    cachedHistoricalNodes, input.conversationId, input.projectedTurns, input.turns,
    input.currentRunId, input.currentRunNodes, input.run, input.live, input.workView,
    input.pending, input.standaloneRun,
  ])

  return { conversationDisplay, toolResultsByRunId }
}