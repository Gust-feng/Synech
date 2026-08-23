import {
  FileSystemLocalDevSecretStore,
  FileSystemSettingsStore,
} from "../../adapters/config/index.js";
import type {
  LocalSettings,
  ConfiguredModelProviderKind,
  CreateModelProviderProfileInput,
  LocalDevSecretStore,
  McpCachedReferenceInfo,
  McpCachedToolInfo,
  McpServerSecretValueInput,
  McpServerSettings,
  ModelCapabilities,
  ModelCapabilityOverrideSettings,
  ModelProviderModelCatalog,
  ModelProviderProfileSettings,
  SettingsStore,
  SanitizedCommandShellConfig,
  SanitizedOrdinaryAgentPromptConfig,
  SanitizedMcpServerSecretMetadata,
  SanitizedInformationAccessConfig,
  SanitizedModelProviderConfig,
  SanitizedSkillTriggerConfig,
  SanitizedToolConfirmationConfig,
  SanitizedWebSearchConfig,
  UpdateInformationAccessConfigInput,
  UpdateCommandShellConfigInput,
  UpdateOrdinaryAgentPromptConfigInput,
  UpdateModelProviderConfigInput,
  UpdateSkillTriggerConfigInput,
  UpdateToolConfirmationConfigInput,
  UpdateToolStateInput,
  UpsertMcpServerInput,
  UpdateWebSearchConfigInput,
  ToolStateSettings,
} from "../../domain/config/index.js";
import { listBuiltinModelProviderPresets } from "../../domain/config/index.js";
import type { InformationAccessSettings } from "../../domain/config/index.js";
import {
  DEFAULT_MODEL_PROVIDER_BASE_URL,
  createDefaultLocalSettings,
  normalizeBaseUrl,
  normalizeInformationAccessSettings,
  normalizeLocalSettings,
  normalizeModelProfile,
  normalizeModelProviderKind,
  normalizeOptionalString,
  parseMcpCommandLine,
  normalizePositiveInteger,
  normalizeProfileId,
  normalizeRequiredConfigString,
  normalizeCommandShellUpdate,
  normalizeOrdinaryAgentPromptUpdate,
  normalizeToolConfirmationUpdate,
  normalizeSkillTriggerUpdate,
  requireActiveModelProfile,
  toSanitizedCommandShellConfig,
  toSanitizedSkillTriggerConfig,
  toSanitizedToolConfirmationConfig,
  normalizeWebSearchProvider,
  parseLocalSettingsFile,
  sanitizeCapabilityOverride,
  sanitizeMcpArgs,
  shouldRewriteLocalSettingsFile,
  webSearchProviderSettings,
} from "./settings-schema.js";
import {
  toSanitizedInformationAccessConfig,
  toSanitizedOrdinaryAgentPromptConfig,
  toSanitizedModelProfile,
  toSanitizedModelProviderConfig,
  toSanitizedWebSearchConfig,
} from "./projections.js";
import { builtinPresetForProfileId } from "./model-provider-profile-settings.js";

export type ConfigCenterOptions = {
  readonly settingsStore: SettingsStore;
  readonly secretStore: LocalDevSecretStore;
};

export type CreateLocalConfigCenterOptions = {
  readonly configDirectory: string;
};

export type ModelRuntimeConfigEnvironment = Readonly<Record<string, string | undefined>>;

export type CreateModelRuntimeEnvironmentInput = {
  readonly modelProvider?: Pick<SanitizedModelProviderConfig, "secretRef" | "model" | "baseUrl">;
  readonly informationAccess?: Pick<SanitizedInformationAccessConfig, "web">;
};
export type CreateMcpRuntimeEnvironmentInput = {
  readonly servers?: readonly Pick<
    McpServerSettings,
    "envSecretRefs" | "headerSecretRefs" | "bearerTokenSecretRef" | "apiKeySecretRef"
  >[];
  readonly baseEnv?: ModelRuntimeConfigEnvironment;
};

export class ConfigCenterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigCenterValidationError";
  }
}

export class ConfigCenter {
  constructor(private readonly options: ConfigCenterOptions) {}

  async getModelProviderConfig(): Promise<SanitizedModelProviderConfig> {
    const settings = await this.readOrCreateSettings();
    return toSanitizedModelProviderConfig({ settings, secretStore: this.options.secretStore });
  }

  async getModelProviderApiKey(profileId?: string): Promise<string | undefined> {
    const settings = await this.readOrCreateSettings();
    const profile =
      profileId === undefined
        ? requireActiveModelProfile(settings)
        : settings.modelProfiles.find((candidate) => candidate.profileId === normalizeProfileId(profileId));
    return profile === undefined ? undefined : this.options.secretStore.readSecret(profile.secretRef);
  }

  async listModelProviderProfiles(): Promise<readonly SanitizedModelProviderConfig[]> {
    const settings = await this.readOrCreateSettings();
    return Promise.all(settings.modelProfiles.map((profile) =>
      toSanitizedModelProfile({ profile, secretStore: this.options.secretStore })
    ));
  }

