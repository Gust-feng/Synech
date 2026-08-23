import { deleteJson, getJson, postJson } from "./api";
import {
  catalogRecordFromList,
  mergeConfigResponse,
  type ComposerToolConfirmationPolicy,
  type VisibleAiMode,
} from "./app-config-projection";
import type { McpServerForm, ModelForm, ToolForm } from "./components/settings-types";
import type { CommandShellKind, ConfigResponse, ModelCapabilities, ModelProviderModelCatalog, SkillTriggerMode } from "./contracts/config";
import type { SkillDefinition } from "./contracts/skills";
import type { SubAgentDefinition } from "./contracts/sub-agents";
import type { McpEnvironmentCheckResponse, McpReferenceResponse, McpServerPreset, ToolsResponse } from "./contracts/tools";
import { parseModelOptionId } from "./model-options";

export async function saveModelProviderConfig(input: {
  readonly config: ConfigResponse | undefined;
  readonly form: ModelForm;
  readonly aiMode: VisibleAiMode;
}): Promise<ConfigResponse> {
  const existingProfile = input.config?.profiles?.some((profile) => profile.profileId === input.form.profileId) === true;
  const preset = existingProfile
    ? undefined
    : input.config?.modelProviderMarket?.presets?.find((item) => item.presetId === input.form.profileId);
  if (preset !== undefined) {
    const created = await postJson<ConfigResponse>("/api/config/model-profiles", {
      profileId: preset.presetId,
      label: input.form.label.trim() || preset.label,
      logoDataUrl: input.form.logoCleared ? undefined : input.form.logoDataUrl,
      clearLogoDataUrl: input.form.logoCleared,
      providerKind: preset.providerKind,
      protocolKind: input.form.protocolKind || preset.protocolKind,
      baseUrl: input.form.baseUrl || preset.baseUrl,
      model: input.form.model,
      clearModel: input.form.model.trim().length === 0,
      apiKey: input.form.apiKeyCleared ? undefined : input.form.apiKey,
      defaultAiMode: input.aiMode,
    });
    return mergeConfigResponse(
      created,
      await postJson<ConfigResponse>(`/api/config/model-profiles/${encodeURIComponent(preset.presetId)}/activate`, {})
    );
  }

  const updated = await postJson<ConfigResponse>("/api/config/model-provider", {
    profileId: input.form.profileId,
    label: input.form.label,
    logoDataUrl: input.form.logoCleared ? undefined : input.form.logoDataUrl,
    clearLogoDataUrl: input.form.logoCleared,
    baseUrl: input.form.baseUrl,
    protocolKind: input.form.protocolKind,
    model: input.form.model,
    clearModel: input.form.model.trim().length === 0,
    apiKey: input.form.apiKeyCleared ? undefined : input.form.apiKey,
    clearApiKey: input.form.apiKeyCleared,
    defaultAiMode: input.aiMode,
  });
  return input.form.profileId.length > 0 && input.config?.config?.profileId !== input.form.profileId
    ? mergeConfigResponse(
        updated,
        await postJson<ConfigResponse>(`/api/config/model-profiles/${encodeURIComponent(input.form.profileId)}/activate`, {})
      )
    : updated;
}

export async function createCustomModelProviderProfile(input: {
  readonly form: ModelForm;
  readonly aiMode: VisibleAiMode;
}): Promise<ConfigResponse> {
  const label = input.form.label.trim() || "自定义厂商";
  const created = await postJson<ConfigResponse>("/api/config/model-profiles", {
    profileId: input.form.profileId.trim() || label,
    label,
    logoDataUrl: input.form.logoCleared ? undefined : input.form.logoDataUrl,
    clearLogoDataUrl: input.form.logoCleared,
    providerKind: "openai_compatible",
    protocolKind: input.form.protocolKind || "openai_compatible_chat_completions",
    baseUrl: input.form.baseUrl,
    model: input.form.model,
    clearModel: input.form.model.trim().length === 0,
    defaultAiMode: input.aiMode,
    apiKey: input.form.apiKey,
  });
  const profileId = created.profile?.profileId ?? created.config?.profileId ?? label;
  return mergeConfigResponse(
    created,
    await postJson<ConfigResponse>(`/api/config/model-profiles/${encodeURIComponent(profileId)}/activate`, {})
  );
}

