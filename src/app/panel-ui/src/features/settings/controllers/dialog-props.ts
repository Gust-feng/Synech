import type { WorkbenchSettingsDialogProps } from "../components/workbench-dialog";
import type { SettingsGroup } from "../components/types";
import type { MemorySettingsScope } from "../../memory/MemorySettingsPanel";

export function workbenchSettingsDialogPropsFrom(options: {
  readonly settingsOpen: boolean;
  readonly closeSettings: () => void;
  readonly settingsGroup: SettingsGroup;
  readonly memoryScope: MemorySettingsScope | null;
  readonly onOpenConversation?: (conversationId: string) => void;
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
    memoryScope: options.memoryScope,
    onOpenConversation: options.onOpenConversation,
    app: options.app,
    modelCatalogs: options.modelCatalogs,
    forms: options.forms,
    preferences: options.preferences,
    saving: options.saving,
    actions: options.actions,
  };
}
