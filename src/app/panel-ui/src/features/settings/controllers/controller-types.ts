import type React from "react";
import type { AppState } from "../../../workbench/state";

/** Shared settings snapshot and the single AppState update boundary. */
export type SettingsControllerContext = {
  readonly app: AppState;
  readonly setApp: React.Dispatch<React.SetStateAction<AppState>>;
  readonly mountedRef: React.MutableRefObject<boolean>;
};
