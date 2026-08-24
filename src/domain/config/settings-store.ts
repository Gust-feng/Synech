import type { OrdinaryAgentPromptSettings, SkillTriggerSettings } from "./agent-settings.js";

import type { InformationAccessSettings } from "./information-access.js";

import type { McpServerSettings } from "./mcp-settings.js";

import type {

  ModelCapabilityOverrideSettings,

  ModelProviderModelCatalog,

  ModelProviderProfileSettings,

} from "./model-settings.js";

import type {

  CommandShellSettings,

  ToolConfirmationSettings,

  ToolStateSettings,

} from "./tool-settings.js";



export type LocalSettings = {
  readonly version: 1;
  readonly activeModelProfileId: string;
  readonly modelProfiles: readonly ModelProviderProfileSettings[];
  readonly modelProviderOrder?: readonly string[];
  readonly modelCatalogs?: readonly ModelProviderModelCatalog[];
  readonly modelCapabilityOverrides?: readonly ModelCapabilityOverrideSettings[];
  readonly toolStates?: readonly ToolStateSettings[];
  readonly toolConfirmation?: ToolConfirmationSettings;
  readonly ordinaryAgent?: OrdinaryAgentPromptSettings;
  readonly skillTrigger?: SkillTriggerSettings;
  readonly commandShell?: CommandShellSettings;
  readonly mcpServers?: readonly McpServerSettings[];
  readonly informationAccess?: InformationAccessSettings;
  readonly updatedAt: string;
};

export type SettingsStore = {
  readSettings(): Promise<unknown | undefined>;
  writeSettings(settings: LocalSettings): Promise<void>;
};

export type SecretMetadata = {
  readonly configured: boolean;
  readonly updatedAt?: string;
};

export type LocalDevSecretStore = {
  getMetadata(secretRef: string): Promise<SecretMetadata>;
  readSecret(secretRef: string): Promise<string | undefined>;
  writeSecret(secretRef: string, value: string): Promise<SecretMetadata>;
  deleteSecret(secretRef: string): Promise<SecretMetadata>;
};

export type SanitizedMcpServerSecretMetadata = SecretMetadata & {
  readonly secretRef: string;
};