  async getModelProviderOrder(): Promise<readonly string[]> {
    const settings = await this.readOrCreateSettings();
    return settings.modelProviderOrder ?? [];
  }

  async updateModelProviderOrder(order: readonly string[]): Promise<readonly string[]> {
    const current = await this.readOrCreateSettings();
    const next = normalizeLocalSettings({
      ...current,
      version: 1,
      modelProviderOrder: order,
      updatedAt: new Date().toISOString(),
    });
    await this.options.settingsStore.writeSettings(next);
    return next.modelProviderOrder ?? [];
  }

  async listModelProviderModelCatalogs(): Promise<readonly ModelProviderModelCatalog[]> {
    const settings = await this.readOrCreateSettings();
    return settings.modelCatalogs ?? [];
  }

  async upsertModelProviderModelCatalog(catalog: ModelProviderModelCatalog): Promise<ModelProviderModelCatalog> {
    const current = await this.readOrCreateSettings();
    const now = new Date().toISOString();
    const profileId = normalizeProfileId(catalog.profileId);
    if (!current.modelProfiles.some((profile) => profile.profileId === profileId)) {
      throw new ConfigCenterValidationError(`Model profile not found: ${profileId}`);
    }
    const normalized = normalizeLocalSettings({
      ...current,
      version: 1,
      modelCatalogs: [
        ...(current.modelCatalogs ?? []).filter((item) => item.profileId !== profileId),
        { ...catalog, profileId },
      ],
      updatedAt: now,
    });
    const saved = normalized.modelCatalogs?.find((item) => item.profileId === profileId);
    if (saved === undefined) {
      throw new ConfigCenterValidationError(`Model catalog could not be saved: ${profileId}`);
    }
    const withoutEmptyCatalog =
      saved.models.length === 0
        ? normalizeLocalSettings({
            ...normalized,
            modelCatalogs: (normalized.modelCatalogs ?? []).filter((item) => item.profileId !== profileId),
            updatedAt: now,
          })
        : normalized;
    const next = normalizeLocalSettings(clearProfileModelOutsideCatalog(withoutEmptyCatalog, saved, now));
    await this.options.settingsStore.writeSettings(next);
    const savedAfterCleanup = next.modelCatalogs?.find((item) => item.profileId === profileId);
    if (savedAfterCleanup === undefined && saved.models.length !== 0) {
      throw new ConfigCenterValidationError(`Model catalog could not be saved: ${profileId}`);
    }
    return savedAfterCleanup ?? saved;
  }

  async createModelProviderProfile(input: CreateModelProviderProfileInput): Promise<SanitizedModelProviderConfig> {
    const current = await this.readOrCreateSettings();
    const now = new Date().toISOString();
    const profileId = normalizeProfileId(input.profileId);
    if (current.modelProfiles.some((profile) => profile.profileId === profileId)) {
      throw new ConfigCenterValidationError(`Model profile already exists: ${profileId}`);
    }
    const profile = normalizeModelProfile({
      ...input,
      profileId,
      label: normalizeOptionalString(input.label) ?? profileId,
      updatedAt: now,
    }, createModelProviderProfileFallback(profileId, normalizeOptionalString(input.label) ?? profileId, requireActiveModelProfile(current), now));
    const next = normalizeLocalSettings({
      ...current,
      version: 1,
      modelProfiles: [...current.modelProfiles, profile],
      updatedAt: now,
    });
    const apiKey = normalizeOptionalString(input.apiKey);
    if (apiKey !== undefined) {
      await this.options.secretStore.writeSecret(profile.secretRef, apiKey);
    }
    await this.options.settingsStore.writeSettings(next);
    return toSanitizedModelProfile({
      profile: next.modelProfiles.find((candidate) => candidate.profileId === profileId) ?? profile,
      secretStore: this.options.secretStore,
    });
  }

  async activateModelProviderProfile(profileId: string): Promise<SanitizedModelProviderConfig> {
    const current = await this.readOrCreateSettings();
    const normalized = normalizeProfileId(profileId);
    const profile = current.modelProfiles.find((candidate) => candidate.profileId === normalized);
    if (profile === undefined) {
      throw new ConfigCenterValidationError(`Model profile not found: ${normalized}`);
    }
    if (!profile.enabled) {
      throw new ConfigCenterValidationError(`Model profile is disabled: ${normalized}`);
    }
    const now = new Date().toISOString();
    const next = normalizeLocalSettings({
      ...current,
      version: 1,
      activeModelProfileId: profile.profileId,
      updatedAt: now,
    });
    await this.options.settingsStore.writeSettings(next);
    return toSanitizedModelProfile({ profile: requireActiveModelProfile(next), secretStore: this.options.secretStore });
  }