export async function saveModelProviderOrder(order: readonly string[]): Promise<ConfigResponse> {
  return postJson<ConfigResponse>("/api/config/model-provider-order", { order });
}

export async function deleteModelProviderProfile(input: {
  readonly config: ConfigResponse | undefined;
  readonly profileId: string;
  readonly fallbackProfileId?: string;
}): Promise<ConfigResponse> {
  const profileId = input.profileId.trim();
  if (profileId.length === 0) {
    throw new Error("模型服务删除失败：模型配置无效。");
  }
  const fallbackProfileId =
    input.fallbackProfileId?.trim() ||
    (input.config?.config?.profileId === profileId
      ? input.config.profiles?.find((profile) => profile.profileId !== profileId)?.profileId
      : undefined);
  let activated: ConfigResponse | undefined;
  if (fallbackProfileId !== undefined && fallbackProfileId.length > 0 && fallbackProfileId !== profileId) {
    activated = await postJson<ConfigResponse>(`/api/config/model-profiles/${encodeURIComponent(fallbackProfileId)}/activate`, {});
  } else if (input.config?.config?.profileId === profileId) {
    throw new Error("模型服务删除失败：至少需要保留一个模型服务。");
  }
  const deleted = await deleteJson<ConfigResponse>(`/api/config/model-profiles/${encodeURIComponent(profileId)}`);
  return activated === undefined ? deleted : mergeConfigResponse(activated, deleted);
}

export async function revealModelProviderApiKey(profileId: string): Promise<string | undefined> {
  const response = await getJson<{ readonly apiKey?: string }>(
    `/api/config/model-profiles/${encodeURIComponent(profileId)}/api-key`
  );
  return typeof response.apiKey === "string" ? response.apiKey : undefined;
}

export async function selectModelProviderModel(input: {
  readonly config: ConfigResponse | undefined;
  readonly modelOptionId: string;
  readonly aiMode: VisibleAiMode;
}): Promise<{
  readonly config?: ConfigResponse;
  readonly form?: ModelForm;
}> {
  const parsed = parseModelOptionId(input.modelOptionId);
  if (parsed === undefined) {
    throw new Error("模型切换失败：模型选项无效，请重新打开模型列表后再试。");
  }
  const profile = input.config?.profiles?.find((item) => item.profileId === parsed.profileId);
  if (profile === undefined) {
    throw new Error("模型切换失败：未找到对应模型配置。");
  }
  const updated = await postJson<ConfigResponse>(`/api/config/model-profiles/${encodeURIComponent(parsed.profileId)}`, {
    model: parsed.modelId,
    defaultAiMode: input.aiMode,
  });
  const activated =
    input.config?.config?.profileId === parsed.profileId
      ? updated
      : mergeConfigResponse(updated, await postJson<ConfigResponse>(`/api/config/model-profiles/${encodeURIComponent(parsed.profileId)}/activate`, {}));
  return {
    config: activated,
    form: {
      profileId: parsed.profileId,
      label: profile.label ?? parsed.profileId,
      logoDataUrl: profile.logoDataUrl ?? "",
      logoCleared: false,
      baseUrl: profile.baseUrl ?? "",
      protocolKind: profile.protocolKind ?? "openai_compatible_chat_completions",
      model: parsed.modelId,
      apiKey: "",
      apiKeyCleared: false,
    },
  };
}

export async function fetchModelProviderCatalog(profileId: string): Promise<{
  readonly catalog: ModelProviderModelCatalog;
  readonly catalogs?: readonly ModelProviderModelCatalog[];
  readonly modelCapabilityProfiles?: ConfigResponse["modelCapabilityProfiles"];
}> {
  const response = await getJson<{
    readonly catalog: ModelProviderModelCatalog;
    readonly modelCatalogs?: readonly ModelProviderModelCatalog[];
    readonly modelCapabilityProfiles?: ConfigResponse["modelCapabilityProfiles"];
  }>(`/api/config/model-profiles/${encodeURIComponent(profileId)}/models`);
  return {
    catalog: response.catalog,
    catalogs: response.modelCatalogs,
    modelCapabilityProfiles: response.modelCapabilityProfiles,
  };
}

