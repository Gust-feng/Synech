export type ConfirmationIdentity = {
  readonly confirmationId: string;
  readonly ownerRunId?: string;
};

export type ConfirmationNodeLike<TConfirmation extends ConfirmationIdentity> = {
  readonly nodeId: string;
  readonly kind: string;
  readonly confirmation?: TConfirmation;
};

export type TimelineConfirmationProjection<TConfirmation extends ConfirmationIdentity> = {
  readonly current?: TConfirmation;
  readonly currentNodeId?: string;
};

export function timelineConfirmationProjection<TConfirmation extends ConfirmationIdentity>(
  nodes: readonly ConfirmationNodeLike<TConfirmation>[],
  pending: TConfirmation | undefined
): TimelineConfirmationProjection<TConfirmation> {
  if (pending === undefined) {
    return {};
  }
  const currentNode = [...nodes].reverse().find((node) => pendingMatchesConfirmationNode(node, pending));
  return {
    current: currentNode === undefined ? pending : confirmationForNode(currentNode, pending),
    currentNodeId: currentNode?.nodeId,
  };
}

export function confirmationForNode<TConfirmation extends ConfirmationIdentity>(
  node: ConfirmationNodeLike<TConfirmation>,
  pending: TConfirmation | undefined
): TConfirmation | undefined {
  if (node.kind !== "confirmation") return undefined;
  const nodeConfirmation = node.confirmation;
  if (pending !== undefined && nodeConfirmation !== undefined && pending.confirmationId === nodeConfirmation.confirmationId) {
    return pending;
  }
  return nodeConfirmation;
}

export function pendingForTurn<TConfirmation extends ConfirmationIdentity>(
  pending: TConfirmation | undefined,
  runId: string | undefined
): TConfirmation | undefined {
  if (pending === undefined || runId === undefined) return undefined;
  const pendingRunId = confirmationOwnerRunId(pending);
  return pendingRunId === undefined || pendingRunId === runId ? pending : undefined;
}

export function confirmationOwnerRunId(confirmation: ConfirmationIdentity): string | undefined {
  return confirmation.ownerRunId;
}

function pendingMatchesConfirmationNode<TConfirmation extends ConfirmationIdentity>(
  node: ConfirmationNodeLike<TConfirmation>,
  pending: TConfirmation
): boolean {
  return node.kind === "confirmation" &&
    node.confirmation !== undefined &&
    node.confirmation.confirmationId === pending.confirmationId;
}
