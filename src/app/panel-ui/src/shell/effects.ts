import { useEffect, type Dispatch, type SetStateAction } from "react";
import {
  getModelUsageDisplayEnabled,
  subscribeModelUsageDisplayChanged,
} from "../features/settings/model/usage-display";

export type AppShellEffectsOptions = {
  readonly sidebarCollapsed: boolean;
  readonly persistSidebarCollapsed: (collapsed: boolean) => void;
  readonly setModelUsageDisplayEnabled: Dispatch<SetStateAction<boolean>>;
};

export function useAppShellEffects(options: AppShellEffectsOptions): void {
  useEffect(() => {
    options.persistSidebarCollapsed(options.sidebarCollapsed);
  }, [options.persistSidebarCollapsed, options.sidebarCollapsed]);

  useEffect(() => subscribeModelUsageDisplayChanged(() => {
    options.setModelUsageDisplayEnabled(getModelUsageDisplayEnabled());
  }), [options.setModelUsageDisplayEnabled]);

}
