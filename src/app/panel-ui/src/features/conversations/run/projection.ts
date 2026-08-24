import {
  mergeTranscriptNodesByRunId,
  runIdsForConversation as cachedRunIdsForConversation,
  transcriptNodesForConversation as cachedTranscriptNodesForConversation,
} from "../../../../../panel-api/ui-read-model";
import {
  createRunReadModelPatch as createSharedRunReadModelPatch,
  detailForRun,
  nextWorkViewForRun,
  transcriptNodesFrom,
} from "../../../../../panel-api/ui-read-model";
import type { Conversation } from "../../../contracts/conversation";
import type {
  OrdinaryRun,
  OrdinaryRunDetail,
  OrdinaryWorkView,
  RunCapabilityResolution,
  RunEvent,
  TranscriptNode,
} from "../../../contracts/run";
import type { LiveRunBuffer } from "../../../../../panel-api/ui-read-model";

export type CurrentRunProjection = {
  readonly run?: OrdinaryRun;
  readonly workView?: OrdinaryWorkView;
  readonly capabilityResolution?: RunCapabilityResolution;
  readonly detail?: OrdinaryRunDetail;
  readonly live?: LiveRunBuffer;
  readonly events: readonly RunEvent[];
  readonly transcriptNodes: readonly TranscriptNode[];
};

export type RunReadModelPatch = {
  readonly workView?: OrdinaryWorkView;
  readonly detail?: OrdinaryRunDetail;
  readonly transcriptNodes: readonly TranscriptNode[];
  readonly transcriptNodesByRunId: Record<string, readonly TranscriptNode[]>;
};

type RunProjectionState = {
  readonly conversation?: Conversation;
  readonly run?: OrdinaryRun;
  readonly workView?: OrdinaryWorkView;
  readonly capabilityResolution?: RunCapabilityResolution;
  readonly capabilityResolutionRunId?: string;
  readonly transcriptNodesByRunId: Record<string, readonly TranscriptNode[]>;
  readonly events: readonly RunEvent[];
  readonly live?: LiveRunBuffer;
  readonly detail?: OrdinaryRunDetail;
};

export {
  detailForRun,
  nextWorkViewForRun,
  transcriptNodesFrom,
};

export function createRunReadModelPatch(
  previous: {
    readonly workView?: OrdinaryWorkView;
    readonly transcriptNodesByRunId: Record<string, readonly TranscriptNode[]>;
  },
  input: {
    readonly runId: string;
    readonly workView: OrdinaryWorkView | undefined;
    readonly detail: OrdinaryRunDetail | undefined;
    readonly reusePreviousWorkView?: boolean;
  }
): RunReadModelPatch {
  return createSharedRunReadModelPatch<OrdinaryWorkView, OrdinaryRunDetail, TranscriptNode>(previous, input);
}

export function projectCurrentRun(app: RunProjectionState): CurrentRunProjection {
  const runId = app.run?.runId;
  if (runId === undefined) {
    return { events: [], transcriptNodes: transcriptNodesForConversation(app) };
  }
  const workView = app.workView?.run.runId === runId ? app.workView : undefined;
  const capabilityResolution = app.capabilityResolutionRunId === runId ? app.capabilityResolution : undefined;
  const detail = app.detail?.runId === runId ? app.detail : undefined;
  const live = app.live?.runId === runId ? app.live : undefined;
  const events = app.events.filter((event) => event.runId === runId);
  const runTranscriptNodes = transcriptNodesFrom(workView).filter((node) => node.runId === runId);
  const transcriptNodes = mergeConversationTranscriptNodes(app, runId, runTranscriptNodes);
  return {
    run: app.run,
    workView,
    capabilityResolution,
    detail,
    live,
    events,
    transcriptNodes,
  };
}

export function currentRunProjectionDeps(app: RunProjectionState): readonly unknown[] {
  return [
    app.conversation,
    app.run,
    app.workView,
    app.capabilityResolution,
    app.capabilityResolutionRunId,
    app.transcriptNodesByRunId,
    app.events,
    app.live,
    app.detail,
  ];
}

function transcriptNodesForConversation(app: RunProjectionState): readonly TranscriptNode[] {
  return cachedTranscriptNodesForConversation(app.conversation?.turns ?? [], app.transcriptNodesByRunId);
}

function mergeConversationTranscriptNodes(
  app: RunProjectionState,
  currentRunId: string,
  currentRunNodes: readonly TranscriptNode[]
): readonly TranscriptNode[] {
  const byRunId = mergeTranscriptNodesByRunId(app.transcriptNodesByRunId, currentRunId, currentRunNodes);
  return runIdsForConversation(app.conversation).flatMap((runId) => byRunId[runId] ?? []);
}

function runIdsForConversation(conversation: Conversation | undefined): readonly string[] {
  return cachedRunIdsForConversation(conversation?.turns ?? []);
}