  async deleteModelProviderProfile(profileId: string): Promise<readonly SanitizedModelProviderConfig[]> {
    const current = await this.readOrCreateSettings();
    const normalized = normalizeProfileId(profileId);
    if (current.activeModelProfileId === normalized) {
      throw new ConfigCenterValidationError("Cannot delete the active model profile.");
    }
    const nextProfiles = current.modelProfiles.filter((profile) => profile.profileId !== normalized);
    if (nextProfiles.length === current.modelProfiles.length) {
      throw new ConfigCenterValidationError(`Model profile not found: ${normalized}`);
    }
    const deletedProfile = current.modelProfiles.find((profile) => profile.profileId === normalized);
    const next = normalizeLocalSettings({
      ...current,
      version: 1,
      modelProfiles: nextProfiles,
      modelCatalogs: (current.modelCatalogs ?? []).filter((catalog) => catalog.profileId !== normalized),
      updatedAt: new Date().toISOString(),
    });
    if (deletedProfile !== undefined) {
      await this.options.secretStore.deleteSecret(deletedProfile.secretRef);
    }
    await this.options.settingsStore.writeSettings(next);
    return this.listModelProviderProfiles();
  }

  async updateModelProviderConfig(
    input: UpdateModelProviderConfigInput
  ): Promise<SanitizedModelProviderConfig> {
    const current = await this.readOrCreateSettings();
    const now = new Date().toISOString();
    const profileId = input.profileId === undefined ? current.activeModelProfileId : normalizeProfileId(input.profileId);
    const existing = current.modelProfiles.find((profile) => profile.profileId === profileId);
    if (existing === undefined) {
      throw new ConfigCenterValidationError(`Model profile not found: ${profileId}`);
    }
    const protectedBuiltInProfile = builtinPresetForProtectedProfile({
      profileId,
    });
    const effectiveInput = protectedBuiltInProfile === undefined
      ? input
      : {
          ...input,
          label: undefined,
          logoDataUrl: undefined,
          clearLogoDataUrl: undefined,
        };
    const normalizedProfile = normalizeModelProfile({
      ...existing,
      ...effectiveInput,
      profileId,
      updatedAt: now,
    }, existing);
    const updatedProfile = {
      ...normalizedProfile,
      ...(protectedBuiltInProfile === undefined
        ? {}
        : {
            label: protectedBuiltInProfile.label,
            logoDataUrl: undefined,
          }),
      ...(effectiveInput.clearModel === true ? { model: undefined } : {}),
      ...(effectiveInput.clearLogoDataUrl === true ? { logoDataUrl: undefined } : {}),
    };
    const nextProfiles = current.modelProfiles.map((profile) =>
      profile.profileId === updatedProfile.profileId ? updatedProfile : profile
    );
    const next: LocalSettings = normalizeLocalSettings({
      ...current,
      version: 1,
      modelProfiles: nextProfiles,
      updatedAt: now,
    });

    const apiKey = normalizeOptionalString(input.apiKey);
    if (input.clearApiKey === true) {
      await Promise.all([...new Set([existing.secretRef, updatedProfile.secretRef])]
        .map((secretRef) => this.options.secretStore.deleteSecret(secretRef)));
    } else if (apiKey !== undefined) {
      await this.options.secretStore.writeSecret(updatedProfile.secretRef, apiKey);
    }

    await this.options.settingsStore.writeSettings(next);
    return toSanitizedModelProfile({
      profile: next.modelProfiles.find((profile) => profile.profileId === updatedProfile.profileId) ?? updatedProfile,
      secretStore: this.options.secretStore,
    });
  }

  async listModelCapabilityOverrides(): Promise<readonly ModelCapabilityOverrideSettings[]> {
    const settings = await this.readOrCreateSettings();
    return settings.modelCapabilityOverrides ?? [];
  }

  async updateModelCapabilityOverride(input: {
    readonly profileId?: string;
    readonly model: string;
    readonly providerKind?: ConfiguredModelProviderKind;
    readonly capabilities: Partial<ModelCapabilities>;
  }): Promise<readonly ModelCapabilityOverrideSettings[]> {
    const current = await this.readOrCreateSettings();
    const now = new Date().toISOString();
    const profileId = input.profileId === undefined ? undefined : normalizeProfileId(input.profileId);
    const model = normalizeRequiredConfigString(input.model, "model");
    const nextOverride: ModelCapabilityOverrideSettings = {
      ...(profileId === undefined ? {} : { profileId }),
      providerKind: normalizeModelProviderKind(input.providerKind),
      model,
      capabilities: sanitizeCapabilityOverride(input.capabilities),
      updatedAt: now,
    };
    const existing = current.modelCapabilityOverrides ?? [];
    const next = normalizeLocalSettings({
      ...current,
      version: 1,
      modelCapabilityOverrides: [
        ...existing.filter((item) => !sameCapabilityOverrideScope(item, nextOverride)),
        nextOverride,
      ],
      updatedAt: now,
    });
    await this.options.settingsStore.writeSettings(next);
    return next.modelCapabilityOverrides ?? [];
  }

  async listToolStates(): Promise<readonly ToolStateSettings[]> {
    const settings = await this.readOrCreateSettings();
    return settings.toolStates ?? [];
  }

