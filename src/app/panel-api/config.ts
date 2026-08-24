import type {
  ConfiguredCommandShellKind,
  ModelCapabilities as DomainModelCapabilities,
  ModelProviderModelCatalog as DomainModelProviderModelCatalog,
  ModelProviderPreset as DomainModelProviderPreset,
  OrdinaryCapabilitySnapshot,
  SanitizedCommandShellConfig,
  SanitizedCommandShellOption,
  SanitizedInformationAccessConfig,
  SanitizedModelProviderConfig,
  SanitizedOrdinaryAgentPromptConfig,
  SanitizedRuntimeEnvironmentTool,
  SanitizedSkillTriggerConfig,
  SanitizedToolConfirmationConfig,
} from "../../domain/config/index.js";
import type { ToolConfirmationPolicy as DomainToolConfirmationPolicy } from "../../domain/tools/index.js";

export type ConfigResponse = {
  readonly ok?: boolean;
  readonly status?: "completed" | "failed";
  readonly product?: ProductInfo;
  readonly appearance?: AppearanceConfig;
  readonly config?: ModelProviderProfile;
  readonly profile?: ModelProviderProfile;
  readonly activeProfile?: ModelProviderProfile;
  readonly profiles?: readonly ModelProviderProfile[];
  readonly modelProviderOrder?: readonly string[];
  readonly modelCatalogs?: readonly ModelProviderModelCatalog[];
  readonly modelCapabilityProfiles?: readonly ModelCapabilityProfile[];
  readonly modelProviderMarket?: ModelProviderMarket;
  readonly commandShell?: CommandShellConfig;
  readonly toolConfirmation?: ToolConfirmationConfig;
  readonly ordinaryAgent?: OrdinaryAgentPromptConfig;
  readonly skillTrigger?: SkillTriggerConfig;
  readonly informationAccess?: SanitizedInformationAccessConfig;
  readonly capabilities?: ConfigCapabilities;
};

export type ModelProviderProfile = Partial<SanitizedModelProviderConfig>;
export type ModelCapabilities = Partial<DomainModelCapabilities>;
export type ModelProviderModelCatalog = DomainModelProviderModelCatalog;
export type ModelProviderPreset = DomainModelProviderPreset;
export type ToolConfirmationPolicy = DomainToolConfirmationPolicy;

export type ModelCapabilityProfile = {
  readonly profileId: string;
  readonly providerKind: SanitizedModelProviderConfig["providerKind"];
  readonly protocolKind: SanitizedModelProviderConfig["protocolKind"];
  readonly model: string;
  readonly capabilities: DomainModelCapabilities;
};

export type ModelProviderMarket = {
  readonly presets: readonly DomainModelProviderPreset[];
};

export type ConfigCapabilities = Partial<Pick<
  OrdinaryCapabilitySnapshot,
  "activeModel" | "toolConfirmation" | "skillTrigger" | "modelCapabilities" | "warnings"
>>;

export type ProductInfo = {
  readonly name: string;
  readonly version: string;
  readonly defaultEntry: string;
  readonly configDirectory: string;
  readonly productHome: string;
};

export type AppearanceConfig = {
  readonly source?: "builtin_panel_styles" | "user_config" | string;
  readonly themeLabel?: string;
  readonly densityLabel?: string;
  readonly colorScheme?: "light" | "dark" | string;
  readonly configurable?: boolean;
  readonly updatedAt?: string;
};

export type CommandShellKind = Exclude<ConfiguredCommandShellKind, "auto">;
export type { ConfiguredCommandShellKind };
export type CommandShellOption = Partial<SanitizedCommandShellOption>;
export type RuntimeEnvironmentTool = Partial<SanitizedRuntimeEnvironmentTool>;
export type CommandShellConfig = Partial<Omit<SanitizedCommandShellConfig, "availableShells" | "runtimeTools">> & {
  readonly availableShells?: readonly CommandShellOption[];
  readonly runtimeTools?: readonly RuntimeEnvironmentTool[];
};
export type ToolConfirmationConfig = Partial<SanitizedToolConfirmationConfig>;
export type OrdinaryAgentPromptConfig = Partial<Omit<
  SanitizedOrdinaryAgentPromptConfig,
  "systemPromptVariant" | "variants"
>> & {
  readonly systemPromptVariant?: string;
  readonly variants?: readonly {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
  }[];
};
export type SkillTriggerMode = SanitizedSkillTriggerConfig["mode"];
export type SkillTriggerConfig = Partial<SanitizedSkillTriggerConfig>;

export type PanelConfigSnapshotResponse = ConfigResponse & {
  readonly ok: true;
  readonly status: "completed";
  readonly product: ProductInfo;
  readonly config: SanitizedModelProviderConfig;
  readonly profiles: readonly SanitizedModelProviderConfig[];
  readonly modelProviderOrder: readonly string[];
  readonly modelCatalogs: readonly DomainModelProviderModelCatalog[];
  readonly modelCapabilityProfiles: readonly ModelCapabilityProfile[];
  readonly modelProviderMarket: ModelProviderMarket;
  readonly commandShell: SanitizedCommandShellConfig;
  readonly toolConfirmation: SanitizedToolConfirmationConfig;
  readonly ordinaryAgent: SanitizedOrdinaryAgentPromptConfig;
  readonly skillTrigger: SanitizedSkillTriggerConfig;
  readonly informationAccess: SanitizedInformationAccessConfig;
  readonly capabilities: OrdinaryCapabilitySnapshot;
};
