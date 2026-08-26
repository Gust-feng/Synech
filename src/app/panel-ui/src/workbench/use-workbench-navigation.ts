import { useCallback, useReducer } from "react";
import {
  createInitialWorkbenchNavigationState,
  reduceWorkbenchNavigation,
  type ConversationOwnerSelection,
  type ConversationSurfaceRequest,
  type WorkbenchNavigationState,
  type WorkbenchView,
} from "./navigation-state";

export type WorkbenchNavigationController = {
  readonly state: WorkbenchNavigationState;
  readonly navigate: (target: WorkbenchView) => void;
  readonly setBrainSelection: (id: string | null) => void;
  readonly setSpaceTarget: (id: string | null) => void;
  readonly setActiveSpace: (id: string | null) => void;
  readonly setHomeOwner: (owner: ConversationOwnerSelection | null) => void;
  readonly focusHomeInput: () => void;
  readonly setConversationSurface: (request: ConversationSurfaceRequest | null) => void;
  readonly syncContextSelection: (input: {
    readonly spaceIds: readonly string[];
    readonly workspaceIds: readonly string[];
  }) => void;
};

export function useWorkbenchNavigation(): WorkbenchNavigationController {
  const [state, dispatch] = useReducer(
    reduceWorkbenchNavigation,
    undefined,
    createInitialWorkbenchNavigationState,
  );

  const navigate = useCallback((target: WorkbenchView) => {
    dispatch({ type: "navigate", target });
  }, []);
  const setBrainSelection = useCallback((id: string | null) => {
    dispatch({ type: "set-brain-selection", id });
  }, []);
  const setSpaceTarget = useCallback((id: string | null) => {
    dispatch({ type: "set-space-target", id });
  }, []);
  const setActiveSpace = useCallback((id: string | null) => {
    dispatch({ type: "set-active-space", id });
  }, []);
  const setHomeOwner = useCallback((owner: ConversationOwnerSelection | null) => {
    dispatch({ type: "set-home-owner", owner });
  }, []);
  const focusHomeInput = useCallback(() => {
    dispatch({ type: "focus-home-input" });
  }, []);
  const setConversationSurface = useCallback((request: ConversationSurfaceRequest | null) => {
    dispatch({ type: "set-conversation-surface", request });
  }, []);
  const syncContextSelection = useCallback((input: {
    readonly spaceIds: readonly string[];
    readonly workspaceIds: readonly string[];
  }) => {
    dispatch({ type: "sync-context-selection", ...input });
  }, []);

  return {
    state,
    navigate,
    setBrainSelection,
    setSpaceTarget,
    setActiveSpace,
    setHomeOwner,
    focusHomeInput,
    setConversationSurface,
    syncContextSelection,
  };
}