export async function saveModelProviderCatalog(input: {
  readonly profileId: string;
  readonly catalog: ModelProviderModelCatalog;
}): Promise<ConfigResponse> {
  const response = await postJson<{
    readonly catalog: ModelProviderModelCatalog;
    readonly modelCatalogs?: readonly ModelProviderModelCatalog[];
  } & ConfigResponse>(`/api/config/model-profiles/${encodeURIComponent(input.profileId)}/model-catalog`, {
    label: input.catalog.label,
    baseUrl: input.catalog.baseUrl,
    modelsPath: input.catalog.modelsPath,
    fetchedAt: input.catalog.fetchedAt,
    models: input.catalog.models,
  });
  return {
    ...response,
    modelCatalogs: response.modelCatalogs ?? [response.catalog],
  };
}

export type ModelCapabilityUpdateForm = {
  readonly profileId: string;
  readonly providerKind?: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
};

export async function saveModelCapabilityConfig(input: ModelCapabilityUpdateForm): Promise<ConfigResponse> {
  return postJson<ConfigResponse>("/api/config/model-capabilities", {
    profileId: input.profileId,
    providerKind: input.providerKind,
    model: input.model,
    capabilities: input.capabilities,
  });
}

export async function saveCommandShellConfig(kind: CommandShellKind | "auto"): Promise<ConfigResponse> {
  return postJson<ConfigResponse>("/api/config/command-shell", { kind });
}

export async function saveToolConfirmationConfig(policy: ComposerToolConfirmationPolicy): Promise<ConfigResponse> {
  return postJson<ConfigResponse>("/api/config/tool-confirmation", { policy });
}

export async function saveOrdinaryAgentSystemPrompt(systemPrompt: string): Promise<ConfigResponse> {
  return postJson<ConfigResponse>("/api/config/ordinary-agent", { systemPrompt });
}

export async function saveOrdinaryAgentSystemPromptVariant(variant: string): Promise<ConfigResponse> {
  return postJson<ConfigResponse>("/api/config/ordinary-agent", { systemPromptVariant: variant });
}

export async function resetOrdinaryAgentSystemPrompt(): Promise<ConfigResponse> {
  return postJson<ConfigResponse>("/api/config/ordinary-agent", { resetSystemPrompt: true });
}

export async function saveSkillTriggerConfig(mode: SkillTriggerMode): Promise<ConfigResponse> {
  return postJson<ConfigResponse>("/api/config/skill-trigger", { mode });
}

export async function saveToolSettings(form: ToolForm): Promise<ToolsResponse> {
  return postJson<ToolsResponse>("/api/config/tools/web-search", {
    provider: form.provider,
    apiKey: form.apiKey,
    maxResults: Number(form.maxResults),
    engineId: form.engineId,
  });
}

export async function saveMcpServerSettings(form: McpServerForm): Promise<ToolsResponse> {
  const normalizedServerId = normalizeMcpServerId(effectiveMcpServerId(form));
  const auth = mcpAuthConfig(form, normalizedServerId);
  const isNetworkTransport = isNetworkMcpTransport(form.transport);
  const response = await postJson<{ readonly catalog?: ToolsResponse["mcpCatalog"] }>("/api/config/mcp", {
    serverId: normalizedServerId,
    label: form.label,
    description: form.description,
    transport: form.transport,
    confirmationMode: form.confirmationMode,
    toolExposureMode: form.toolExposureMode,
    enabledTools: form.enabledTools,
    autoApprovedTools: form.autoApprovedTools,
    commandLine: form.transport === "stdio" ? form.commandLine : "",
    command: form.transport === "stdio" ? form.command : "",
    args: splitListInput(form.args),
    url: isNetworkTransport ? form.url : "",
    envSecretRefs: form.transport === "stdio" ? splitListInput(form.envSecretRefs) : [],
    headerSecretRefs: isNetworkTransport ? auth.headerSecretRefs : undefined,
    bearerTokenSecretRef: isNetworkTransport ? auth.bearerTokenSecretRef : undefined,
    clearMcpAuth: isNetworkTransport ? auth.clearMcpAuth : true,
    enabled: form.enabled,
  });
  let latestCatalog = response.catalog ?? [];
  for (const secret of auth.secretsToSave) {
    const secretResponse = await saveMcpServerSecret({
      serverId: normalizedServerId,
      secretRef: secret.secretRef,
      value: secret.value,
    });
    latestCatalog = secretResponse.mcpCatalog ?? latestCatalog;
  }
  return {
    mcpCatalog: latestCatalog,
  };
}

