import { useCallback, useReducer, useState } from "react";
import { readLocalPreference, writeLocalPreference } from "../shell/local-preferences";
import { createWorkbenchLayout, reduceWorkbenchLayout, workbenchLayoutMode, WORKBENCH_SPLIT, type WorkbenchLayoutMode, type WorkbenchPane } from "./layout-state";
export type { WorkbenchLayoutMode, WorkbenchPane } from "./layout-state";

export function useWorkbenchLayout() {
  const [state, dispatch] = useReducer(reduceWorkbenchLayout, undefined, createWorkbenchLayout);
  const [contentWidth, setContentWidth] = useState(0);
  const [explorerPreference, setExplorerPreference] = useState(() => (
    readLocalPreference("workbench.explorer-collapsed") === "true"
  ));
  const compact = contentWidth > 0 && contentWidth < WORKBENCH_SPLIT.minimumWidth;
  const mode = workbenchLayoutMode(state, contentWidth === 0 ? WORKBENCH_SPLIT.minimumWidth : contentWidth);

  const setMode = useCallback((next: WorkbenchLayoutMode) => {
    dispatch({ type: "set-mode", mode: next });
  }, []);
  const showConversation = useCallback(() => {
    dispatch({ type: "select-pane", pane: "conversation" });
  }, []);
  const showReading = useCallback(() => {
    dispatch({ type: "select-pane", pane: "reading" });
  }, []);
  const setActivePane = useCallback((pane: WorkbenchPane) => {
    dispatch({ type: "select-pane", pane });
  }, []);
  const toggleExplorer = useCallback(() => {
    const next = !explorerPreference;
    setExplorerPreference(next);
    writeLocalPreference("workbench.explorer-collapsed", String(next));
  }, [explorerPreference]);

  return {
    mode,
    splitEnabled: state.splitEnabled,
    compact,
    explorerCollapsed: explorerPreference,
    setMode,
    showConversation,
    showReading,
    setActivePane,
    toggleExplorer,
    onContentResize: setContentWidth,
  };
}
