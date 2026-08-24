import type { IncomingMessage, ServerResponse } from "node:http";

import {
  listBuiltinModelProviderPresets,
  listBuiltinProviderProtocolProfiles,
} from "../../../domain/config/index.js";
import { fetchPanelModelCatalog } from "./model-provider-adapter.js";
import { PanelHttpError, readJsonBody, writeJson } from "../http-utils.js";
import {
  parseConfigUpdate,
  parseCreateModelProfile,
  parseModelCapabilityUpdate,
  parseModelCatalogUpdate,
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

  const modelProfileModelsMatch = /^\/api\/config\/model-profiles\/([^/]+)\/models$/.exec(url.pathname);
  if (request.method === "GET" && modelProfileModelsMatch !== null) {
    try {
      const profileId = decodeURIComponent(modelProfileModelsMatch[1] ?? "");
      const profile = (await runtime.configCenter.listModelProviderProfiles())
        .find((item) => item.profileId === profileId);
      if (profile === undefined) {
        throw new PanelHttpError(404, "model_profile_not_found", "未找到模型配置。");
      }
      const apiKey = await runtime.configCenter.getModelProviderApiKey(profile.profileId);
      if (apiKey === undefined) {
        throw new PanelHttpError(400, "missing_model_provider_key", "获取模型列表前需要先保存该厂商的 API Key。");
      }
      const catalog = await fetchPanelModelCatalog({ profile, apiKey, fetch: runtime.modelCatalogFetch });
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
      throw new PanelHttpError(502, "model_catalog_failed", "模型列表获取失败，请检查厂商地址、密钥和网络。");
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
      const profiles = await runtime.configCenter.deleteModelProviderProfile(
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

  if (request.method === "POST" && url.pathname === "/api/config/model-capabilities") {
    const input = parseModelCapabilityUpdate(await readJsonBody(request));
    const activeProfile = await runtime.configCenter.getModelProviderConfig();
    const targetProfile = input.profileId === undefined
      ? activeProfile
      : (await runtime.configCenter.listModelProviderProfiles())
        .find((profile) => profile.profileId === input.profileId);
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

  return false;
}
