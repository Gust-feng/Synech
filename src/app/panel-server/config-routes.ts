import type { IncomingMessage, ServerResponse } from "node:http";
import type { ModelCapabilities, ModelProviderModelCatalog, SanitizedWebSearchConfig } from "../../domain/config/index.js";
import { listBuiltinMcpServerPresets, listBuiltinModelProviderPresets, listBuiltinProviderProtocolProfiles } from "../../domain/config/index.js";
import type { SanitizedModelProviderConfig } from "../../domain/config/index.js";
import { resolveModelCapabilities } from "../model-runtime/model-capability-registry.js";
import { fetchModelRuntimeModelCatalog } from "../model-runtime/index.js";
import { CapabilityCenter } from "../capability/capability-center.js";
import {
  ConfigCenter,
  ConfigCenterValidationError,
} from "../config-center/index.js";
import type { ToolCatalogSnapshot } from "../tool-center/index.js";
import { PanelHttpError, readJsonBody, writeJson } from "./http-utils.js";
import {
  parseConfigUpdate,
  parseCommandShellUpdate,
  parseCreateModelProfile,
  parseOrdinaryAgentPromptUpdate,
  parseInformationAccessUpdate,
  parseModelCapabilityUpdate,
  parseModelCatalogUpdate,
  parseModelProviderOrderUpdate,
  parseMcpEnvironmentRequest,
  parseMcpServerSecretValue,
  parseMcpServerImport,
  parseMcpServerUpdate,
  parseSkillTriggerUpdate,
  parseToolConfirmationUpdate,
  parseToolStateUpdate,
  parseWebSearchUpdate,
} from "./request-parsers.js";
import { checkPanelMcpEnvironment, installPanelMcpEnvironment, listPanelMcpReferences, testPanelMcpServer } from "./mcp-management-service.js";
import type { PanelModelCatalogFetch } from "./types.js";
import { readProductPackageVersion } from "../../platform/product-version.js";
import { PRODUCT_DISPLAY_NAME } from "../../platform/product-identity.js";
import type { ProductPaths } from "../../platform/storage/index.js";

export type PanelConfigRouteRuntime = {
  readonly configCenter: ConfigCenter;
  readonly capabilityCenter: CapabilityCenter;
  readonly managedMcpBinDirectory: string;
  readonly configDirectory: string;
  readonly productPaths: ProductPaths;
  readonly modelCatalogFetch?: PanelModelCatalogFetch;
};

type PanelToolsConfig = {
  readonly webSearch: SanitizedWebSearchConfig;
  readonly catalog: ToolCatalogSnapshot;
};

type PanelModelCapabilityProfile = {
  readonly profileId: string;
  readonly providerKind: SanitizedModelProviderConfig["providerKind"];
  readonly protocolKind: SanitizedModelProviderConfig["protocolKind"];
  readonly model: string;
  readonly capabilities: ModelCapabilities;
};

const MODEL_PROVIDER_CONFIG_BODY_MAX_CHARS = 4_500_000;

