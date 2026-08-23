import { mergeTranscriptNodesByRunId } from "../transcript/panel-transcript-cache.js";

export type RunProjectionNode = {
  readonly nodeId: string;
  readonly runId: string;
  readonly sequence: number;
};

export type RunProjectionWorkView<TNode extends RunProjectionNode = RunProjectionNode> = {
  readonly run: {
    readonly runId: string;
  };
  readonly transcriptNodes?: readonly TNode[];
};

export type RunProjectionDetail<TNode extends RunProjectionNode = RunProjectionNode> = {
  readonly runId: string;
  readonly transcript?: {
    readonly transcriptNodes?: readonly TNode[];
  };
};

export type RunReadModelPatchState = {
  readonly workView?: RunProjectionWorkView;
  readonly transcriptNodesByRunId: Record<string, readonly RunProjectionNode[]>;
};

export type RunReadModelPatch<
  TWorkView extends RunProjectionWorkView<TNode>,
  TDetail extends RunProjectionDetail<TNode>,
  TNode extends RunProjectionNode
> = {
  readonly workView: TWorkView | undefined;
  readonly detail: TDetail | undefined;
  readonly transcriptNodes: readonly TNode[];
  readonly transcriptNodesByRunId: Record<string, readonly TNode[]>;
};

export function transcriptNodesFrom<TNode extends RunProjectionNode>(
  workView: RunProjectionWorkView<TNode> | undefined
): readonly TNode[] {
  return workView?.transcriptNodes ?? [];
}

export function nextWorkViewForRun<TWorkView extends RunProjectionWorkView>(
  runId: string,
  incoming: TWorkView | undefined,
  previous: TWorkView | undefined,
  reusePrevious = true
): TWorkView | undefined {
  if (incoming?.run.runId === runId) return incoming;
  if (reusePrevious && previous?.run.runId === runId) return previous;
  return undefined;
}

export function detailForRun<T extends RunProjectionDetail | undefined>(
  runId: string,
  detail: T
): T | undefined {
  return detail?.runId === runId ? detail : undefined;
}

export function createRunReadModelPatch<
  TWorkView extends RunProjectionWorkView<TNode>,
  TDetail extends RunProjectionDetail<TNode>,
  TNode extends RunProjectionNode
>(
  previous: {
    readonly workView?: TWorkView;
    readonly transcriptNodesByRunId: Record<string, readonly TNode[]>;
  },
  input: {
    readonly runId: string;
    readonly workView: TWorkView | undefined;
    readonly detail: TDetail | undefined;
    readonly reusePreviousWorkView?: boolean;
  }
): RunReadModelPatch<TWorkView, TDetail, TNode> {
  const workView = nextWorkViewForRun(
    input.runId,
    input.workView,
    previous.workView,
    input.reusePreviousWorkView !== false
  );
  const transcriptNodes = transcriptNodesFrom(workView);
  return {
    workView,
    detail: input.detail,
    transcriptNodes,
    transcriptNodesByRunId: mergeTranscriptNodesByRunId(previous.transcriptNodesByRunId, input.runId, transcriptNodes),
  };
}
