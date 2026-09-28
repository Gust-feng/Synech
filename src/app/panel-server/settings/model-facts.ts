import type {
  ModelCapabilityOverrideSettings,
  ModelFacts,
  ResolvedModelCapabilities,
  SanitizedModelProviderConfig,
} from "../../../domain/config/index.js";
import { resolveDiscoveredModelFacts } from "../../../adapters/intelligence/index.js";
import { resolveModelCapabilities } from "../../model-runtime/model-capability-registry.js";

/**
 * Host-owned composition of the two model fact layers.
 *
 * - `resolveModelFactsForProfile`：按连接上显式的 `piProviderId` 在 pi-ai 真实
 *   catalog 中精确匹配 modelId（adapter 持有 pi 类型的唯一位置）；
 * - `resolveModelCapabilitiesForProfile`：在其上合并用户显式覆写，产出产品层
 *   二态投影（Pi 已知事实 / 未确认）。
 *
 * `app/model-runtime` 与 `app/capability` 按架构基线不得依赖 adapter，因此这
 * 份组合只有 Host（panel-server）装配，再由注入点送到能力解析消费者。
 */

export type ModelCapabilityResolvableProfile = Pick<
  SanitizedModelProviderConfig,
  "profileId" | "providerKind" | "model" | "piProviderId"
>;

export function resolveModelFactsForProfile(profile: ModelCapabilityResolvableProfile): ModelFacts {
  return resolveDiscoveredModelFacts({
    piProviderId: profile.piProviderId,
    modelId: profile.model,
  });
}

export function resolveModelCapabilitiesForProfile(input: {
  readonly profile: ModelCapabilityResolvableProfile;
  readonly overrides?: readonly ModelCapabilityOverrideSettings[];
}): ResolvedModelCapabilities {
  return resolveModelCapabilities({
    profile: input.profile,
    facts: resolveModelFactsForProfile(input.profile),
    ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
  });
}
