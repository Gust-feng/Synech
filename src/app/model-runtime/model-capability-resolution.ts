import type {
  ModelCapabilityOverrideSettings,
  ModelFacts,
  ResolvedModelCapabilities,
  SanitizedModelProviderConfig,
} from "../../domain/config/index.js";

/**
 * 运行期能力解析收口。
 *
 * `facts` 是唯一的模型事实来源：`confirmed` 时每个字段都是真实 Pi Model 的运行
 * 事实投影（由 adapter 按连接显式 piProviderId 在 pi 真实 catalog 精确匹配产出），
 * `unconfirmed` 时没有任何事实。本模块只合并用户显式覆写——不引入 Synech 自维护
 * 的能力表，不做 model id 模糊匹配，也不为未确认模型编造任何基线值。
 */
export function resolveModelCapabilities(input: {
  readonly profile: Pick<SanitizedModelProviderConfig, "profileId" | "providerKind" | "model">;
  readonly facts: ModelFacts;
  readonly overrides?: readonly ModelCapabilityOverrideSettings[];
}): ResolvedModelCapabilities {
  const override = bestOverrideFor(input.profile, input.overrides);
  return override === undefined ? { facts: input.facts } : { facts: input.facts, override: override.capabilities };
}

function bestOverrideFor(
  profile: Pick<SanitizedModelProviderConfig, "profileId" | "providerKind" | "model">,
  overrides: readonly ModelCapabilityOverrideSettings[] | undefined,
): ModelCapabilityOverrideSettings | undefined {
  if (overrides === undefined || profile.model === undefined) return undefined;
  const model = profile.model.toLowerCase();
  const matchingModel = overrides.filter((item) => item.model.toLowerCase() === model);
  const profileSpecific = matchingModel.find((item) =>
    item.profileId === profile.profileId &&
    (item.providerKind === undefined || item.providerKind === profile.providerKind));
  const providerScoped = matchingModel.find((item) =>
    item.profileId === undefined &&
    (item.providerKind === undefined || item.providerKind === profile.providerKind));
  if (profileSpecific === undefined || providerScoped === undefined) {
    return profileSpecific ?? providerScoped;
  }
  return {
    ...providerScoped,
    ...profileSpecific,
    capabilities: mergePartialCapabilities(providerScoped.capabilities, profileSpecific.capabilities),
  };
}

function mergePartialCapabilities(
  ...capabilities: readonly Record<string, unknown>[]
): Record<string, unknown> {
  return Object.assign(
    {},
    ...capabilities.map((item) =>
      Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined))),
  );
}
