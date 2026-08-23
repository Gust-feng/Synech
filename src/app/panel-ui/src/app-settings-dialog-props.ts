import type { WorkbenchSettingsDialogProps } from "./components/workbench-settings-dialog";
import type { SettingsGroup } from "./components/settings-types";

export function workbenchSettingsDialogPropsFrom(options: {
  readonly settingsOpen: boolean;
  readonly closeSettings: () => void;
  readonly settingsGroup: SettingsGroup;
  readonly app: WorkbenchSettingsDialogProps["app"];
  readonly modelCatalogs: WorkbenchSettingsDialogProps["modelCatalogs"];
  readonly forms: WorkbenchSettingsDialogProps["forms"];
  readonly preferences: WorkbenchSettingsDialogProps["preferences"];
  readonly saving: WorkbenchSettingsDialogProps["saving"];
  readonly actions: WorkbenchSettingsDialogProps["actions"];
}): WorkbenchSettingsDialogProps | undefined {
  if (!options.settingsOpen) return undefined;
  return {
    open: true,
    onClose: options.closeSettings,
    initialGroup: options.settingsGroup,
    app: options.app,
    modelCatalogs: options.modelCatalogs,
    forms: options.forms,
    preferences: options.preferences,
    saving: options.saving,
    actions: options.actions,
  };
}