  async updateToolState(input: UpdateToolStateInput): Promise<readonly ToolStateSettings[]> {
    const current = await this.readOrCreateSettings();
    const now = new Date().toISOString();
    const name = normalizeRequiredConfigString(input.name, "tool name");
    const nextState: ToolStateSettings = { name, enabled: input.enabled, updatedAt: now };
    const existing = current.toolStates ?? [];
    const next = normalizeLocalSettings({
      ...current,
      version: 1,
      toolStates: [...existing.filter((state) => state.name !== name), nextState],
      updatedAt: now,
    });
    await this.options.settingsStore.writeSettings(next);
    return next.toolStates ?? [];
  }

  async listMcpServers(): Promise<readonly McpServerSettings[]> {
    const settings = await this.readOrCreateSettings();
    return settings.mcpServers ?? [];
  }

  async upsertMcpServer(input: UpsertMcpServerInput): Promise<readonly McpServerSettings[]> {
    const current = await this.readOrCreateSettings();
    const now = new Date().toISOString();
    const serverId = normalizeProfileId(input.serverId);
    const existing = (current.mcpServers ?? []).find((server) => server.serverId === serverId);
    const parsedCommandLine = input.commandLine === undefined ? undefined : parseMcpCommandLine(input.commandLine);
    const draftServer: McpServerSettings = {
      serverId,
      label: normalizeOptionalString(input.label) ?? existing?.label ?? serverId,
      description: input.description === undefined ? existing?.description : normalizeOptionalString(input.description),
      transport: input.transport ?? existing?.transport ?? "stdio",
      command: parsedCommandLine?.command ?? normalizeOptionalString(input.command) ?? existing?.command,
      args: parsedCommandLine?.args ?? (input.args === undefined ? existing?.args ?? [] : sanitizeMcpArgs(input.args)),
      url: normalizeOptionalString(input.url) ?? existing?.url,
      envSecretRefs: input.envSecretRefs === undefined
        ? existing?.envSecretRefs ?? []
        : input.envSecretRefs.map((ref) => normalizeOptionalString(ref)).filter((ref): ref is string => ref !== undefined),
      headerSecretRefs: input.clearMcpAuth === true
        ? []
        : input.headerSecretRefs === undefined
        ? existing?.headerSecretRefs ?? []
        : input.headerSecretRefs.map((ref) => normalizeOptionalString(ref)).filter((ref): ref is string => ref !== undefined),
      bearerTokenSecretRef: input.clearMcpAuth === true ? undefined : normalizeOptionalString(input.bearerTokenSecretRef) ?? existing?.bearerTokenSecretRef,
      apiKeySecretRef: input.clearMcpAuth === true ? undefined : normalizeOptionalString(input.apiKeySecretRef) ?? existing?.apiKeySecretRef,
      apiKeyHeaderName: input.clearMcpAuth === true ? undefined : normalizeOptionalString(input.apiKeyHeaderName) ?? existing?.apiKeyHeaderName,
      confirmationMode: input.confirmationMode ?? existing?.confirmationMode ?? "never",
      toolExposureMode: input.toolExposureMode ?? existing?.toolExposureMode ?? "none",
      enabledTools: input.enabledTools === undefined
        ? existing?.enabledTools ?? []
        : [...new Set(input.enabledTools.map((tool) => normalizeOptionalString(tool)).filter((tool): tool is string => tool !== undefined))],
      autoApprovedTools: input.autoApprovedTools === undefined
        ? existing?.autoApprovedTools ?? []
        : [...new Set(input.autoApprovedTools.map((tool) => normalizeOptionalString(tool)).filter((tool): tool is string => tool !== undefined))],
      enabled: input.enabled ?? existing?.enabled ?? false,
      updatedAt: now,
    };
    const connectionChanged = existing !== undefined && mcpConnectionConfigChanged(existing, draftServer);
    const cachedTools = connectionChanged ? undefined : existing?.cachedTools;
    const cachedReferences = connectionChanged ? undefined : existing?.cachedReferences;
    const nextServer: McpServerSettings = {
      ...draftServer,
      lastConnectedAt: connectionChanged ? undefined : existing?.lastConnectedAt,
      lastError: connectionChanged ? undefined : existing?.lastError,
      ...(cachedTools !== undefined && cachedTools.length > 0 ? {
        cachedTools,
        toolsCachedAt: existing?.toolsCachedAt,
      } : {}),
      ...(cachedReferences !== undefined ? {
        cachedReferences,
        referencesCachedAt: existing?.referencesCachedAt,
      } : {}),
    };
    const next = normalizeLocalSettings({
      ...current,
      version: 1,
      mcpServers: upsertMcpServerInOrder(current.mcpServers ?? [], nextServer),
      updatedAt: now,
    });
    await this.options.settingsStore.writeSettings(next);
    return next.mcpServers ?? [];
  }

