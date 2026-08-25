import {
  FileSystemLocalDevSecretStore,
  FileSystemSettingsStore,
} from "../../adapters/config/index.js";
import type {
  LocalSettings,
  ConfiguredModelProviderKind,
  CreateModelProviderProfileInput,
  LocalDevSecretStore,
  McpServerSecretValueInput,
  McpServerSettings,
  ModelCapabilities,
  ModelCapabilityOverrideSettings,
  ModelProviderModelCatalog,
  SettingsStore,
  SanitizedCommandShellConfig,
  SanitizedOrdinaryAgentPromptConfig,
  SanitizedMcpServerSecretMetadata,
  SanitizedInformationAccessConfig,
  SanitizedModelProviderConfig,
  SanitizedSkillTriggerConfig,
  SanitizedToolConfirmationConfig,
  SanitizedWebSearchConfig,
  WebSearchRuntimeConfig,
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
import type { InformationAccessSettings } from "../../domain/config/index.js";
import {
  ConfigSchemaValidationError,
  createDefaultLocalSettings,
  normalizeInformationAccessSettings,
  normalizeLocalSettings,
  normalizeOptionalString,
  normalizePositiveInteger,
  normalizeRequiredConfigString,
  normalizeCommandShellUpdate,
  normalizeOrdinaryAgentPromptUpdate,
  normalizeToolConfirmationUpdate,
  normalizeSkillTriggerUpdate,
  toSanitizedCommandShellConfig,
  toSanitizedSkillTriggerConfig,
  toSanitizedToolConfirmationConfig,
  normalizeWebSearchProvider,
  parseLocalSettingsFile,
  shouldRewriteLocalSettingsFile,
  webSearchProviderSettings,
} from "./settings-schema.js";
import {
  toSanitizedInformationAccessConfig,
  toSanitizedOrdinaryAgentPromptConfig,
  toSanitizedWebSearchConfig,
} from "./projections.js";
import {
  activateModelProviderProfile as activateModelProviderProfileSettings,
  changeModelProviderOrder,
  createModelProviderProfile as createModelProviderProfileSettings,
  deleteModelProviderProfile as deleteModelProviderProfileSettings,
  getModelProviderApiKey as readModelProviderApiKey,
  getModelProviderConfig as readModelProviderConfig,
  listModelProviderProfiles as readModelProviderProfiles,
  updateModelCapabilityOverride as changeModelCapabilityOverride,
  updateModelProviderConfig as changeModelProviderConfig,
  upsertModelProviderModelCatalog as changeModelProviderModelCatalog,
} from "./model-provider-service.js";
import {
  deleteMcpServer as deleteMcpServerSettings,
  updateMcpServerConnectionState as changeMcpServerConnectionState,
  upsertMcpServer as changeMcpServer,
  writeMcpServerSecretValue as saveMcpServerSecretValue,
} from "./mcp-settings-service.js";
import type { UpdateMcpServerConnectionStateInput } from "./mcp-settings-service.js";
import {
  createMcpRuntimeEnvironment as projectMcpRuntimeEnvironment,
  createModelRuntimeEnvironment as projectModelRuntimeEnvironment,
  resolveWebSearchRuntimeConfig as projectWebSearchRuntimeConfig,
} from "./runtime-environment.js";
import type {
  CreateMcpRuntimeEnvironmentInput,
  CreateModelRuntimeEnvironmentInput,
  ModelRuntimeConfigEnvironment,
} from "./runtime-environment.js";

export { ConfigCenterValidationError } from "./config-center-error.js";
export type {
  CreateMcpRuntimeEnvironmentInput,
  CreateModelRuntimeEnvironmentInput,
  ModelRuntimeConfigEnvironment,
} from "./runtime-environment.js";

export type ConfigCenterOptions = {
  readonly settingsStore: SettingsStore;
  readonly secretStore: LocalDevSecretStore;
};

export type CreateLocalConfigCenterOptions = {
  readonly configDirectory: string;
};

export class ConfigCenter {
  private mutationTail: Promise<void> = Promise.resolve();
  private settingsRead: Promise<LocalSettings> | undefined;

  constructor(private readonly options: ConfigCenterOptions) {}

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async getModelProviderConfig(): Promise<SanitizedModelProviderConfig> {
    const settings = await this.readOrCreateSettings();
    return readModelProviderConfig(settings, this.options.secretStore);
  }

  async getModelProviderApiKey(profileId?: string): Promise<string | undefined> {
    const settings = await this.readOrCreateSettings();
    return readModelProviderApiKey(settings, this.options.secretStore, profileId);
  }

  async listModelProviderProfiles(): Promise<readonly SanitizedModelProviderConfig[]> {
    const settings = await this.readOrCreateSettings();
    return readModelProviderProfiles(settings, this.options.secretStore);
  }

  async getModelProviderOrder(): Promise<readonly string[]> {
    const settings = await this.readOrCreateSettings();
    return settings.modelProviderOrder ?? [];
  }

  async updateModelProviderOrder(order: readonly string[]): Promise<readonly string[]> {
    return this.runMutation(async () => {
      const current = await this.readOrCreateSettings();
      const change = changeModelProviderOrder(current, order, new Date().toISOString());
      await this.options.settingsStore.writeSettings(change.settings);
      return change.result;
    });
  }

  async listModelProviderModelCatalogs(): Promise<readonly ModelProviderModelCatalog[]> {
    const settings = await this.readOrCreateSettings();
    return settings.modelCatalogs ?? [];
  }

  async upsertModelProviderModelCatalog(catalog: ModelProviderModelCatalog): Promise<ModelProviderModelCatalog> {
    return this.runMutation(async () => {
      const current = await this.readOrCreateSettings();
      const change = changeModelProviderModelCatalog(current, catalog, new Date().toISOString());
      await this.options.settingsStore.writeSettings(change.settings);
      return change.result;
    });
  }

  async createModelProviderProfile(input: CreateModelProviderProfileInput): Promise<SanitizedModelProviderConfig> {
    return this.runMutation(async () => {
      const current = await this.readOrCreateSettings();
      const change = await createModelProviderProfileSettings(
        current,
        this.options.secretStore,
        input,
        new Date().toISOString(),
      );
      await this.options.settingsStore.writeSettings(change.settings);
      return change.result;
    });
  }

  async activateModelProviderProfile(profileId: string): Promise<SanitizedModelProviderConfig> {
    return this.runMutation(async () => {
      const current = await this.readOrCreateSettings();
      const change = await activateModelProviderProfileSettings(
        current,
        this.options.secretStore,
        profileId,
        new Date().toISOString(),
      );
      await this.options.settingsStore.writeSettings(change.settings);
      return change.result;
    });
  }

  async deleteModelProviderProfile(profileId: string): Promise<readonly SanitizedModelProviderConfig[]> {
    return this.runMutation(async () => {
      const current = await this.readOrCreateSettings();
      const change = await deleteModelProviderProfileSettings(
        current,
        this.options.secretStore,
        profileId,
        new Date().toISOString(),
      );
      await this.options.settingsStore.writeSettings(change.settings);
      return change.result;
    });
  }

  async updateModelProviderConfig(
    input: UpdateModelProviderConfigInput
  ): Promise<SanitizedModelProviderConfig> {
    return this.runMutation(async () => {
      const current = await this.readOrCreateSettings();
      const change = await changeModelProviderConfig(
        current,
        this.options.secretStore,
        input,
        new Date().toISOString(),
      );
      await this.options.settingsStore.writeSettings(change.settings);
      return change.result;
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
    return this.runMutation(async () => {
      const current = await this.readOrCreateSettings();
      const change = changeModelCapabilityOverride(current, input, new Date().toISOString());
      await this.options.settingsStore.writeSettings(change.settings);
      return change.result;
    });
  }

  async listToolStates(): Promise<readonly ToolStateSettings[]> {
    const settings = await this.readOrCreateSettings();
    return settings.toolStates ?? [];
  }

  async updateToolState(input: UpdateToolStateInput): Promise<readonly ToolStateSettings[]> {
    return this.runMutation(async () => {
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
    });
  }

  async listMcpServers(): Promise<readonly McpServerSettings[]> {
    const settings = await this.readOrCreateSettings();
    return settings.mcpServers ?? [];
  }

  async upsertMcpServer(input: UpsertMcpServerInput): Promise<readonly McpServerSettings[]> {
    return this.runMutation(async () => {
      const current = await this.readOrCreateSettings();
      const change = changeMcpServer(current, input, new Date().toISOString());
      await this.options.settingsStore.writeSettings(change.settings);
      return change.result;
    });
  }

  async deleteMcpServer(serverId: string): Promise<readonly McpServerSettings[]> {
    return this.runMutation(async () => {
      const current = await this.readOrCreateSettings();
      const change = deleteMcpServerSettings(current, serverId, new Date().toISOString());
      await this.options.settingsStore.writeSettings(change.settings);
      return change.result;
    });
  }

  async updateMcpServerConnectionState(
    input: UpdateMcpServerConnectionStateInput,
  ): Promise<readonly McpServerSettings[]> {
    return this.runMutation(async () => {
      const current = await this.readOrCreateSettings();
      const change = changeMcpServerConnectionState(current, input, new Date().toISOString());
      await this.options.settingsStore.writeSettings(change.settings);
      return change.result;
    });
  }

  async writeMcpServerSecretValue(input: McpServerSecretValueInput): Promise<SanitizedMcpServerSecretMetadata> {
    return this.runMutation(async () => {
      const settings = await this.readOrCreateSettings();
      return saveMcpServerSecretValue(settings, this.options.secretStore, input);
    });
  }

  async getInformationAccessConfig(): Promise<SanitizedInformationAccessConfig> {
    const settings = await this.readOrCreateSettings();
    return toSanitizedInformationAccessConfig({ settings, secretStore: this.options.secretStore });
  }

  async getWebSearchConfig(): Promise<SanitizedWebSearchConfig> {
    const settings = await this.readOrCreateSettings();
    return toSanitizedWebSearchConfig({ settings, secretStore: this.options.secretStore });
  }

  async resolveWebSearchRuntimeConfig(
    web?: SanitizedInformationAccessConfig["web"],
  ): Promise<WebSearchRuntimeConfig | undefined> {
    const settings = await this.readOrCreateSettings();
    return projectWebSearchRuntimeConfig(settings, this.options.secretStore, web);
  }

  async updateInformationAccessConfig(
    input: UpdateInformationAccessConfigInput
  ): Promise<SanitizedInformationAccessConfig> {
    return this.runMutation(async () => {
      const settings = await this.writeInformationAccessConfig(input);
      return toSanitizedInformationAccessConfig({
        settings,
        secretStore: this.options.secretStore,
      });
    });
  }

  async updateWebSearchConfig(input: UpdateWebSearchConfigInput): Promise<SanitizedWebSearchConfig> {
    return this.runMutation(async () => {
      const settings = await this.writeInformationAccessConfig(input);
      return toSanitizedWebSearchConfig({ settings, secretStore: this.options.secretStore });
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
    return this.runMutation(async () => {
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
    });
  }

  async updateToolConfirmationConfig(input: UpdateToolConfirmationConfigInput): Promise<SanitizedToolConfirmationConfig> {
    return this.runMutation(async () => {
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
    });
  }

  async updateOrdinaryAgentPromptConfig(input: UpdateOrdinaryAgentPromptConfigInput): Promise<SanitizedOrdinaryAgentPromptConfig> {
    return this.runMutation(async () => {
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
    });
  }

  async updateSkillTriggerConfig(input: UpdateSkillTriggerConfigInput): Promise<SanitizedSkillTriggerConfig> {
    return this.runMutation(async () => {
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
    });
  }

  async createModelRuntimeEnvironment(
    input: CreateModelRuntimeEnvironmentInput = {}
  ): Promise<ModelRuntimeConfigEnvironment> {
    const settings = await this.readOrCreateSettings();
    return projectModelRuntimeEnvironment(settings, this.options.secretStore, input);
  }

  async createMcpRuntimeEnvironment(
    input: CreateMcpRuntimeEnvironmentInput = {}
  ): Promise<ModelRuntimeConfigEnvironment> {
    const settings = await this.readOrCreateSettings();
    return projectMcpRuntimeEnvironment(settings, this.options.secretStore, input);
  }

  private async writeInformationAccessConfig(
    input: UpdateInformationAccessConfigInput | UpdateWebSearchConfigInput,
  ): Promise<LocalSettings> {
    const current = await this.readOrCreateSettings();
    const now = new Date().toISOString();
    const currentInformation = normalizeInformationAccessSettings(current.informationAccess, now);
    const apiKey = normalizeOptionalString(input.apiKey);
    const provider = normalizeWebSearchProvider(input.provider) ??
      (apiKey === undefined ? currentInformation.webSearch.provider : "tavily");
    const informationAccess: InformationAccessSettings = updateSelectedWebSearchProviderSettings({
      webSearch: { provider, updatedAt: now },
      tavily: currentInformation.tavily,
      exa: currentInformation.exa,
      zai: currentInformation.zai,
      metaso: currentInformation.metaso,
      google: currentInformation.google,
      bing: currentInformation.bing,
    }, {
      provider,
      now,
      maxResults: normalizePositiveInteger(input.maxResults),
      engineId: normalizeOptionalString(input.engineId),
    });
    const providerSettings = webSearchProviderSettings(informationAccess, provider);
    if (apiKey !== undefined && providerSettings !== undefined) {
      await this.options.secretStore.writeSecret(providerSettings.secretRef, apiKey);
    }
    const next: LocalSettings = {
      ...current,
      version: 1,
      informationAccess,
      updatedAt: now,
    };
    await this.options.settingsStore.writeSettings(next);
    return next;
  }

  private readOrCreateSettings(): Promise<LocalSettings> {
    const active = this.settingsRead;
    if (active !== undefined) return active;
    const load = this.readOrCreateSettingsOnce();
    const tracked = load.finally(() => {
      if (this.settingsRead === tracked) this.settingsRead = undefined;
    });
    this.settingsRead = tracked;
    return tracked;
  }

  private async readOrCreateSettingsOnce(): Promise<LocalSettings> {
    const existing = await this.options.settingsStore.readSettings();
    if (existing !== undefined) {
      let parsed: LocalSettings;
      try {
        parsed = parseLocalSettingsFile(existing);
      } catch (error) {
        if (!(error instanceof ConfigSchemaValidationError)) throw error;
        if (this.options.settingsStore.quarantineInvalidSettings === undefined) throw error;
        await this.options.settingsStore.quarantineInvalidSettings();
        const created = createDefaultLocalSettings();
        await this.options.settingsStore.writeSettings(created);
        return created;
      }
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
