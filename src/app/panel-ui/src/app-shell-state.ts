import { useState, type Dispatch, type SetStateAction } from "react";
import {
  getModelUsageDisplayEnabled,
  saveModelUsageDisplayEnabled,
} from "./app-model-usage-display";
import { type SettingsGroup } from "./components/settings-types";
import { readLocalPreference, writeLocalPreference } from "./app-local-preferences";
import { getDeveloperModeEnabled, saveDeveloperModeEnabled } from "./app-developer-mode";
import { getConversationFollowUpMode, saveConversationFollowUpMode } from "./app-follow-up-preference";
import type { ConversationFollowUpMode } from "./contracts/composer";

export type AppShellState = {
  readonly settingsOpen: boolean;
  readonly setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  readonly settingsGroup: SettingsGroup;
  readonly sidebarCollapsed: boolean;
  readonly setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  readonly modelUsageDisplayEnabled: boolean;
  readonly setModelUsageDisplayEnabled: Dispatch<SetStateAction<boolean>>;
  readonly developerModeEnabled: boolean;
  readonly conversationFollowUpMode: ConversationFollowUpMode;
  readonly pinningConversationIds: ReadonlySet<string>;
  readonly setPinningConversationIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  readonly inputCloseSignal: number;
  readonly setInputCloseSignal: Dispatch<SetStateAction<number>>;
  readonly openSettings: (group?: SettingsGroup) => void;
  readonly closeSettings: () => void;
  readonly changeModelUsageDisplay: (enabled: boolean) => void;
  readonly changeDeveloperMode: (enabled: boolean) => void;
  readonly changeConversationFollowUpMode: (mode: ConversationFollowUpMode) => void;
};

export function useAppShellState(): AppShellState {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsGroup, setSettingsGroup] = useState<SettingsGroup>("models");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsedPreference);
  const [modelUsageDisplayEnabled, setModelUsageDisplayEnabled] = useState(getModelUsageDisplayEnabled);
  const [developerModeEnabled, setDeveloperModeEnabled] = useState(getDeveloperModeEnabled);
  const [conversationFollowUpMode, setConversationFollowUpMode] = useState(getConversationFollowUpMode);
  const [pinningConversationIds, setPinningConversationIds] = useState<ReadonlySet<string>>(() => new Set());
  const [inputCloseSignal, setInputCloseSignal] = useState(0);

  function openSettings(group: SettingsGroup = "models"): void {
    setInputCloseSignal((value) => value + 1);
    setSettingsGroup(group);
    setSettingsOpen(true);
  }

  function closeSettings(): void {
    setSettingsOpen(false);
  }

  function changeModelUsageDisplay(enabled: boolean): void {
    setModelUsageDisplayEnabled(enabled);
    saveModelUsageDisplayEnabled(enabled);
  }

  function changeDeveloperMode(enabled: boolean): void {
    setDeveloperModeEnabled(enabled);
    saveDeveloperModeEnabled(enabled);
  }

  function changeConversationFollowUpMode(mode: ConversationFollowUpMode): void {
    setConversationFollowUpMode(mode);
    saveConversationFollowUpMode(mode);
  }

  return {
    settingsOpen,
    setSettingsOpen,
    settingsGroup,
    sidebarCollapsed,
    setSidebarCollapsed,
    modelUsageDisplayEnabled,
    setModelUsageDisplayEnabled,
    developerModeEnabled,
    conversationFollowUpMode,
    pinningConversationIds,
    setPinningConversationIds,
    inputCloseSignal,
    setInputCloseSignal,
    openSettings,
    closeSettings,
    changeModelUsageDisplay,
    changeDeveloperMode,
    changeConversationFollowUpMode,
  };
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = "shell.sidebar-collapsed";

function loadSidebarCollapsedPreference(): boolean {
  return readLocalPreference(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
}

export function persistSidebarCollapsedPreference(collapsed: boolean): void {
  writeLocalPreference(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false");
}