  async deleteMcpServer(serverId: string): Promise<readonly McpServerSettings[]> {
    const current = await this.readOrCreateSettings();
    const normalized = normalizeProfileId(serverId);
    const existing = current.mcpServers ?? [];
    const nextServers = existing.filter((server) => server.serverId !== normalized);
    if (nextServers.length === existing.length) {
      throw new ConfigCenterValidationError(`MCP server not found: ${normalized}`);
    }
    const next = normalizeLocalSettings({
      ...current,
      version: 1,
      mcpServers: nextServers,
      updatedAt: new Date().toISOString(),
    });
    await this.options.settingsStore.writeSettings(next);
    return next.mcpServers ?? [];
  }

  async updateMcpServerConnectionState(input: {
    readonly serverId: string;
    readonly connectedAt?: string;
    readonly errorSummary?: string;
    readonly cachedTools?: readonly McpCachedToolInfo[];
    readonly cachedReferences?: McpCachedReferenceInfo;
  }): Promise<readonly McpServerSettings[]> {
    const current = await this.readOrCreateSettings();
    const now = new Date().toISOString();
    const serverId = normalizeProfileId(input.serverId);
    const existing = (current.mcpServers ?? []).find((server) => server.serverId === serverId);
    if (existing === undefined) {
      throw new ConfigCenterValidationError(`MCP server not found: ${serverId}`);
    }
    const nextServer: McpServerSettings = {
      ...existing,
      lastConnectedAt: input.connectedAt ?? existing.lastConnectedAt,
      lastError: input.errorSummary,
      ...(input.cachedTools !== undefined ? {
        cachedTools: input.cachedTools,
        toolsCachedAt: now,
      } : {}),
      ...(input.cachedReferences !== undefined ? {
        cachedReferences: input.cachedReferences,
        referencesCachedAt: now,
      } : {}),
      updatedAt: now,
    };
    const next = normalizeLocalSettings({
      ...current,
      version: 1,
      mcpServers: upsertMcpServerInOrder(current.mcpServers ?? [], nextServer),
      updatedAt: now,
    });
    await this.options.settingsStore.writeSettings(next);
    return next.mcpServers ?? [];
  }

  async writeMcpServerSecretValue(input: McpServerSecretValueInput): Promise<SanitizedMcpServerSecretMetadata> {
    const settings = await this.readOrCreateSettings();
    const serverId = normalizeProfileId(input.serverId);
    const server = (settings.mcpServers ?? []).find((item) => item.serverId === serverId);
    if (server === undefined) {
      throw new ConfigCenterValidationError(`MCP server not found: ${serverId}`);
    }
    const secretRef = normalizeRequiredConfigString(input.secretRef, "MCP secret ref");
    if (!mcpServerOwnsSecretRef(server, secretRef)) {
      throw new ConfigCenterValidationError(`MCP secret ref is not declared for server: ${serverId}`);
    }
    const value = normalizeRequiredConfigString(input.value, "MCP secret value");
    const metadata = await this.options.secretStore.writeSecret(secretRef, value);
    return { secretRef, ...metadata };
  }

  async getInformationAccessConfig(): Promise<SanitizedInformationAccessConfig> {
    const settings = await this.readOrCreateSettings();
    return toSanitizedInformationAccessConfig({ settings, secretStore: this.options.secretStore });
  }

  async getWebSearchConfig(): Promise<SanitizedWebSearchConfig> {
    const settings = await this.readOrCreateSettings();
    return toSanitizedWebSearchConfig({ settings, secretStore: this.options.secretStore });
  }

  async updateInformationAccessConfig(
    input: UpdateInformationAccessConfigInput
  ): Promise<SanitizedInformationAccessConfig> {
    const current = await this.readOrCreateSettings();
    const now = new Date().toISOString();
    const currentInformation = normalizeInformationAccessSettings(current.informationAccess, now);
    const apiKey = normalizeOptionalString(input.apiKey);
    const provider =
      normalizeWebSearchProvider(input.provider) ??
      (apiKey === undefined ? currentInformation.webSearch.provider : "tavily");
    const nextInformation: InformationAccessSettings = {
      webSearch: {
        provider,
        updatedAt: now,
      },
      tavily: currentInformation.tavily,
      exa: currentInformation.exa,
      zai: currentInformation.zai,
      metaso: currentInformation.metaso,
      google: currentInformation.google,
      bing: currentInformation.bing,
    };
    const updatedInformation = updateSelectedWebSearchProviderSettings(nextInformation, {
      provider,
      now,
      maxResults: normalizePositiveInteger(input.maxResults),
      engineId: normalizeOptionalString(input.engineId),
    });
    const providerSettings = webSearchProviderSettings(updatedInformation, provider);
    if (apiKey !== undefined && providerSettings !== undefined) {
      await this.options.secretStore.writeSecret(providerSettings.secretRef, apiKey);
    }
    await this.options.settingsStore.writeSettings({
      ...current,
      version: 1,
      informationAccess: updatedInformation,
      updatedAt: now,
    });
    return toSanitizedInformationAccessConfig({
      settings: { ...current, informationAccess: updatedInformation, updatedAt: now },
      secretStore: this.options.secretStore,
    });
  }