export async function saveMcpServerSecret(input: {
  readonly serverId: string;
  readonly secretRef: string;
  readonly value: string;
}): Promise<ToolsResponse> {
  const response = await postJson<{ readonly catalog?: ToolsResponse["mcpCatalog"] }>(
    `/api/config/mcp/${encodeURIComponent(input.serverId)}/secrets`,
    {
      secretRef: input.secretRef,
      value: input.value,
    }
  );
  return { mcpCatalog: response.catalog ?? [] };
}

export async function testMcpServer(serverId: string): Promise<ToolsResponse> {
  const response = await postJson<{ readonly catalog?: ToolsResponse["mcpCatalog"] }>(
    `/api/config/mcp/${encodeURIComponent(serverId)}/test`,
    {}
  );
  return { mcpCatalog: response.catalog ?? [] };
}

export async function reloadMcpServers(): Promise<ToolsResponse> {
  const response = await postJson<{ readonly catalog?: ToolsResponse["mcpCatalog"] }>("/api/config/mcp/reload", {});
  return { mcpCatalog: response.catalog ?? [] };
}

export async function checkMcpEnvironment(form: Pick<McpServerForm, "command" | "commandLine">): Promise<McpEnvironmentCheckResponse> {
  return postJson<McpEnvironmentCheckResponse>("/api/config/mcp/environment-check", {
    command: form.command,
    commandLine: form.commandLine,
  });
}

export async function installMcpEnvironment(form: Pick<McpServerForm, "command" | "commandLine">): Promise<McpEnvironmentCheckResponse> {
  return postJson<McpEnvironmentCheckResponse>("/api/config/mcp/environment-install", {
    command: form.command,
    commandLine: form.commandLine,
  });
}

export async function deleteMcpServer(serverId: string): Promise<ToolsResponse> {
  const response = await deleteJson<{ readonly catalog?: ToolsResponse["mcpCatalog"] }>(
    `/api/config/mcp/${encodeURIComponent(serverId)}`
  );
  return { mcpCatalog: response.catalog ?? [] };
}

export async function fetchMcpPresets(): Promise<readonly McpServerPreset[]> {
  const response = await getJson<{ readonly presets?: readonly McpServerPreset[] }>("/api/config/mcp/presets");
  return response.presets ?? [];
}

export async function fetchMcpReferences(serverId: string): Promise<McpReferenceResponse> {
  const response = await getJson<McpReferenceResponse>(`/api/config/mcp/${encodeURIComponent(serverId)}/references`);
  return {
    ...response,
    prompts: response.prompts ?? [],
    resources: response.resources ?? [],
    resourceTemplates: response.resourceTemplates ?? [],
  };
}

export async function importMcpServers(config: string): Promise<ToolsResponse> {
  const response = await postJson<{ readonly catalog?: ToolsResponse["mcpCatalog"] }>("/api/config/mcp/import", {
    config,
  });
  return { mcpCatalog: response.catalog ?? [] };
}

