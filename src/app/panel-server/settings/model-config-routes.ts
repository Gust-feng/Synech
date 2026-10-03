import type { IncomingMessage, ServerResponse } from "node:http";

import {
  getPiModelCatalogGeneratedAt,
  listPiProviderCatalog,
} from "../../../adapters/intelligence/index.js";
import { fetchPanelModelCatalog } from "./model-provider-adapter.js";
import { handlePanelModelAuthRoute } from "./model-auth-routes.js";
import { ModelRuntimeConfigurationError } from "../../model-runtime/model-runtime-config.js";
import { PanelHttpError, readJsonBody, writeJson } from "../http-utils.js";
import {
  parseConfigUpdate,
  parseCreateModelProfile,
  parseModelCatalogUpdate,
  parseModelConfigurationUpdate,
  parseModelProviderOrderUpdate,
} from "../request-parsers.js";
import {
  configCenterHttpError,
  invalidateCapabilityCache,
  modelCapabilitiesPayload,
  modelCapabilityProfilesPayload,
  modelProviderMarketPayload,
  type PanelConfigRouteRuntime,
} from "./config-route-payloads.js";

const MODEL_PROVIDER_CONFIG_BODY_MAX_CHARS = 4_500_000;

export async function handlePanelModelConfigRoute(
  runtime: PanelConfigRouteRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (await handlePanelModelAuthRoute(runtime.modelProviderAuth, request, response, url)) return true;
  if (request.method === "GET" && url.pathname === "/api/config/pi-model-providers") {
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      generatedAt: getPiModelCatalogGeneratedAt(),
      providers: listPiProviderCatalog(),
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
      ...modelProviderMarketPayload(),
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
    const input = parseModelProviderOrderUpdate(await readJsonBody(request));
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
      const profile = await runtime.configCenter.updateModelProviderConfig({
        ...parseConfigUpdate(body),
        profileId: decodeURIComponent(modelProfileMatch[1] ?? ""),
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

  const modelSettingsMatch = /^\/api\/config\/model-profiles\/([^/]+)\/model-settings$/.exec(url.pathname);
  if (request.method === "POST" && modelSettingsMatch !== null) {
    const body = await readJsonBody(request);
    try {
      const profile = await runtime.configCenter.updateModelConfiguration({
        ...parseModelConfigurationUpdate(body),
        profileId: decodeURIComponent(modelSettingsMatch[1] ?? ""),
      });
      invalidateCapabilityCache(runtime);
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        profile,
        config: await runtime.configCenter.getModelProviderConfig(),
        profiles: await runtime.configCenter.listModelProviderProfiles(),
        modelCatalogs: await runtime.configCenter.listModelProviderModelCatalogs(),
        modelCapabilityProfiles: await modelCapabilityProfilesPayload(runtime),
        capabilities: await runtime.capabilityCenter.snapshot(),
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  const modelProfileModelsMatch = /^\/api\/config\/model-profiles\/([^/]+)\/models$/.exec(url.pathname);
  if (request.method === "GET" && modelProfileModelsMatch !== null) {
    const controller = new AbortController();
    const abortDiscovery = () => {
      if (!response.writableEnded) controller.abort();
    };
    request.once("aborted", abortDiscovery);
    response.once("close", abortDiscovery);
    try {
      const profileId = decodeURIComponent(modelProfileModelsMatch[1] ?? "");
      const profile = (await runtime.configCenter.listModelProviderProfiles())
        .find((item) => item.profileId === profileId);
      if (profile === undefined) {
        throw new PanelHttpError(404, "model_profile_not_found", "未找到模型配置。");
      }
      const apiKey = await runtime.configCenter.getModelProviderApiKey(profile.profileId);
      if (apiKey === undefined && profile.protocolKind !== "native") {
        throw new PanelHttpError(400, "missing_model_provider_key", "获取模型列表前需要先保存该厂商的 API Key。");
      }
      const catalog = await fetchPanelModelCatalog({
        configCenter: runtime.configCenter, profile, apiKey, fetch: runtime.modelCatalogFetch,
        abortSignal: controller.signal,
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
      if (error instanceof PanelHttpError) throw error;
      if (error instanceof ModelRuntimeConfigurationError) {
        throw new PanelHttpError(400, "missing_model_provider_auth", "该模型服务尚未完成身份验证。");
      }
      const failure = new PanelHttpError(502, "model_catalog_failed", "模型列表获取失败，请检查服务连接、身份验证和网络。");
      failure.cause = error;
      throw failure;
    } finally {
      request.removeListener("aborted", abortDiscovery);
      response.removeListener("close", abortDiscovery);
    }
  }

  const modelProfileCatalogMatch = /^\/api\/config\/model-profiles\/([^/]+)\/model-catalog$/.exec(url.pathname);
  if (request.method === "POST" && modelProfileCatalogMatch !== null) {
    const body = await readJsonBody(request);
    try {
      const profileId = decodeURIComponent(modelProfileCatalogMatch[1] ?? "");
      const profile = (await runtime.configCenter.listModelProviderProfiles())
        .find((item) => item.profileId === profileId);
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
    writeJson(response, 200, { ok: true, status: "completed", profileId, apiKey });
    return true;
  }

  const activateProfileMatch = /^\/api\/config\/model-profiles\/([^/]+)\/activate$/.exec(url.pathname);
  if (request.method === "POST" && activateProfileMatch !== null) {
    try {
      const profile = await runtime.configCenter.activateModelProviderProfile(
        decodeURIComponent(activateProfileMatch[1] ?? ""),
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
      const profiles = await runtime.modelProviderAuth.deleteProfile(
        decodeURIComponent(deleteProfileMatch[1] ?? ""),
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

  return false;
}