export async function handlePanelConfigRoute(
  runtime: PanelConfigRouteRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/api/config") {
    const config = await runtime.configCenter.getModelProviderConfig();
    const capabilities = await runtime.capabilityCenter.snapshot();
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      config,
      profiles: await runtime.configCenter.listModelProviderProfiles(),
      modelProviderOrder: await runtime.configCenter.getModelProviderOrder(),
      modelCatalogs: await runtime.configCenter.listModelProviderModelCatalogs(),
      modelCapabilityProfiles: await modelCapabilityProfilesPayload(runtime),
      modelProviderMarket: modelProviderMarketPayload(),
      product: productInfoPayload(runtime),
      capabilities,
      informationAccess: await runtime.configCenter.getInformationAccessConfig(),
      commandShell: await runtime.configCenter.getCommandShellConfig(),
      toolConfirmation: await runtime.configCenter.getToolConfirmationConfig(),
      ordinaryAgent: await runtime.configCenter.getOrdinaryAgentPromptConfig(),
      skillTrigger: await runtime.configCenter.getSkillTriggerConfig(),
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/config/capabilities") {
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      capabilities: await runtime.capabilityCenter.snapshot(),
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/config/model-profiles") {
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      profiles: await runtime.configCenter.listModelProviderProfiles(),
      activeProfile: await runtime.configCenter.getModelProviderConfig(),
      modelProviderOrder: await runtime.configCenter.getModelProviderOrder(),
      modelCatalogs: await runtime.configCenter.listModelProviderModelCatalogs(),
      modelCapabilityProfiles: await modelCapabilityProfilesPayload(runtime),
      modelProviderMarket: modelProviderMarketPayload(),
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/config/model-provider-market") {
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      presets: listBuiltinModelProviderPresets(),
      providerProtocolProfiles: listBuiltinProviderProtocolProfiles(),
      profiles: await runtime.configCenter.listModelProviderProfiles(),
      activeProfile: await runtime.configCenter.getModelProviderConfig(),
      modelProviderOrder: await runtime.configCenter.getModelProviderOrder(),
      modelCatalogs: await runtime.configCenter.listModelProviderModelCatalogs(),
      modelCapabilityProfiles: await modelCapabilityProfilesPayload(runtime),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/model-profiles") {
    const body = await readJsonBody(request, { maxChars: MODEL_PROVIDER_CONFIG_BODY_MAX_CHARS });
    try {
      const profile = await runtime.configCenter.createModelProviderProfile(parseCreateModelProfile(body));
      invalidateCapabilityCache(runtime);
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        profile,
        profiles: await runtime.configCenter.listModelProviderProfiles(),
        modelProviderOrder: await runtime.configCenter.getModelProviderOrder(),
        modelCatalogs: await runtime.configCenter.listModelProviderModelCatalogs(),
        modelCapabilityProfiles: await modelCapabilityProfilesPayload(runtime),
        modelProviderMarket: modelProviderMarketPayload(),
        capabilities: await modelCapabilitiesPayload(runtime),
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/config/model-provider-order") {
    const body = await readJsonBody(request);
    const input = parseModelProviderOrderUpdate(body);
    const modelProviderOrder = await runtime.configCenter.updateModelProviderOrder(input.order);
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      config: await runtime.configCenter.getModelProviderConfig(),
      modelProviderOrder,
      profiles: await runtime.configCenter.listModelProviderProfiles(),
      modelCatalogs: await runtime.configCenter.listModelProviderModelCatalogs(),
      modelCapabilityProfiles: await modelCapabilityProfilesPayload(runtime),
      modelProviderMarket: modelProviderMarketPayload(),
      capabilities: await modelCapabilitiesPayload(runtime),
    });
    return true;
  }

  const modelProfileMatch = /^\/api\/config\/model-profiles\/([^/]+)$/.exec(url.pathname);
  if (request.method === "POST" && modelProfileMatch !== null) {
    const body = await readJsonBody(request, { maxChars: MODEL_PROVIDER_CONFIG_BODY_MAX_CHARS });
    try {
      const profileId = decodeURIComponent(modelProfileMatch[1] ?? "");
      const profile = await runtime.configCenter.updateModelProviderConfig({
        ...parseConfigUpdate(body),
        profileId,
      });
      invalidateCapabilityCache(runtime);
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        profile,
        profiles: await runtime.configCenter.listModelProviderProfiles(),
        modelProviderOrder: await runtime.configCenter.getModelProviderOrder(),
        modelCatalogs: await runtime.configCenter.listModelProviderModelCatalogs(),
        modelCapabilityProfiles: await modelCapabilityProfilesPayload(runtime),
        modelProviderMarket: modelProviderMarketPayload(),
        capabilities: await modelCapabilitiesPayload(runtime),
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  const modelProfileModelsMatch = /^\/api\/config\/model-profiles\/([^/]+)\/models$/.exec(url.pathname);
  if (request.method === "GET" && modelProfileModelsMatch !== null) {
    try {
      const profileId = decodeURIComponent(modelProfileModelsMatch[1] ?? "");
      const profile = (await runtime.configCenter.listModelProviderProfiles()).find((item) => item.profileId === profileId);
      if (profile === undefined) {
        throw new PanelHttpError(404, "model_profile_not_found", "未找到模型配置。");
      }
      const apiKey = await runtime.configCenter.getModelProviderApiKey(profile.profileId);
      if (apiKey === undefined) {
        throw new PanelHttpError(400, "missing_model_provider_key", "获取模型列表前需要先保存该厂商的 API Key。");
      }
      const catalog = await fetchModelRuntimeModelCatalog({
        profile,
        apiKey,
        fetch: runtime.modelCatalogFetch,
      });
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        config: await runtime.configCenter.getModelProviderConfig(),
        profiles: await runtime.configCenter.listModelProviderProfiles(),
        modelProviderOrder: await runtime.configCenter.getModelProviderOrder(),
        catalog,
        modelCatalogs: await runtime.configCenter.listModelProviderModelCatalogs(),
        modelCapabilityProfiles: await modelCapabilityProfilesPayload(runtime, { extraCatalog: catalog }),
        capabilities: await modelCapabilitiesPayload(runtime),
      });
      return true;
    } catch (error) {
      if (error instanceof PanelHttpError) {
        throw error;
      }
      throw new PanelHttpError(502, "model_catalog_failed", "模型列表获取失败，请检查厂商地址、密钥和网络。");
    }
  }

  const modelProfileCatalogMatch = /^\/api\/config\/model-profiles\/([^/]+)\/model-catalog$/.exec(url.pathname);
  if (request.method === "POST" && modelProfileCatalogMatch !== null) {
    const body = await readJsonBody(request);
    try {
      const profileId = decodeURIComponent(modelProfileCatalogMatch[1] ?? "");
      const profile = (await runtime.configCenter.listModelProviderProfiles()).find((item) => item.profileId === profileId);
      if (profile === undefined) {
        throw new PanelHttpError(404, "model_profile_not_found", "未找到模型配置。");
      }
      const input = parseModelCatalogUpdate(body);
      const catalog = await runtime.configCenter.upsertModelProviderModelCatalog({
        profileId,
        label: input.label ?? profile.label,
        baseUrl: input.baseUrl ?? profile.baseUrl,
        modelsPath: input.modelsPath ?? "/models",
        fetchedAt: input.fetchedAt ?? new Date().toISOString(),
        models: input.models,
      });
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        config: await runtime.configCenter.getModelProviderConfig(),
        profiles: await runtime.configCenter.listModelProviderProfiles(),
        modelProviderOrder: await runtime.configCenter.getModelProviderOrder(),
        catalog,
        modelCatalogs: await runtime.configCenter.listModelProviderModelCatalogs(),
        modelCapabilityProfiles: await modelCapabilityProfilesPayload(runtime),
        capabilities: await modelCapabilitiesPayload(runtime),
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  const modelProfileApiKeyMatch = /^\/api\/config\/model-profiles\/([^/]+)\/api-key$/.exec(url.pathname);
  if (request.method === "GET" && modelProfileApiKeyMatch !== null) {
    const profileId = decodeURIComponent(modelProfileApiKeyMatch[1] ?? "");
    const apiKey = await runtime.configCenter.getModelProviderApiKey(profileId);
    if (apiKey === undefined) {
      throw new PanelHttpError(404, "model_provider_key_not_found", "未找到该厂商的 API Key。");
    }
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      profileId,
      apiKey,
    });
    return true;
  }

  const activateProfileMatch = /^\/api\/config\/model-profiles\/([^/]+)\/activate$/.exec(url.pathname);
  if (request.method === "POST" && activateProfileMatch !== null) {
    try {
      const profile = await runtime.configCenter.activateModelProviderProfile(
        decodeURIComponent(activateProfileMatch[1] ?? "")
      );
      invalidateCapabilityCache(runtime);
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        profile,
        config: profile,
        modelProviderOrder: await runtime.configCenter.getModelProviderOrder(),
        modelCatalogs: await runtime.configCenter.listModelProviderModelCatalogs(),
        modelCapabilityProfiles: await modelCapabilityProfilesPayload(runtime),
        modelProviderMarket: modelProviderMarketPayload(),
        capabilities: await modelCapabilitiesPayload(runtime),
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  const deleteProfileMatch = /^\/api\/config\/model-profiles\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && deleteProfileMatch !== null) {
    try {
      const profiles = await runtime.configCenter.deleteModelProviderProfile(
        decodeURIComponent(deleteProfileMatch[1] ?? "")
      );
      invalidateCapabilityCache(runtime);
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        profiles,
        modelProviderOrder: await runtime.configCenter.getModelProviderOrder(),
        modelCatalogs: await runtime.configCenter.listModelProviderModelCatalogs(),
        modelCapabilityProfiles: await modelCapabilityProfilesPayload(runtime),
        modelProviderMarket: modelProviderMarketPayload(),
        capabilities: await modelCapabilitiesPayload(runtime),
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  if (request.method === "GET" && url.pathname === "/api/config/tools") {
    const tools: PanelToolsConfig = {
      webSearch: await runtime.configCenter.getWebSearchConfig(),
      catalog: await readPanelToolCatalog(runtime),
    };
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      tools,
      capabilities: await runtime.capabilityCenter.snapshot(),
      informationAccess: await runtime.configCenter.getInformationAccessConfig(),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/model-provider") {
    const body = await readJsonBody(request, { maxChars: MODEL_PROVIDER_CONFIG_BODY_MAX_CHARS });
    try {
      const config = await runtime.configCenter.updateModelProviderConfig(parseConfigUpdate(body));
      invalidateCapabilityCache(runtime);
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        config,
        profiles: await runtime.configCenter.listModelProviderProfiles(),
        modelProviderOrder: await runtime.configCenter.getModelProviderOrder(),
        modelCatalogs: await runtime.configCenter.listModelProviderModelCatalogs(),
        modelCapabilityProfiles: await modelCapabilityProfilesPayload(runtime),
        modelProviderMarket: modelProviderMarketPayload(),
        capabilities: await modelCapabilitiesPayload(runtime),
        informationAccess: await runtime.configCenter.getInformationAccessConfig(),
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/config/model-capabilities") {
    const body = await readJsonBody(request);
    const input = parseModelCapabilityUpdate(body);
    const activeProfile = await runtime.configCenter.getModelProviderConfig();
    const targetProfile = input.profileId === undefined
      ? activeProfile
      : (await runtime.configCenter.listModelProviderProfiles()).find((profile) => profile.profileId === input.profileId);
    if (targetProfile === undefined) {
      throw new PanelHttpError(404, "model_profile_not_found", "未找到模型配置。");
    }
    const model = input.model ?? targetProfile.model;
    if (model === undefined) {
      throw new PanelHttpError(400, "missing_model_name", "保存模型能力前需要先填写模型名。");
    }
    await runtime.configCenter.updateModelCapabilityOverride({
      profileId: targetProfile.profileId,
      providerKind: input.providerKind ?? targetProfile.providerKind,
      model,
      capabilities: input.capabilities,
    });
    invalidateCapabilityCache(runtime);
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      config: await runtime.configCenter.getModelProviderConfig(),
      profiles: await runtime.configCenter.listModelProviderProfiles(),
      modelCatalogs: await runtime.configCenter.listModelProviderModelCatalogs(),
      modelCapabilityProfiles: await modelCapabilityProfilesPayload(runtime),
      capabilities: await runtime.capabilityCenter.snapshot(),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/information-sources") {
    const body = await readJsonBody(request);
    const informationAccess = await runtime.configCenter.updateInformationAccessConfig(parseInformationAccessUpdate(body));
    invalidateCapabilityCache(runtime);
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      informationAccess,
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/tools/web-search") {
    const body = await readJsonBody(request);
    const webSearch = await runtime.configCenter.updateWebSearchConfig(parseWebSearchUpdate(body));
    invalidateCapabilityCache(runtime);
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      tools: { webSearch, catalog: await readPanelToolCatalog(runtime) },
      capabilities: await runtime.capabilityCenter.snapshot(),
      informationAccess: await runtime.configCenter.getInformationAccessConfig(),
    });
    return true;
  }

  const toolStateMatch = /^\/api\/config\/tools\/([^/]+)\/state$/.exec(url.pathname);
  if (request.method === "POST" && toolStateMatch !== null) {
    const body = await readJsonBody(request);
    const toolName = decodeURIComponent(toolStateMatch[1] ?? "");
    await runtime.configCenter.updateToolState(parseToolStateUpdate(toolName, body));
    invalidateCapabilityCache(runtime);
    const tools: PanelToolsConfig = {
      webSearch: await runtime.configCenter.getWebSearchConfig(),
      catalog: await readPanelToolCatalog(runtime),
    };
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      tools,
      capabilities: await runtime.capabilityCenter.snapshot(),
      informationAccess: await runtime.configCenter.getInformationAccessConfig(),
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/config/mcp") {
    const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      catalog: capabilitySnapshot.mcpCatalog,
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/config/sub-agents") {
    const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      subAgents: capabilitySnapshot.subAgentCatalog,
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/sub-agents/refresh") {
    invalidateCapabilityCache(runtime);
    const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      subAgents: capabilitySnapshot.subAgentCatalog,
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/config/mcp/presets") {
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      presets: listBuiltinMcpServerPresets(),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/mcp/import") {
    const body = await readJsonBody(request);
    try {
      const imported = parseMcpServerImport(body);
      for (const server of imported) {
        await runtime.configCenter.upsertMcpServer(server);
      }
      invalidateCapabilityCache(runtime);
      const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        importedCount: imported.length,
        catalog: capabilitySnapshot.mcpCatalog,
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/config/mcp") {
    const body = await readJsonBody(request);
    try {
      await runtime.configCenter.upsertMcpServer(parseMcpServerUpdate(body));
      invalidateCapabilityCache(runtime);
      const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        catalog: capabilitySnapshot.mcpCatalog,
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/config/mcp/reload") {
    invalidateCapabilityCache(runtime);
    const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
    const connected = capabilitySnapshot.mcpCatalog.filter((server) => server.runtimeStatus === "connected").length;
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      connected,
      catalog: capabilitySnapshot.mcpCatalog,
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/mcp/environment-check") {
    const result = await checkPanelMcpEnvironment({
      ...parseMcpEnvironmentRequest(await readJsonBody(request)),
      managedMcpBinDirectory: runtime.productPaths.state.runtimeTools.mcp.bin,
    });
    writeJson(response, 200, {
      ok: result.ok,
      status: result.status,
      command: result.command,
      resolvedCommand: result.resolvedCommand,
      managed: result.managed,
      installable: result.installable,
      message: result.message,
      checkedAt: result.checkedAt,
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/mcp/environment-install") {
    const result = await installPanelMcpEnvironment({
      ...parseMcpEnvironmentRequest(await readJsonBody(request)),
      managedMcpBinDirectory: runtime.productPaths.state.runtimeTools.mcp.bin,
    });
    writeJson(response, 200, {
      ok: result.ok,
      status: result.status,
      command: result.command,
      resolvedCommand: result.resolvedCommand,
      managed: result.managed,
      installable: result.installable,
      message: result.message,
      checkedAt: result.checkedAt,
    });
    return true;
  }

  const mcpServerMatch = /^\/api\/config\/mcp\/([^/]+)$/.exec(url.pathname);
  if (request.method === "POST" && mcpServerMatch !== null) {
    const body = await readJsonBody(request);
    try {
      await runtime.configCenter.upsertMcpServer({
        ...parseMcpServerUpdate(body),
        serverId: decodeURIComponent(mcpServerMatch[1] ?? ""),
      });
      invalidateCapabilityCache(runtime);
      const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        catalog: capabilitySnapshot.mcpCatalog,
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  if (request.method === "DELETE" && mcpServerMatch !== null) {
    try {
      await runtime.configCenter.deleteMcpServer(decodeURIComponent(mcpServerMatch[1] ?? ""));
      invalidateCapabilityCache(runtime);
      const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        catalog: capabilitySnapshot.mcpCatalog,
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  const mcpToolsMatch = /^\/api\/config\/mcp\/([^/]+)\/tools$/.exec(url.pathname);
  if (request.method === "GET" && mcpToolsMatch !== null) {
    const serverId = decodeURIComponent(mcpToolsMatch[1] ?? "");
    const result = await testPanelMcpServer(runtime, serverId, { persistConnectionState: false });
    if (!result.ok) {
      throw new PanelHttpError(502, "mcp_list_tools_failed", result.errorSummary ?? "MCP 工具列表获取失败。");
    }
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      serverId,
      errorCode: result.errorCode,
      toolCount: result.tools.length,
      tools: result.tools,
      catalog: result.catalog,
    });
    return true;
  }

  const mcpReferencesMatch = /^\/api\/config\/mcp\/([^/]+)\/references$/.exec(url.pathname);
  if (request.method === "GET" && mcpReferencesMatch !== null) {
    const serverId = decodeURIComponent(mcpReferencesMatch[1] ?? "");
    const result = await listPanelMcpReferences(runtime, serverId);
    writeJson(response, 200, {
      ok: result.ok,
      status: result.ok ? "completed" : "failed",
      serverId,
      errorCode: result.errorCode,
      errorSummary: result.errorSummary,
      promptCount: result.prompts.length,
      resourceCount: result.resources.length,
      resourceTemplateCount: result.resourceTemplates.length,
      prompts: result.prompts,
      resources: result.resources,
      resourceTemplates: result.resourceTemplates,
    });
    return true;
  }

  const mcpSecretMatch = /^\/api\/config\/mcp\/([^/]+)\/secrets$/.exec(url.pathname);
  if (request.method === "POST" && mcpSecretMatch !== null) {
    const serverId = decodeURIComponent(mcpSecretMatch[1] ?? "");
    const body = await readJsonBody(request);
    try {
      const parsed = parseMcpServerSecretValue(body);
      const secret = await runtime.configCenter.writeMcpServerSecretValue({
        serverId,
        secretRef: parsed.secretRef,
        value: parsed.value,
      });
      invalidateCapabilityCache(runtime);
      const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        serverId,
        secret,
        catalog: capabilitySnapshot.mcpCatalog,
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  const mcpTestMatch = /^\/api\/config\/mcp\/([^/]+)\/test$/.exec(url.pathname);
  if (request.method === "POST" && mcpTestMatch !== null) {
    const serverId = decodeURIComponent(mcpTestMatch[1] ?? "");
    const result = await testPanelMcpServer(runtime, serverId);
    writeJson(response, 200, {
      ok: result.ok,
      status: result.ok ? "completed" : "failed",
      serverId,
      connectedAt: result.connectedAt,
      errorCode: result.errorCode,
      errorSummary: result.errorSummary,
      toolCount: result.tools.length,
      tools: result.tools,
      catalog: result.catalog,
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/command-shell") {
    const body = await readJsonBody(request);
    try {
      const commandShell = await runtime.configCenter.updateCommandShellConfig(parseCommandShellUpdate(body));
      invalidateCapabilityCache(runtime);
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        commandShell,
        capabilities: await runtime.capabilityCenter.snapshot(),
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/config/tool-confirmation") {
    const body = await readJsonBody(request);
    try {
      const toolConfirmation = await runtime.configCenter.updateToolConfirmationConfig(parseToolConfirmationUpdate(body));
      invalidateCapabilityCache(runtime);
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        toolConfirmation,
        capabilities: await runtime.capabilityCenter.snapshot(),
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/config/ordinary-agent") {
    const body = await readJsonBody(request);
    try {
      const ordinaryAgent = await runtime.configCenter.updateOrdinaryAgentPromptConfig(parseOrdinaryAgentPromptUpdate(body));
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        ordinaryAgent,
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/config/skill-trigger") {
    const body = await readJsonBody(request);
    try {
      const skillTrigger = await runtime.configCenter.updateSkillTriggerConfig(parseSkillTriggerUpdate(body));
      invalidateCapabilityCache(runtime);
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        skillTrigger,
        capabilities: await runtime.capabilityCenter.snapshot(),
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  return false;
}

function modelProviderMarketPayload(): {
  readonly presets: ReturnType<typeof listBuiltinModelProviderPresets>;
  readonly providerProtocolProfiles: ReturnType<typeof listBuiltinProviderProtocolProfiles>;
} {
  return {
    presets: listBuiltinModelProviderPresets(),
    providerProtocolProfiles: listBuiltinProviderProtocolProfiles(),
  };
}

function productInfoPayload(runtime: PanelConfigRouteRuntime): {
  readonly name: string;
  readonly version: string;
  readonly defaultEntry: "Synech / Panel";
  readonly runtimeMode: "agent";
  readonly runtimeModeLabel: string;
  readonly configDirectory: string;
  readonly productHome: string;
} {
  return {
    name: PRODUCT_DISPLAY_NAME,
    version: readProductPackageVersion(),
    defaultEntry: "Synech / Panel",
    runtimeMode: "agent",
    runtimeModeLabel: "普通 agent",
    configDirectory: runtime.configDirectory,
    productHome: runtime.productPaths.productHome,
  };
}

async function modelCapabilitiesPayload(runtime: PanelConfigRouteRuntime): Promise<{
  readonly activeModel: SanitizedModelProviderConfig;
  readonly modelCapabilities: ReturnType<typeof resolveModelCapabilities>;
  readonly warnings: readonly string[];
}> {
  const [activeModel, overrides] = await Promise.all([
    runtime.configCenter.getModelProviderConfig(),
    runtime.configCenter.listModelCapabilityOverrides(),
  ]);
  return {
    activeModel,
    modelCapabilities: resolveModelCapabilities({ profile: activeModel, overrides }),
    warnings: modelCapabilityWarnings(activeModel),
  };
}

async function modelCapabilityProfilesPayload(
  runtime: PanelConfigRouteRuntime,
  options: { readonly extraCatalog?: ModelProviderModelCatalog } = {}
): Promise<readonly PanelModelCapabilityProfile[]> {
  const [profiles, savedCatalogs, overrides] = await Promise.all([
    runtime.configCenter.listModelProviderProfiles(),
    runtime.configCenter.listModelProviderModelCatalogs(),
    runtime.configCenter.listModelCapabilityOverrides(),
  ]);
  const catalogsByProfileId = new Map<string, ModelProviderModelCatalog>();
  for (const catalog of savedCatalogs) {
    catalogsByProfileId.set(catalog.profileId, catalog);
  }
  if (options.extraCatalog !== undefined) {
    catalogsByProfileId.set(options.extraCatalog.profileId, options.extraCatalog);
  }

  const projections: PanelModelCapabilityProfile[] = [];
  for (const profile of profiles) {
    for (const model of modelNamesForCapabilityProjection(profile, catalogsByProfileId.get(profile.profileId))) {
      const profileForModel: SanitizedModelProviderConfig = { ...profile, model };
      projections.push({
        profileId: profile.profileId,
        providerKind: profile.providerKind,
        protocolKind: profile.protocolKind,
        model,
        capabilities: resolveModelCapabilities({ profile: profileForModel, overrides }),
      });
    }
  }
  return projections;
}

function modelNamesForCapabilityProjection(
  profile: SanitizedModelProviderConfig,
  catalog: ModelProviderModelCatalog | undefined
): readonly string[] {
  const models = new Set<string>();
  const configuredModel = profile.model?.trim();
  if (configuredModel !== undefined && configuredModel.length > 0) {
    models.add(configuredModel);
  }
  for (const model of catalog?.models ?? []) {
    const id = model.id.trim();
    if (id.length > 0) {
      models.add(id);
    }
  }
  return [...models];
}

function modelCapabilityWarnings(activeModel: SanitizedModelProviderConfig): readonly string[] {
  const warnings: string[] = [];
  if (!activeModel.secretConfigured) {
    warnings.push("当前模型 profile 未配置 API Key。");
  }
  if (activeModel.model === undefined) {
    warnings.push("当前模型 profile 未填写模型名。");
  }
  return warnings;
}

async function readPanelToolCatalog(runtime: PanelConfigRouteRuntime): Promise<ToolCatalogSnapshot> {
  return runtime.capabilityCenter.toolCatalog();
}

function configCenterHttpError(error: unknown): PanelHttpError {
  if (error instanceof PanelHttpError) {
    return error;
  }
  if (error instanceof ConfigCenterValidationError) {
    return new PanelHttpError(400, "invalid_config", error.message);
  }
  throw error;
}

function invalidateCapabilityCache(runtime: PanelConfigRouteRuntime): void {
  runtime.capabilityCenter.invalidate();
}
