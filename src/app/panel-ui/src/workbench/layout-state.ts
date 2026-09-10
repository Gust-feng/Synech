export type WorkbenchPane = "reading" | "conversation";
export type WorkbenchLayoutMode = WorkbenchPane | "split";

export const WORKBENCH_SPLIT = {
  minimumWidth: 760,
  readingMinimum: 360,
  conversationMinimum: 340,
  gutter: 6,
  defaultReadingRatio: 60,
} as const;

export type WorkbenchLayoutState = {
  readonly activePane: WorkbenchPane;
  readonly splitEnabled: boolean;
};

export type WorkbenchLayoutAction =
  | { readonly type: "select-pane"; readonly pane: WorkbenchPane }
  | { readonly type: "set-mode"; readonly mode: WorkbenchLayoutMode };

export function createWorkbenchLayout(): WorkbenchLayoutState {
  return { activePane: "reading", splitEnabled: false };
}

export function reduceWorkbenchLayout(state: WorkbenchLayoutState, action: WorkbenchLayoutAction): WorkbenchLayoutState {
  if (action.type === "select-pane") {
    return state.activePane === action.pane ? state : { ...state, activePane: action.pane };
  }
  if (action.mode === "split") return { ...state, splitEnabled: true };
  return { activePane: action.mode, splitEnabled: false };
}

export function workbenchLayoutMode(state: WorkbenchLayoutState, contentWidth: number): WorkbenchLayoutMode {
  return state.splitEnabled && contentWidth >= WORKBENCH_SPLIT.minimumWidth ? "split" : state.activePane;
}
