import type {
  ModelFacts,
  ResolvedModelCapabilities,
  SanitizedModelProviderConfig,
} from "../../domain/config/index.js";

/**
 * 运行期能力解析收口。
 *
 * `facts` 是唯一的模型事实来源：`confirmed` 时每个字段都是真实 Pi Model 的运行
 * 事实投影（由 adapter 按连接显式 piProviderId 在 pi 真实 catalog 精确匹配产出），
 * `unconfirmed` 时没有任何事实。这里**没有**用户覆写层：再引入一层「用户可声明
 * 模型能力」就会在同一模型上形成第二个事实源。
 */
export function resolveModelCapabilities(input: {
  readonly profile: Pick<SanitizedModelProviderConfig, "profileId" | "providerKind" | "model">;
  readonly facts: ModelFacts;
}): ResolvedModelCapabilities {
  return { facts: input.facts };
}
