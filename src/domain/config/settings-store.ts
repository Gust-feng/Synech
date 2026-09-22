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



/**
 * 澄清期联网检索设置（ADR 0001 §2.2）：默认关闭，开启时也只是摘要级检索。
 *
 * 类型与取值范围放在这里（domain/config），normalize / parse / sanitize 由
 * `src/app/config-center/research-clarification-settings.ts` 持有。
 * 声明式范围与 `WebSearchProviderSettings.maxResults` 同一归属：设置形状的合法域
 * 由契约本身说明，避免配置层反向依赖研究策略。
 */

/** 澄清期检索默认关闭：范围由用户与主会话共同澄清，不偷偷联网。 */
export const RESEARCH_CLARIFICATION_SEARCH_DEFAULT_ENABLED = false;

/** 澄清期摘要级检索的硬上限：无论用户怎么配，都不超过这个次数。 */
export const RESEARCH_CLARIFICATION_MAX_SNIPPET_SEARCHES = 4;

export type ResearchClarificationSettings = {
  readonly scopeSearchEnabled: boolean;
  readonly maxSnippetSearches: number;
  readonly updatedAt: string;
};

export type UpdateResearchClarificationConfigInput = {
  readonly scopeSearchEnabled?: boolean;
  readonly maxSnippetSearches?: number;
};

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
  readonly researchClarification?: ResearchClarificationSettings;
  readonly updatedAt: string;
};

export type SettingsStore = {
  readSettings(): Promise<unknown | undefined>;
  writeSettings(settings: LocalSettings): Promise<void>;
  /** Moves an incompatible settings document aside before the owner recreates defaults. */
  quarantineInvalidSettings?(): Promise<string | undefined>;
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

/** 澄清期检索设置的界面投影：label/summary 只做展示，不承担程序分支。 */
export type SanitizedResearchClarificationConfig = {
  readonly scopeSearchEnabled: boolean;
  readonly maxSnippetSearches: number;
  readonly label: string;
  readonly summary: string;
  readonly updatedAt: string;
};