  async updateWebSearchConfig(input: UpdateWebSearchConfigInput): Promise<SanitizedWebSearchConfig> {
    const current = await this.readOrCreateSettings();
    const now = new Date().toISOString();
    const currentInformation = normalizeInformationAccessSettings(current.informationAccess, now);
    const apiKey = normalizeOptionalString(input.apiKey);
    const provider =
      normalizeWebSearchProvider(input.provider) ??
      (apiKey === undefined ? currentInformation.webSearch.provider : "tavily");
    const nextInformation: InformationAccessSettings = {
      webSearch: {
        provider,
        updatedAt: now,
      },
      tavily: currentInformation.tavily,
      exa: currentInformation.exa,
      zai: currentInformation.zai,
      metaso: currentInformation.metaso,
      google: currentInformation.google,
      bing: currentInformation.bing,
    };
    const updatedInformation = updateSelectedWebSearchProviderSettings(nextInformation, {
      provider,
      now,
      maxResults: normalizePositiveInteger(input.maxResults),
      engineId: normalizeOptionalString(input.engineId),
    });
    const providerSettings = webSearchProviderSettings(updatedInformation, provider);
    if (apiKey !== undefined && providerSettings !== undefined) {
      await this.options.secretStore.writeSecret(providerSettings.secretRef, apiKey);
    }
    await this.options.settingsStore.writeSettings({
      ...current,
      version: 1,
      informationAccess: updatedInformation,
      updatedAt: now,
    });
    return toSanitizedWebSearchConfig({
      settings: { ...current, informationAccess: updatedInformation, updatedAt: now },
      secretStore: this.options.secretStore,
    });
  }

  async getCommandShellConfig(): Promise<SanitizedCommandShellConfig> {
    const settings = await this.readOrCreateSettings();
    return toSanitizedCommandShellConfig(settings.commandShell, { now: settings.updatedAt });
  }

  async getToolConfirmationConfig(): Promise<SanitizedToolConfirmationConfig> {
    const settings = await this.readOrCreateSettings();
    return toSanitizedToolConfirmationConfig(settings.toolConfirmation, { now: settings.updatedAt });
  }

  async getOrdinaryAgentPromptConfig(): Promise<SanitizedOrdinaryAgentPromptConfig> {
    const settings = await this.readOrCreateSettings();
    return toSanitizedOrdinaryAgentPromptConfig(settings);
  }

  async getSkillTriggerConfig(): Promise<SanitizedSkillTriggerConfig> {
    const settings = await this.readOrCreateSettings();
    return toSanitizedSkillTriggerConfig(settings.skillTrigger, { now: settings.updatedAt });
  }

  async updateCommandShellConfig(input: UpdateCommandShellConfigInput): Promise<SanitizedCommandShellConfig> {
    const current = await this.readOrCreateSettings();
    const now = new Date().toISOString();
    const commandShell = normalizeCommandShellUpdate(input, now);
    const next: LocalSettings = {
      ...current,
      version: 1,
      commandShell,
      updatedAt: now,
    };
    await this.options.settingsStore.writeSettings(next);
    return toSanitizedCommandShellConfig(commandShell, { now });
  }

  async updateToolConfirmationConfig(input: UpdateToolConfirmationConfigInput): Promise<SanitizedToolConfirmationConfig> {
    const current = await this.readOrCreateSettings();
    const now = new Date().toISOString();
    const toolConfirmation = normalizeToolConfirmationUpdate(input, now);
    const next: LocalSettings = {
      ...current,
      version: 1,
      toolConfirmation,
      updatedAt: now,
    };
    await this.options.settingsStore.writeSettings(next);
    return toSanitizedToolConfirmationConfig(toolConfirmation, { now });
  }

  async updateOrdinaryAgentPromptConfig(input: UpdateOrdinaryAgentPromptConfigInput): Promise<SanitizedOrdinaryAgentPromptConfig> {
    const current = await this.readOrCreateSettings();
    const now = new Date().toISOString();
    const promptSettings = normalizeOrdinaryAgentPromptUpdate(input, current.ordinaryAgent, now);
    const next = normalizeLocalSettings({
      ...current,
      version: 1,
      ordinaryAgent: promptSettings,
      updatedAt: now,
    });
    await this.options.settingsStore.writeSettings(next);
    return toSanitizedOrdinaryAgentPromptConfig(next);
  }

  async updateSkillTriggerConfig(input: UpdateSkillTriggerConfigInput): Promise<SanitizedSkillTriggerConfig> {
    const current = await this.readOrCreateSettings();
    const now = new Date().toISOString();
    const skillTrigger = normalizeSkillTriggerUpdate(input, now);
    const next: LocalSettings = {
      ...current,
      version: 1,
      skillTrigger,
      updatedAt: now,
    };
    await this.options.settingsStore.writeSettings(next);
    return toSanitizedSkillTriggerConfig(skillTrigger, { now });
  }