export async function updateMcpToolState(input: {
  readonly serverId: string;
  readonly toolExposureMode?: "none" | "all" | "selected";
  readonly enabledTools: readonly string[];
  readonly autoApprovedTools?: readonly string[];
}): Promise<ToolsResponse> {
  const response = await postJson<{ readonly catalog?: ToolsResponse["mcpCatalog"] }>(
    `/api/config/mcp/${encodeURIComponent(input.serverId)}`,
    {
      serverId: input.serverId,
      toolExposureMode: input.toolExposureMode,
      enabledTools: input.enabledTools,
      autoApprovedTools: input.autoApprovedTools,
    }
  );
  return { mcpCatalog: response.catalog ?? [] };
}

export async function updateSkillState(skill: Pick<SkillDefinition, "id" | "stateKey">, enabled: boolean): Promise<readonly SkillDefinition[]> {
  const response = await postJson<{ readonly skills: readonly SkillDefinition[] }>(`/api/skills/${encodeURIComponent(skill.id)}/state`, {
    enabled,
    stateKey: skill.stateKey,
  });
  return response.skills;
}

export async function refreshSkillCatalog(): Promise<readonly SkillDefinition[]> {
  const response = await postJson<{ readonly skills: readonly SkillDefinition[] }>("/api/skills/refresh", {});
  return response.skills;
}

export async function refreshSubAgentCatalog(): Promise<readonly SubAgentDefinition[]> {
  const response = await postJson<{ readonly subAgents: readonly SubAgentDefinition[] }>("/api/config/sub-agents/refresh", {});
  return response.subAgents;
}

export function mergeCatalogsIntoConfig(
  config: ConfigResponse | undefined,
  catalogs: readonly ModelProviderModelCatalog[]
): ConfigResponse {
  return mergeConfigResponse(config, { modelCatalogs: catalogs });
}

function splitListInput(value: string): readonly string[] {
  return value
    .split(/[\n,]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function effectiveMcpServerId(form: McpServerForm): string {
  const explicit = form.serverId.trim();
  if (explicit.length > 0) return explicit;
  const label = form.label.trim();
  if (label.length > 0) return label;
  return suggestMcpServerId(form.transport === "stdio" ? form.commandLine : form.url, form.transport);
}

function suggestMcpServerId(value: string, transport: McpServerForm["transport"]): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (transport !== "stdio") {
    try {
      const url = new URL(trimmed);
      return url.pathname.split("/").filter(Boolean).pop() ?? url.hostname;
    } catch {
      return trimmed;
    }
  }
  const parts = trimmed.split(/\s+/u).filter(Boolean);
  return [...parts].reverse().find((part) => !part.startsWith("-") && part !== "." && part !== "npx" && part !== "pnpm" && part !== "bunx") ?? trimmed;
}

function normalizeMcpServerId(value: string): string {
  const withoutScope = value.replace(/^@/u, "").replace(/\//gu, "-");
  return withoutScope.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "mcp-server";
}

function mcpAuthConfig(form: McpServerForm, serverId: string): {
  readonly bearerTokenSecretRef?: string;
  readonly headerSecretRefs?: readonly string[];
  readonly clearMcpAuth?: boolean;
  readonly secretsToSave: readonly { readonly secretRef: string; readonly value: string }[];
} {
  if (!isNetworkMcpTransport(form.transport)) {
    return { clearMcpAuth: true, secretsToSave: [] };
  }
  const credential = normalizeAuthorizationCredential(form.bearerTokenValue);
  if (credential.length === 0) {
    return { clearMcpAuth: false, secretsToSave: [] };
  }
  const secretRef = form.bearerTokenSecretRef || `secret://local-dev/mcp/${serverId}/bearer`;
  return {
    bearerTokenSecretRef: secretRef,
    clearMcpAuth: false,
    secretsToSave: [{ secretRef, value: credential }],
  };
}

function isNetworkMcpTransport(transport: McpServerForm["transport"]): boolean {
  return transport === "http";
}

function normalizeAuthorizationCredential(value: string): string {
  const headerValue = value.trim().replace(/^authorization\s*:\s*/iu, "").trim();
  return headerValue.replace(/^bearer\s+/iu, "").trim();
}

export { catalogRecordFromList };
