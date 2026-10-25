export type WorkbenchView = "home" | "space" | "search" | "brain";

export type ConversationOwnerSelection = {
  readonly kind: "space";
  readonly id: string;
};

export function sameConversationOwner(left: ConversationOwnerSelection | null | undefined, right: ConversationOwnerSelection | null | undefined): boolean {
  return left != null && right != null && left.kind === right.kind && left.id === right.id;
}

export function selectedConversationOwner(state: Pick<WorkbenchNavigationState, "view" | "activeSpaceId">): ConversationOwnerSelection | null {
  if (state.view === "space" && state.activeSpaceId !== null) return { kind: "space", id: state.activeSpaceId };
  return null;
}

export type WorkbenchNavigationState = {
  readonly view: WorkbenchView;
  readonly previousView: WorkbenchView;
  readonly brainSelectedId: string | null;
  readonly spaceTargetId: string | null;
  readonly spaceEntryRevision: number;
  readonly activeSpaceId: string | null;
  readonly homeOwnerSelection: ConversationOwnerSelection | null;
  readonly homeFocusRequest: number;
};

export type WorkbenchNavigationAction =
  | { readonly type: "navigate"; readonly target: WorkbenchView }
  | { readonly type: "set-brain-selection"; readonly id: string | null }
  | { readonly type: "set-space-target"; readonly id: string | null }
  | { readonly type: "set-active-space"; readonly id: string | null }
  | { readonly type: "set-home-owner"; readonly owner: ConversationOwnerSelection | null }
  | { readonly type: "focus-home-input" }
  | {
      readonly type: "sync-context-selection";
      readonly spaceIds: readonly string[];
    };

export function createInitialWorkbenchNavigationState(): WorkbenchNavigationState {
  return {
    view: "home",
    previousView: "home",
    brainSelectedId: null,
    spaceTargetId: null,
    spaceEntryRevision: 0,
    activeSpaceId: null,
    homeOwnerSelection: null,
    homeFocusRequest: 0,
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
        spaceEntryRevision: action.target === "space" ? state.spaceEntryRevision + 1 : state.spaceEntryRevision,
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
    case "sync-context-selection": {
      const firstSpaceId = action.spaceIds[0];
      const activeSpaceId = state.activeSpaceId !== null && action.spaceIds.includes(state.activeSpaceId)
        ? state.activeSpaceId
        : firstSpaceId ?? null;
      const owner = state.homeOwnerSelection;
      const ownerStillExists = owner !== null && action.spaceIds.includes(owner.id);
      const homeOwnerSelection = ownerStillExists
        ? owner
        : firstSpaceId === undefined
          ? null
          : { kind: "space" as const, id: firstSpaceId };
      const ownerUnchanged = state.homeOwnerSelection?.kind === homeOwnerSelection?.kind
        && state.homeOwnerSelection?.id === homeOwnerSelection?.id;
      if (state.activeSpaceId === activeSpaceId
        && ownerUnchanged) return state;
      return {
        ...state,
        activeSpaceId,
        homeOwnerSelection,
      };
    }
  }
}