  async createModelRuntimeEnvironment(
    input: CreateModelRuntimeEnvironmentInput = {}
  ): Promise<ModelRuntimeConfigEnvironment> {
    const settings = await this.readOrCreateSettings();
    const modelProvider = input.modelProvider ?? requireActiveModelProfile(settings);
    const apiKey = await this.options.secretStore.readSecret(modelProvider.secretRef);
    const currentInformationAccess = normalizeInformationAccessSettings(settings.informationAccess, settings.updatedAt);
    const webProvider = input.informationAccess?.web.provider ?? currentInformationAccess.webSearch.provider;
    const externalWebProvider = webProvider === "model_builtin" ? "none" : webProvider;
    const currentProviderSettings = webSearchProviderSettings(currentInformationAccess, webProvider);
    const webSecretRef = input.informationAccess?.web.secretRef ?? currentProviderSettings?.secretRef;
    const webMaxResults = input.informationAccess?.web.maxResults ?? currentProviderSettings?.maxResults ?? currentInformationAccess.tavily.maxResults;
    const webApiKey =
      webProvider === "none" || webProvider === "model_builtin" || webSecretRef === undefined
        ? undefined
        : await this.options.secretStore.readSecret(webSecretRef);
    const webSearchEngineId = input.informationAccess?.web.engineId ?? currentProviderSettings?.engineId;
    return {
      SYNECH_MODEL_API_KEY: apiKey,
      SYNECH_MODEL_NAME: modelProvider.model,
      SYNECH_MODEL_BASE_URL: normalizeBaseUrl(modelProvider.baseUrl) ?? DEFAULT_MODEL_PROVIDER_BASE_URL,
      SYNECH_WEB_SEARCH_PROVIDER: externalWebProvider,
      SYNECH_WEB_SEARCH_API_KEY: webApiKey,
      SYNECH_WEB_SEARCH_MAX_RESULTS: String(webMaxResults),
      SYNECH_WEB_SEARCH_GOOGLE_ENGINE_ID: webSearchEngineId,
      SYNECH_MODEL_BUILTIN_WEB_SEARCH: webProvider === "model_builtin" ? "true" : undefined,
      SYNECH_TAVILY_API_KEY: externalWebProvider === "tavily" ? webApiKey : undefined,
      SYNECH_TAVILY_MAX_RESULTS: externalWebProvider === "tavily" ? String(webMaxResults) : undefined,
      SYNECH_EXA_API_KEY: externalWebProvider === "exa" ? webApiKey : undefined,
      SYNECH_ZAI_API_KEY: externalWebProvider === "zai" ? webApiKey : undefined,
      SYNECH_METASO_API_KEY: externalWebProvider === "metaso" ? webApiKey : undefined,
      METASO_API_KEY: externalWebProvider === "metaso" ? webApiKey : undefined,
      SYNECH_GOOGLE_API_KEY: externalWebProvider === "google" ? webApiKey : undefined,
      SYNECH_GOOGLE_CSE_ID: externalWebProvider === "google" ? webSearchEngineId : undefined,
      SYNECH_BING_API_KEY: externalWebProvider === "bing" ? webApiKey : undefined,
      TAVILY_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    };
  }

  async createMcpRuntimeEnvironment(
    input: CreateMcpRuntimeEnvironmentInput = {}
  ): Promise<ModelRuntimeConfigEnvironment> {
    const settings = await this.readOrCreateSettings();
    const servers = input.servers ?? settings.mcpServers ?? [];
    const refs = new Set<string>();
    for (const server of servers) {
      for (const ref of server.envSecretRefs) {
        refs.add(ref);
      }
      for (const ref of server.headerSecretRefs ?? []) {
        const parsedRef = parseHeaderSecretRef(ref);
        if (parsedRef !== undefined) {
          refs.add(parsedRef.secretRef);
        }
      }
      if (server.bearerTokenSecretRef !== undefined) refs.add(server.bearerTokenSecretRef);
      if (server.apiKeySecretRef !== undefined) refs.add(server.apiKeySecretRef);
    }
    const output: Record<string, string | undefined> = { ...(input.baseEnv ?? {}) };
    for (const ref of refs) {
      output[ref] = input.baseEnv?.[ref] ?? await this.options.secretStore.readSecret(ref);
    }
    return output;
  }

  private async readOrCreateSettings(): Promise<LocalSettings> {
    const existing = await this.options.settingsStore.readSettings();
    if (existing !== undefined) {
      const parsed = parseLocalSettingsFile(existing);
      const normalized = normalizeLocalSettings(parsed);
      if (shouldRewriteLocalSettingsFile(existing, normalized)) {
        await this.options.settingsStore.writeSettings(normalized);
      }
      return normalized;
    }
    const created = createDefaultLocalSettings();
    await this.options.settingsStore.writeSettings(created);
    return created;
  }
}

