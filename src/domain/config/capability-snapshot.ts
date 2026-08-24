import type {

  ToolCategory,

  ToolConfirmationPolicy,

  ToolFileDisplayOperation,

  ToolInputSchema,

  ToolOperationType,

  ToolRiskLevel,

  ToolRuntimeHint,

} from "../tools/contracts.js";

import type { ToolJsonSchema } from "../tools/schema.js";

import type { SanitizedSkillTriggerConfig } from "./agent-settings.js";

import type {

  McpCachedToolInfo,

  McpConfirmationMode,

  McpServerTransportKind,

  McpToolExposureMode,

} from "./mcp-settings.js";

import type {

  ModelCapabilities,

  ProtocolToolCallCapabilities,

  SanitizedModelProviderConfig,

} from "./model-settings.js";

import type { SanitizedCommandShellConfig, SanitizedToolConfirmationConfig } from "./tool-settings.js";



export type SubAgentSourceKind = "builtin" | "project" | "user" | "plugin" | "custom";

/** Runtime tool groups are product-neutral capability facts. */
export type CapabilityToolScope = "agent-basic" | "workspace" | "mcp" | "research";

export type CapabilityToolCatalogItem = {
  readonly name: string;
  readonly displayName: string;
  readonly displayDescription: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  readonly outputSchema?: ToolJsonSchema;
  readonly category: ToolCategory;
  readonly categoryLabel: string;
  readonly riskLevel: ToolRiskLevel;
  readonly riskLabel: string;
  readonly operationType: ToolOperationType;
  readonly fileOperation?: ToolFileDisplayOperation;
  readonly operationLabel: string;
  readonly requiresConfirmation: boolean;
  readonly confirmationLabel: string;
  readonly runtimeHints?: readonly ToolRuntimeHint[];
  readonly definitionHash: string;
  readonly scopes: readonly CapabilityToolScope[];
  readonly enabled: boolean;
  readonly availability: "available" | "unavailable";
  readonly disabledReason?: string;
  /** Definition is intentionally catalog-only and cannot be executed by ToolCenter. */
  readonly catalogOnly?: boolean;
};
export type CapabilityToolAvailability = {
  readonly name: string;
  readonly availability: CapabilityToolCatalogItem["availability"];
  readonly disabledReason?: string;
};

export type CapabilitySkillMetadataValue = string | number | boolean | readonly string[];

export type CapabilitySkillCompatibility = Readonly<Record<string, string | readonly string[]>>;

export type CapabilitySkillProvenanceValue = string | number | boolean | null | readonly (string | number | boolean | null)[];

export type CapabilitySkillProvenance = Readonly<Record<string, CapabilitySkillProvenanceValue>>;

export type CapabilitySkillResourceIndexItem = {
  readonly kind: "script" | "reference" | "asset";
  readonly name: string;
  readonly relativePath?: string;
  readonly sourcePath: string;
  readonly contentHash?: string;
  readonly byteLength?: number;
  readonly loadError?: string;
};

export type CapabilitySkillValidationStatus = "valid" | "invalid" | "load_error";

export type CapabilitySkillCatalogItem = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly sourcePath: string;
  readonly triggers: readonly string[];
  readonly lastUsedAt?: string;
  readonly summary?: string;
  readonly category?: string;
  readonly sourceKind?: "project" | "user" | "plugin" | "admin" | "custom";
  readonly sourceRootId?: string;
  readonly sourcePrecedence?: number;
  readonly stateKey?: string;
  readonly version?: string;
  readonly provenance?: CapabilitySkillProvenance;
  readonly whenToUse?: string;
  readonly disableModelInvocation?: boolean;
  readonly userInvocable?: boolean;
  readonly license?: string;
  readonly compatibility?: CapabilitySkillCompatibility;
  readonly metadata?: Readonly<Record<string, CapabilitySkillMetadataValue>>;
  readonly allowedTools?: readonly string[];
  readonly resources?: readonly CapabilitySkillResourceIndexItem[];
  readonly contentHash?: string;
  readonly bodyHash?: string;
  readonly loadError?: string;
  readonly validationStatus?: CapabilitySkillValidationStatus;
  readonly validationErrors?: readonly string[];
};

export type CapabilitySubAgentDiagnostic = {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
};

export type CapabilitySubAgentCatalogItem = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category?: string;
  readonly sourceKind: SubAgentSourceKind;
  readonly sourceRootId: string;
  readonly sourcePrecedence: number;
  readonly enabled: boolean;
  readonly version?: string;
  readonly whenToUse?: readonly string[];
  readonly whenNotToUse?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly diagnostics?: readonly CapabilitySubAgentDiagnostic[];
  readonly contentHash?: string;
  readonly bodyHash?: string;
};

export type CapabilityMcpToolCatalogItem = CapabilityToolCatalogItem & {
  /** Exact method name used by the MCP protocol, configuration, and remote executor. */
  readonly protocolName: string;
};

