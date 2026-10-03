import type { ModelFacts, ResolvedModelCapabilities, SanitizedModelProviderConfig } from "../../../domain/config/index.js";
import { modelFactsFromPiModel } from "../../../adapters/intelligence/pi-model-facts.js";
import { resolveConfiguredModel } from "../../../adapters/intelligence/model-catalog-binding.js";
import { resolveModelCapabilities } from "../../model-runtime/model-capability-registry.js";

/**
 * Host-owned composition of the two model fact layers.
 *
 * - `resolveModelFactsForProfile`：按连接上显式的 `piProviderId` 在 pi-ai 真实
 *   catalog 中精确匹配 modelId（adapter 持有 pi 类型的唯一位置）；
 * - `resolveModelCapabilitiesForProfile`：将 adapter 产出的二态事实交给产品层，
 *   不再叠加第二套能力来源。
 *
 * `app/model-runtime` 与 `app/capability` 按架构基线不得依赖 adapter，因此这
 * 份组合只有 Host（panel-server）装配，再由注入点送到能力解析消费者。
 */

export type ModelCapabilityResolvableProfile = Pick<
  SanitizedModelProviderConfig,
  "profileId" | "providerKind" | "model" | "piProviderId"
> & Partial<Pick<SanitizedModelProviderConfig, "baseUrl" | "connection" | "secretUpdatedAt" | "protocolKind" | "modelSettings">>;

export function resolveModelFactsForProfile(profile: ModelCapabilityResolvableProfile): ModelFacts {
  const resolution = resolveConfiguredModel({
    piProviderId: profile.piProviderId,
    modelId: profile.model,
    profileId: profile.profileId,
    baseUrl: profile.baseUrl,
    connection: profile.connection,
    secretUpdatedAt: profile.secretUpdatedAt,
    protocolKind: profile.protocolKind,
  });
  return resolution.status === "known"
    ? modelFactsFromPiModel(resolution)
    : { status: "unconfirmed", modelId: resolution.modelId };
}

export function resolveModelCapabilitiesForProfile(input: {
  readonly profile: ModelCapabilityResolvableProfile;
}): ResolvedModelCapabilities {
  return resolveModelCapabilities({
    profile: input.profile,
    facts: resolveModelFactsForProfile(input.profile),
  });
}