function mcpConnectionConfigChanged(left: McpServerSettings, right: McpServerSettings): boolean {
  return (
    left.transport !== right.transport ||
    left.command !== right.command ||
    !sameStringList(left.args ?? [], right.args ?? []) ||
    left.url !== right.url ||
    !sameStringList(left.envSecretRefs, right.envSecretRefs) ||
    !sameStringList(left.headerSecretRefs ?? [], right.headerSecretRefs ?? []) ||
    left.bearerTokenSecretRef !== right.bearerTokenSecretRef ||
    left.apiKeySecretRef !== right.apiKeySecretRef ||
    left.apiKeyHeaderName !== right.apiKeyHeaderName
  );
}

function upsertMcpServerInOrder(
  servers: readonly McpServerSettings[],
  nextServer: McpServerSettings
): readonly McpServerSettings[] {
  const existingIndex = servers.findIndex((server) => server.serverId === nextServer.serverId);
  if (existingIndex < 0) {
    return [...servers, nextServer];
  }
  return servers.map((server, index) => index === existingIndex ? nextServer : server);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameCapabilityOverrideScope(
  left: ModelCapabilityOverrideSettings,
  right: ModelCapabilityOverrideSettings
): boolean {
  return left.profileId === right.profileId &&
    left.providerKind === right.providerKind &&
    left.model === right.model;
}

export function createLocalConfigCenter(options: CreateLocalConfigCenterOptions): {
  readonly configCenter: ConfigCenter;
  readonly configDirectory: string;
} {
  const configDirectory = options.configDirectory;
  return {
    configDirectory,
    configCenter: new ConfigCenter({
      settingsStore: new FileSystemSettingsStore(configDirectory),
      secretStore: new FileSystemLocalDevSecretStore(configDirectory),
    }),
  };
}

function createModelProviderProfileFallback(
  profileId: string,
  label: string,
  current: ModelProviderProfileSettings,
  now: string
): ModelProviderProfileSettings {
  return {
    profileId,
    label,
    providerKind: "openai_compatible",
    protocolKind: "openai_compatible_chat_completions",
    baseUrl: DEFAULT_MODEL_PROVIDER_BASE_URL,
    defaultAiMode: current.defaultAiMode === "none" ? "none" : "openai-compatible",
    secretRef: `secret://local-dev/model-provider/${profileId}/api-key`,
    enabled: true,
    updatedAt: now,
  };
}

function builtinPresetForProtectedProfile(
  profile: Pick<ModelProviderProfileSettings, "profileId">
): ReturnType<typeof listBuiltinModelProviderPresets>[number] | undefined {
  // Built-in identity is carried by profileId. Base URL is user-editable
  // transport configuration and must not protect a custom profile.
  return builtinPresetForProfileId(profile.profileId);
}

function clearProfileModelOutsideCatalog(
  settings: LocalSettings,
  catalog: ModelProviderModelCatalog,
  now: string
): LocalSettings {
  const savedModelIds = new Set(catalog.models.map((model) => model.id));
  const modelStillSaved = (model: string | undefined): boolean =>
    model === undefined || savedModelIds.has(model);
  const modelProfiles = settings.modelProfiles.map((profile) =>
    profile.profileId === catalog.profileId && !modelStillSaved(profile.model)
      ? { ...profile, model: undefined, updatedAt: now }
      : profile
  );
  return {
    ...settings,
    modelProfiles,
    updatedAt: now,
  };
}

function updateSelectedWebSearchProviderSettings(
  informationAccess: InformationAccessSettings,
  input: {
    readonly provider: InformationAccessSettings["webSearch"]["provider"];
    readonly now: string;
    readonly maxResults?: number;
    readonly engineId?: string;
  }
): InformationAccessSettings {
  if (input.provider === "none" || input.provider === "model_builtin") {
    return informationAccess;
  }
  const currentProvider = informationAccess[input.provider];
  return {
    ...informationAccess,
    [input.provider]: {
      ...currentProvider,
      maxResults: input.maxResults ?? currentProvider.maxResults,
      engineId: input.provider === "google"
        ? (input.engineId ?? currentProvider.engineId)
        : currentProvider.engineId,
      updatedAt: input.now,
    },
  };
}

function mcpServerOwnsSecretRef(server: McpServerSettings, secretRef: string): boolean {
  return (
    server.envSecretRefs.includes(secretRef) ||
    (server.headerSecretRefs ?? []).some((ref) => parseHeaderSecretRef(ref)?.secretRef === secretRef || ref === secretRef) ||
    server.bearerTokenSecretRef === secretRef ||
    server.apiKeySecretRef === secretRef
  );
}

function parseHeaderSecretRef(value: string): { readonly headerName: string; readonly secretRef: string } | undefined {
  const separator = value.indexOf("=");
  if (separator <= 0) {
    return undefined;
  }
  const headerName = value.slice(0, separator).trim();
  const secretRef = value.slice(separator + 1).trim();
  return headerName.length === 0 || secretRef.length === 0 ? undefined : { headerName, secretRef };
}
