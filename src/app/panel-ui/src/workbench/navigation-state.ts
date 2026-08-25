export type WorkbenchView = "home" | "space" | "search" | "brain" | "memory";

export type ConversationOwnerSelection = {
  readonly kind: "space" | "workspace";
  readonly id: string;
};

export type ConversationSurfaceRequest = {
  readonly conversationId: string;
  readonly spaceId: string;
};

export type WorkbenchNavigationState = {
  readonly view: WorkbenchView;
  readonly previousView: WorkbenchView;
  readonly brainSelectedId: string | null;
  readonly spaceTargetId: string | null;
  readonly activeSpaceId: string | null;
  readonly homeOwnerSelection: ConversationOwnerSelection | null;
  readonly homeFocusRequest: number;
  readonly conversationSurfaceRequest: ConversationSurfaceRequest | null;
};

export type WorkbenchNavigationAction =
  | { readonly type: "navigate"; readonly target: WorkbenchView }
  | { readonly type: "set-brain-selection"; readonly id: string | null }
  | { readonly type: "set-space-target"; readonly id: string | null }
  | { readonly type: "set-active-space"; readonly id: string | null }
  | { readonly type: "set-home-owner"; readonly owner: ConversationOwnerSelection | null }
  | { readonly type: "focus-home-input" }
  | { readonly type: "set-conversation-surface"; readonly request: ConversationSurfaceRequest | null }
  | {
      readonly type: "sync-context-selection";
      readonly spaceIds: readonly string[];
      readonly workspaceIds: readonly string[];
    };

export function createInitialWorkbenchNavigationState(): WorkbenchNavigationState {
  return {
    view: "home",
    previousView: "home",
    brainSelectedId: null,
    spaceTargetId: null,
    activeSpaceId: null,
    homeOwnerSelection: null,
    homeFocusRequest: 0,
    conversationSurfaceRequest: null,
  };
}

export function reduceWorkbenchNavigation(
  state: WorkbenchNavigationState,
  action: WorkbenchNavigationAction,
): WorkbenchNavigationState {
  switch (action.type) {
    case "navigate":
      return {
        ...state,
        view: action.target,
        previousView: action.target === "search" ? state.view : state.previousView,
        spaceTargetId: null,
        brainSelectedId: action.target === "brain" ? state.brainSelectedId : null,
      };
    case "set-brain-selection":
      return { ...state, brainSelectedId: action.id };
    case "set-space-target":
      return { ...state, spaceTargetId: action.id };
    case "set-active-space":
      return { ...state, activeSpaceId: action.id };
    case "set-home-owner":
      return { ...state, homeOwnerSelection: action.owner };
    case "focus-home-input":
      return { ...state, homeFocusRequest: state.homeFocusRequest + 1 };
    case "set-conversation-surface":
      return { ...state, conversationSurfaceRequest: action.request };
    case "sync-context-selection": {
      const firstSpaceId = action.spaceIds[0];
      const activeSpaceId = state.activeSpaceId !== null && action.spaceIds.includes(state.activeSpaceId)
        ? state.activeSpaceId
        : firstSpaceId ?? null;
      const owner = state.homeOwnerSelection;
      const ownerStillExists = owner !== null && (
        owner.kind === "space"
          ? action.spaceIds.includes(owner.id)
          : action.workspaceIds.includes(owner.id)
      );
      return {
        ...state,
        activeSpaceId,
        homeOwnerSelection: ownerStillExists
          ? owner
          : firstSpaceId === undefined
            ? null
            : { kind: "space", id: firstSpaceId },
      };
    }
  }
}
