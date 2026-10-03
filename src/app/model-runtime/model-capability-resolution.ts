import type {
  ModelFacts,
  ResolvedModelCapabilities,
  SanitizedModelProviderConfig,
} from "../../domain/config/index.js";
import { modelConfigurationForId } from "../../domain/config/index.js";

/** Apply connection-local user settings without relabeling them as Pi facts. */
export function resolveModelCapabilities(input: {
  readonly profile: Pick<SanitizedModelProviderConfig, "profileId" | "providerKind" | "model"> &
    Partial<Pick<SanitizedModelProviderConfig, "modelSettings" | "protocolKind">>;
  readonly facts: ModelFacts;
}): ResolvedModelCapabilities {
  const configuration = modelConfigurationForId(input.profile.modelSettings, input.profile.model);
  return {
    facts: input.facts,
    ...(configuration === undefined ? {} : { configuration }),
    ...(input.profile.protocolKind === undefined ? {} : { transport: input.profile.protocolKind }),
  };
}
