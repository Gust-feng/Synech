import {
  listBuiltinModelProviderPresets,
  listBuiltinProviderProtocolProfiles,
  type ModelProviderModelCatalog,
  type SanitizedModelProviderConfig,
} from "../../../domain/config/index.js";
import type { ModelCapabilityProfile, ProductInfo } from "../../panel-api/config.js";
import type { ToolsResponse } from "../../panel-api/tools.js";
import { readProductPackageVersion } from "../../../platform/product-version.js";
import { PRODUCT_DISPLAY_NAME } from "../../../platform/product-identity.js";
import type { ProductPaths } from "../../../platform/storage/index.js";
import { CapabilityCenter } from "../../capability/capability-center.js";
import { ConfigCenter, ConfigCenterValidationError } from "../../config-center/index.js";
import { resolveModelCapabilities } from "../../model-runtime/model-capability-registry.js";
import type { ToolCatalogSnapshot } from "../../tool-center/index.js";
import { PanelHttpError } from "../http-utils.js";
import type { PanelModelCatalogFetch } from "../types.js";

export type PanelConfigRouteRuntime = {
  readonly configCenter: ConfigCenter;
  readonly capabilityCenter: CapabilityCenter;
  readonly managedMcpBinDirectory: string;
  readonly configDirectory: string;
  readonly productPaths: ProductPaths;
  readonly modelCatalogFetch?: PanelModelCatalogFetch;
};

export type PanelToolsConfig = NonNullable<ToolsResponse["tools"]>;

export function modelProviderMarketPayload(): {
  readonly presets: ReturnType<typeof listBuiltinModelProviderPresets>;
  readonly providerProtocolProfiles: ReturnType<typeof listBuiltinProviderProtocolProfiles>;
} {
  return {
    presets: listBuiltinModelProviderPresets(),
    providerProtocolProfiles: listBuiltinProviderProtocolProfiles(),
  };
}

export function productInfoPayload(runtime: PanelConfigRouteRuntime): ProductInfo {
  return {
    name: PRODUCT_DISPLAY_NAME,
    version: readProductPackageVersion(),
    defaultEntry: "Workbench",
    configDirectory: runtime.configDirectory,
    productHome: runtime.productPaths.productHome,
  };
}

export async function modelCapabilitiesPayload(runtime: PanelConfigRouteRuntime): Promise<{
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

export async function modelCapabilityProfilesPayload(
  runtime: PanelConfigRouteRuntime,
  options: { readonly extraCatalog?: ModelProviderModelCatalog } = {},
): Promise<readonly ModelCapabilityProfile[]> {
  const [profiles, savedCatalogs, overrides] = await Promise.all([
    runtime.configCenter.listModelProviderProfiles(),
    runtime.configCenter.listModelProviderModelCatalogs(),
    runtime.configCenter.listModelCapabilityOverrides(),
  ]);
  const catalogsByProfileId = new Map<string, ModelProviderModelCatalog>();
  for (const catalog of savedCatalogs) catalogsByProfileId.set(catalog.profileId, catalog);
  if (options.extraCatalog !== undefined) {
    catalogsByProfileId.set(options.extraCatalog.profileId, options.extraCatalog);
  }
  const projections: ModelCapabilityProfile[] = [];
  for (const profile of profiles) {
    for (const model of modelNamesForCapabilityProjection(profile, catalogsByProfileId.get(profile.profileId))) {
      projections.push({
        profileId: profile.profileId,
        providerKind: profile.providerKind,
        protocolKind: profile.protocolKind,
        model,
        capabilities: resolveModelCapabilities({ profile: { ...profile, model }, overrides }),
      });
    }
  }
  return projections;
}

export async function readPanelToolCatalog(runtime: PanelConfigRouteRuntime): Promise<ToolCatalogSnapshot> {
  return runtime.capabilityCenter.toolCatalog();
}

export function invalidateCapabilityCache(runtime: PanelConfigRouteRuntime): void {
  runtime.capabilityCenter.invalidate();
}

export function configCenterHttpError(error: unknown): PanelHttpError {
  if (error instanceof PanelHttpError) return error;
  if (error instanceof ConfigCenterValidationError) {
    return new PanelHttpError(400, "invalid_config", error.message);
  }
  throw error;
}

function modelNamesForCapabilityProjection(
  profile: SanitizedModelProviderConfig,
  catalog: ModelProviderModelCatalog | undefined,
): readonly string[] {
  const models = new Set<string>();
  const configuredModel = profile.model?.trim();
  if (configuredModel !== undefined && configuredModel.length > 0) models.add(configuredModel);
  for (const model of catalog?.models ?? []) {
    const id = model.id.trim();
    if (id.length > 0) models.add(id);
  }
  return [...models];
}

function modelCapabilityWarnings(activeModel: SanitizedModelProviderConfig): readonly string[] {
  const warnings: string[] = [];
  if (!activeModel.secretConfigured) warnings.push("当前模型 profile 未配置 API Key。");
  if (activeModel.model === undefined) warnings.push("当前模型 profile 未填写模型名。");
  return warnings;
}
