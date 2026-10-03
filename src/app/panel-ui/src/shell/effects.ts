import { useEffect } from "react";

export type AppShellEffectsOptions = {
  readonly sidebarCollapsed: boolean;
  readonly persistSidebarCollapsed: (collapsed: boolean) => void;
};

export function useAppShellEffects(options: AppShellEffectsOptions): void {
  useEffect(() => {
    options.persistSidebarCollapsed(options.sidebarCollapsed);
  }, [options.persistSidebarCollapsed, options.sidebarCollapsed]);

}