export type CapabilityMcpCatalogItem = {
  readonly serverId: string;
  readonly label: string;
  readonly description?: string;
  readonly transport: McpServerTransportKind;
  readonly enabled: boolean;
  readonly confirmationMode: McpConfirmationMode;
  readonly availability: "configured" | "disabled" | "unavailable";
  readonly runtimeStatus?: "disabled" | "unavailable" | "configured" | "connecting" | "connected" | "error";
  readonly errorSummary?: string;
  readonly commandSummary?: string;
  readonly url?: string;
  readonly envSecretRefCount: number;
  readonly authSecretRefCount: number;
  readonly toolExposureMode: McpToolExposureMode;
  /** Original MCP protocol method names. They are never canonical model-visible identities. */
  readonly enabledTools: readonly string[];
  /** Original MCP protocol method names approved to bypass confirmation. */
  readonly autoApprovedTools: readonly string[];
  readonly lastConnectedAt?: string;
  readonly lastError?: string;
  readonly toolsCachedAt?: string;
  readonly cachedTools?: readonly McpCachedToolInfo[];
  readonly promptCount?: number;
  readonly resourceCount?: number;
  readonly resourceTemplateCount?: number;
  readonly referencesCachedAt?: string;
  readonly runtimeConfig?: {
    readonly transport: McpServerTransportKind;
    readonly command?: string;
    readonly args?: readonly string[];
    readonly url?: string;
    readonly envSecretRefs: readonly string[];
    readonly headerSecretRefs?: readonly string[];
    readonly bearerTokenSecretRef?: string;
    readonly apiKeySecretRef?: string;
    readonly apiKeyHeaderName?: string;
    readonly confirmationMode: McpConfirmationMode;
    readonly toolExposureMode: McpToolExposureMode;
    readonly enabledTools: readonly string[];
    readonly autoApprovedTools: readonly string[];
  };
  /** `name` is canonical/model-visible; `protocolName` is the exact MCP method name. */
  readonly tools: readonly CapabilityMcpToolCatalogItem[];
  readonly exposedTools: readonly CapabilityMcpToolCatalogItem[];
  readonly updatedAt: string;
};

/** Run-born model, tool, MCP, execution-root, and confirmation facts shared by Agent features. */
export type AgentCapabilitySnapshot = {
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly activeModel: SanitizedModelProviderConfig;
  readonly modelCapabilities: ModelCapabilities;
  readonly toolCatalog: {
    readonly scope: "agent-basic";
    readonly tools: readonly CapabilityToolCatalogItem[];
    readonly allowedTools: readonly string[];
  };
  readonly mcpCatalog: readonly CapabilityMcpCatalogItem[];
  readonly executionRoot: string;
  readonly commandShell?: SanitizedCommandShellConfig;
  readonly toolConfirmation?: SanitizedToolConfirmationConfig;
  readonly warnings: readonly string[];
};

/** Ordinary-owned extension for Skills and Sub-Agent AgentTool contributions. */
export type OrdinaryCapabilitySnapshot = AgentCapabilitySnapshot & {
  readonly skillCatalog: readonly CapabilitySkillCatalogItem[];
  readonly subAgentCatalog: readonly CapabilitySubAgentCatalogItem[];
  readonly skillTrigger?: SanitizedSkillTriggerConfig;
};

export type RunToolExposureReasonCode =
  | "model_tools_unsupported"
  | "tool_disabled"
  | "tool_unavailable"
  | "not_in_run_scope"
  | "permission_denied"
  | "profile_hidden"
  | "available_full_access"
  | "available_requires_confirmation"
  | "available"
  | "no_executable_tool_runner"
  | "executable_tool_missing"
  | "tool_contract_mismatch"
  | "selected_skill_resources_available"
  | "selected_skill_resources_unavailable"
  | "no_enabled_sub_agents";

export type RunToolExposure = {
  readonly name: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly modelVisible: boolean;
  readonly scopes: readonly CapabilityToolScope[];
  readonly availability: CapabilityToolCatalogItem["availability"];
  readonly riskLevel: ToolRiskLevel;
  readonly operationType: ToolOperationType;
  readonly fileOperation?: ToolFileDisplayOperation;
  readonly requiresConfirmation: boolean;
  readonly confirmationPolicy?: ToolConfirmationPolicy;
  readonly reasonCode?: RunToolExposureReasonCode;
  readonly reason: string;
};

export type RunEnabledSkill = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly triggers: readonly string[];
  readonly summary?: string;
  readonly category?: string;
  readonly sourceKind?: "project" | "user" | "plugin" | "admin" | "custom";
  readonly sourceRootId?: string;
  readonly sourcePrecedence?: number;
  readonly stateKey?: string;
  readonly version?: string;
  readonly provenance?: CapabilitySkillProvenance;
  readonly whenToUse?: string;
  readonly disableModelInvocation?: boolean;
  readonly userInvocable?: boolean;
  readonly metadata?: Readonly<Record<string, CapabilitySkillMetadataValue>>;
  readonly allowedTools?: readonly string[];
  readonly contentHash?: string;
  readonly bodyHash?: string;
};

export type RunCapabilityResolution = {
  readonly resolutionId: string;
  readonly snapshotId: string;
  readonly agentId: string;
  readonly agentDisplayName: string;
  readonly toolVisibilityProfileId: string;
  readonly capabilityPlan: RunCapabilityPlan;
  readonly allowedTools: readonly string[];
  readonly toolExposures: readonly RunToolExposure[];
  readonly enabledSkills: readonly RunEnabledSkill[];
  readonly warnings: readonly string[];
  readonly createdAt: string;
};

export type RunCapabilityPlan = {
  readonly protocolToolCallCapabilities: ProtocolToolCallCapabilities;
  readonly modelCapabilities: ModelCapabilities;
  readonly canExposeModelTools: boolean;
};

export type RunAgentDefinitionRef = {
  readonly agentId: string;
  readonly agentDisplayName: string;
  readonly promptRef: string;
  readonly promptVersion: string;
  readonly outputContractId: string;
  readonly toolVisibilityProfileId: string;
  readonly definitionHash?: string;
};
