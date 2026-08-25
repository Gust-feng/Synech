/**
 * Facts frozen for one Ordinary run.  This is the canonical runtime context;
 * it deliberately keeps context, authorization and attachment facts separate.
 */
export type OrdinaryRunContextReference = {
  readonly attachmentId?: string;
  readonly ref: string;
  readonly pathGranted?: boolean;
  readonly automaticSpaceReference?: boolean;
  readonly sourceIdentity?: string;
  /** Frozen Workspace mount identity used to reject writes after reconnect. */
  readonly mountVersion?: string;
  readonly kind: "user_goal" | "workspace" | "file" | "project" | "web" | "runtime";
  readonly title?: string;
  readonly summary?: string;
  readonly metadata?: {
    readonly byteLength?: number;
    readonly mimeType?: string;
    readonly available?: boolean;
    readonly truncated?: boolean;
  };
  readonly readonlyPreview?: {
    readonly title?: string;
    readonly text: string;
    readonly truncated: boolean;
  };
};

export type OrdinaryRunContext = {
  readonly contextId: string;
  readonly goal: string;
  readonly goalId?: string;
  readonly traceId?: string;
  readonly contextRefs: readonly OrdinaryRunContextReference[];
  readonly permissionBoundaryRefs: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
};

export function createOrdinaryRunContext(input: {
  readonly goal: string;
  readonly contextId?: string;
  readonly goalId?: string;
  readonly traceId?: string;
  readonly contextRefs?: readonly OrdinaryRunContextReference[];
  readonly permissionBoundaryRefs?: readonly string[];
  readonly createdAt?: string;
}): OrdinaryRunContext {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    contextId: input.contextId ?? `context:${createdAt}`,
    goal: input.goal,
    goalId: input.goalId,
    traceId: input.traceId,
    contextRefs: (input.contextRefs ?? []).map(cloneOrdinaryRunContextReference),
    permissionBoundaryRefs: [...(input.permissionBoundaryRefs ?? [])],
    createdAt,
    updatedAt: createdAt,
  };
}

export function cloneOrdinaryRunContext(context: OrdinaryRunContext): OrdinaryRunContext {
  return {
    ...context,
    contextRefs: context.contextRefs.map(cloneOrdinaryRunContextReference),
    permissionBoundaryRefs: [...context.permissionBoundaryRefs],
  };
}

function cloneOrdinaryRunContextReference(ref: OrdinaryRunContextReference): OrdinaryRunContextReference {
  return {
    ...ref,
    metadata: ref.metadata === undefined ? undefined : { ...ref.metadata },
    readonlyPreview: ref.readonlyPreview === undefined ? undefined : { ...ref.readonlyPreview },
  };
}
