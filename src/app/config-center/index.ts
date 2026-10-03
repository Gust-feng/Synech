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
  ModelProviderModelCatalog,
  ModelProviderConnectionSettings,
  ModelProviderCredentialStorePort,
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
  UpdateModelConfigurationInput,
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
  normalizeProfileId,
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
  toSanitizedModelProfile,
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
import { modelProviderConnectionIdentity, modelProviderCredentialSecretRef, readModelProviderCredential } from "./model-provider-credentials.js";
import { ConfigCenterValidationError } from "./config-center-error.js";
import { parseModelProviderConnectionSettings } from "./model-provider-connection-settings.js";
import { parseModelConfigurationUpdate } from "./model-configuration-schema.js";

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
  private readonly credentialGenerations = new Map<string, number>();
  private readonly credentialMutationTails = new Map<string, Promise<void>>();

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
    return this.runMutation(async () => {
      const settings = await this.readOrCreateSettings();
      return readModelProviderApiKey(settings, this.options.secretStore, profileId);
    });
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
    profileId = normalizeProfileId(profileId);
    return this.runMutation(async () => {
      const current = await this.readOrCreateSettings();
      const change = await deleteModelProviderProfileSettings(
        current,
        this.options.secretStore,
        profileId,
        new Date().toISOString(),
      );
      await this.options.settingsStore.writeSettings(change.settings);
      this.invalidateCredentialGeneration(profileId);
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
      const oldProfile = current.modelProfiles.find((profile) => profile.profileId === change.result.profileId);
      const newProfile = change.settings.modelProfiles.find((profile) => profile.profileId === change.result.profileId);
      if (oldProfile !== undefined && newProfile !== undefined &&
          (modelProviderConnectionIdentity(oldProfile) !== modelProviderConnectionIdentity(newProfile) ||
           input.apiKey !== undefined || input.clearApiKey === true)) {
        this.invalidateCredentialGeneration(newProfile.profileId);
      }
      return change.result;
    });
  }

  async updateModelConfiguration(input: UpdateModelConfigurationInput): Promise<SanitizedModelProviderConfig> {
    const { profileId, modelId, settings } = parseModelConfigurationUpdate(input);
    return this.runMutation(async () => {
      const current = await this.readOrCreateSettings();
      const profile = current.modelProfiles.find((item) => item.profileId === profileId);
      if (profile === undefined) throw new ConfigCenterValidationError(`Model profile not found: ${profileId}`);
      const modelSettings = Object.fromEntries([
        ...Object.entries(profile.modelSettings ?? {}).filter(([id]) => id !== modelId),
        ...(settings === undefined ? [] : [[modelId, settings] as const]),
      ]);
      const updatedAt = new Date().toISOString();
      const updatedProfile = {
        ...profile,
        modelSettings: Object.keys(modelSettings).length === 0 ? undefined : modelSettings,
        updatedAt,
      };
      const next = normalizeLocalSettings({
        ...current,
        modelProfiles: current.modelProfiles.map((item) => item.profileId === profileId ? updatedProfile : item),
        updatedAt,
      });
      await this.options.settingsStore.writeSettings(next);
      return toSanitizedModelProfile({ profile: updatedProfile, secretStore: this.options.secretStore });
    });
  }

  async createModelProviderCredentialStore(
    profileId: string,
    scope: {
      readonly rotateRevisionOnWrite?: boolean;
      readonly onPublicationStarted?: () => void;
      readonly preparePublication?: (input: {
        readonly connection: ModelProviderConnectionSettings;
        readonly credential: unknown;
      }) => {
        readonly connection: ModelProviderConnectionSettings;
        readonly credential: unknown | undefined;
      };
    } = {},
  ): Promise<ModelProviderCredentialStorePort> {
    profileId = normalizeProfileId(profileId);
    return this.runMutation(async () => {
      const settings = await this.readOrCreateSettings();
      const profile = settings.modelProfiles.find((item) => item.profileId === profileId);
      if (profile === undefined) throw new ConfigCenterValidationError(`Model profile not found: ${profileId}`);
      let identity = modelProviderConnectionIdentity(profile);
      let generation = this.credentialGenerations.get(profileId) ?? 0;
      const requireCurrent = async () => {
        const current = await this.readOrCreateSettings();
        const candidate = current.modelProfiles.find((item) => item.profileId === profileId);
        if (candidate === undefined || modelProviderConnectionIdentity(candidate) !== identity ||
            (this.credentialGenerations.get(profileId) ?? 0) !== generation) {
          throw new ConfigCenterValidationError("Model credential operation belongs to a removed or changed connection.");
        }
        return candidate;
      };
      return {
        read: (options) => this.runMutation(async () => {
          options?.signal?.throwIfAborted();
          const current = await requireCurrent();
          return readModelProviderCredential(this.options.secretStore, current);
        }),
        modify: (update, options) => {
          const operationIdentity = identity;
          const operationGeneration = generation;
          const requireOperationCurrent = async () => {
            if (identity !== operationIdentity || generation !== operationGeneration ||
                (this.credentialGenerations.get(profileId) ?? 0) !== operationGeneration) {
              throw new ConfigCenterValidationError("Model credential operation was revoked before publication.");
            }
            return requireCurrent();
          };
          return this.runCredentialMutation(profileId, async () => {
            options?.signal?.throwIfAborted();
            const previous = await this.runMutation(async () => {
              const current = await requireOperationCurrent();
              return readModelProviderCredential(this.options.secretStore, current);
            });
            const next = await update(previous);
            options?.signal?.throwIfAborted();
            return this.runMutation(async () => {
              options?.signal?.throwIfAborted();
              const current = await requireOperationCurrent();
              if (next === undefined) return previous;
              if (current.protocolKind !== "native") {
                throw new ConfigCenterValidationError("Native credential writes require a native connection.");
              }
              if (current.piProviderId === undefined || current.connection === undefined) {
                throw new ConfigCenterValidationError("Native credential publication requires a service and authentication mode.");
              }
              const publication = scope.preparePublication === undefined
                ? { connection: current.connection, credential: next }
                : scope.preparePublication({ connection: current.connection, credential: next });
              const connection = parseModelProviderConnectionSettings(publication.connection);
              // No await may separate this final cancellation check from publication ownership.
              options?.signal?.throwIfAborted();
              scope.onPublicationStarted?.();
              if (JSON.stringify(connection) !== JSON.stringify(current.connection) || scope.rotateRevisionOnWrite === true) {
                const settings = await this.readOrCreateSettings();
                const updatedAt = new Date().toISOString();
                await this.options.settingsStore.writeSettings(normalizeLocalSettings({
                  ...settings,
                  modelProfiles: settings.modelProfiles.map((profile) => profile.profileId === profileId
                    ? { ...profile, connection, updatedAt }
                    : profile),
                  updatedAt,
                }));
                this.invalidateCredentialGeneration(profileId);
              }
              if (publication.credential === undefined) {
                await this.options.secretStore.deleteSecret(modelProviderCredentialSecretRef({ ...current, connection }));
              } else {
                const serialized = JSON.stringify(publication.credential);
                if (serialized === undefined) throw new ConfigCenterValidationError("Model credential is not serializable.");
                await this.options.secretStore.writeSecret(modelProviderCredentialSecretRef({ ...current, connection }), serialized);
              }
              identity = modelProviderConnectionIdentity({ ...current, connection });
              generation = this.credentialGenerations.get(profileId) ?? 0;
              return next;
            });
          });
        },
        delete: (options) => this.runMutation(async () => {
          options?.signal?.throwIfAborted();
          const current = await requireCurrent();
          await this.options.secretStore.deleteSecret(modelProviderCredentialSecretRef(current));
          const settings = await this.readOrCreateSettings();
          const updatedAt = new Date().toISOString();
          await this.options.settingsStore.writeSettings(normalizeLocalSettings({
            ...settings,
            modelProfiles: settings.modelProfiles.map((profile) => profile.profileId === profileId
              ? { ...profile, updatedAt }
              : profile),
            updatedAt,
          }));
          this.invalidateCredentialGeneration(profileId);
          generation = this.credentialGenerations.get(profileId) ?? 0;
        }),
      };
    });
  }

  async invalidateModelProviderLogin(profileId: string): Promise<void> {
    await this.runMutation(async () => {
      this.invalidateCredentialGeneration(profileId);
    });
  }

  private invalidateCredentialGeneration(profileId: string): void {
    profileId = normalizeProfileId(profileId);
    this.credentialGenerations.set(profileId, (this.credentialGenerations.get(profileId) ?? 0) + 1);
  }


  private runCredentialMutation<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const tail = this.credentialMutationTails.get(profileId) ?? Promise.resolve();
    const result = tail.then(operation, operation);
    const tracked = result.then(() => undefined, () => undefined);
    this.credentialMutationTails.set(profileId, tracked);
    void tracked.then(() => {
      if (this.credentialMutationTails.get(profileId) === tracked) this.credentialMutationTails.delete(profileId);
    });
    return result;
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
    return this.runMutation(async () => {
      const settings = await this.readOrCreateSettings();
      return projectModelRuntimeEnvironment(settings, this.options.secretStore, input);
    });
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
