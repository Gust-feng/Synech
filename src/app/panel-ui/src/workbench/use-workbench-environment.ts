import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import type { PersonalSpaceProjection } from "../personal-workbench/space";
import type { PersonalKnowledgeLoadState } from "../personal-workbench/workbench/app/components/personalKnowledgeClient";
import {
  clearPersonalKnowledgeError,
  getPersonalKnowledgeError,
  getPersonalKnowledgeLoadState,
  initializePersonalKnowledge,
  refreshPersonalKnowledge,
  setPersonalKnowledgePersistenceEnabled,
  subscribePersonalKnowledge,
} from "../personal-workbench/workbench/app/components/personalKnowledgeClient";
import { warmStartupReferencePreviews } from "../personal-workbench/workbench/app/components/space-reference-preview-warmup";
import { handleReadingSizeWheel, applyPrefs, loadPrefs } from "../shell/reading-preferences";
import type { WorkbenchView } from "./navigation-state";

export type WorkbenchEnvironmentInput = {
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly personalKnowledgePersistenceEnabled: boolean;
  readonly spaceLoadStateLoading: boolean;
  readonly spaces: readonly PersonalSpaceProjection[];
  readonly workspaceIds: readonly string[];
  readonly view: WorkbenchView;
  readonly syncContextSelection: (input: {
    readonly spaceIds: readonly string[];
    readonly workspaceIds: readonly string[];
  }) => void;
};

export type WorkbenchEnvironmentState = {
  readonly knowledgeLoadState: PersonalKnowledgeLoadState;
  readonly knowledgeError?: string;
  readonly retryKnowledge: () => Promise<void>;
  readonly refreshKnowledge: () => Promise<void>;
  readonly dismissKnowledgeError: () => void;
};

export function useWorkbenchEnvironment(input: WorkbenchEnvironmentInput): WorkbenchEnvironmentState {
  const knowledgeLoadState = useSyncExternalStore(
    subscribePersonalKnowledge,
    getPersonalKnowledgeLoadState,
    getPersonalKnowledgeLoadState,
  );
  const spaceIdsKey = input.spaces.map((space) => space.spaceId).join("\\0");
  const workspaceIdsKey = input.workspaceIds.join("\\0");
  const knowledgeError = useSyncExternalStore(
    subscribePersonalKnowledge,
    getPersonalKnowledgeError,
    getPersonalKnowledgeError,
  );

  useEffect(() => {
    setPersonalKnowledgePersistenceEnabled(input.personalKnowledgePersistenceEnabled);
  }, [input.personalKnowledgePersistenceEnabled]);

  useEffect(() => {
    input.syncContextSelection({
      spaceIds: input.spaces.map((space) => space.spaceId),
      workspaceIds: input.workspaceIds,
    });
    if (input.personalKnowledgePersistenceEnabled && !input.spaceLoadStateLoading) {
      void initializePersonalKnowledge().catch(() => undefined);
    }
  }, [
    input.personalKnowledgePersistenceEnabled,
    input.spaceLoadStateLoading,
    spaceIdsKey,
    input.syncContextSelection,
    workspaceIdsKey,
  ]);

  useEffect(() => {
    if (input.spaceLoadStateLoading) return undefined;
    return warmStartupReferencePreviews(input.spaces);
  }, [input.spaceLoadStateLoading, input.spaces]);

  useEffect(() => {
    const root = input.rootRef.current;
    if (root === null) return undefined;
    const onWheel = (event: WheelEvent): void => {
      handleReadingSizeWheel(event);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [input.rootRef]);

  useEffect(() => {
    applyPrefs(loadPrefs());
  }, []);

  const previousViewRef = useRef(input.view);
  useEffect(() => {
    const viewChanged = previousViewRef.current !== input.view;
    previousViewRef.current = input.view;
    if (
      !viewChanged
      || !input.personalKnowledgePersistenceEnabled
      || !isKnowledgeView(input.view)
      || knowledgeLoadState.status !== "ready"
    ) return;
    void refreshPersonalKnowledge().catch(() => undefined);
  }, [input.personalKnowledgePersistenceEnabled, input.view, knowledgeLoadState.status]);

  return {
    knowledgeLoadState,
    knowledgeError,
    retryKnowledge: initializePersonalKnowledge,
    refreshKnowledge: refreshPersonalKnowledge,
    dismissKnowledgeError: clearPersonalKnowledgeError,
  };
}


function isKnowledgeView(view: WorkbenchView): boolean {
  return view === "space" || view === "brain" || view === "search";
}