import type {
  ConfiguredModelProviderKind,
  ModelCapabilities,
} from "../../domain/config/index.js";
import type { ConfigCenter } from "../config-center/index.js";
import { CONTEXT_WINDOW_FALLBACK_TOKENS } from "./model-capability-registry.js";

export type ModelContextWindowExceededEvent = {
  readonly profileId?: string;
  readonly providerKind: ConfiguredModelProviderKind;
  readonly model?: string;
  readonly message: string;
};

export async function persistContextWindowFallback(input: {
  readonly configCenter: Pick<ConfigCenter, "listModelCapabilityOverrides" | "updateModelCapabilityOverride">;
  readonly event: ModelContextWindowExceededEvent;
}): Promise<void> {
  const model = input.event.model?.trim();
  const profileId = input.event.profileId?.trim();
  if (model === undefined || model.length === 0 || profileId === undefined || profileId.length === 0) {
    return;
  }
  const overrides = await input.configCenter.listModelCapabilityOverrides();
  const existing = overrides.find((override) =>
    override.profileId === profileId &&
    override.providerKind === input.event.providerKind &&
    override.model.toLowerCase() === model.toLowerCase()
  );
  const contextWindowTokens = fallbackContextWindow(existing?.capabilities.contextWindowTokens);
  if (existing?.capabilities.contextWindowTokens === contextWindowTokens) {
    return;
  }
  await input.configCenter.updateModelCapabilityOverride({
    profileId,
    providerKind: input.event.providerKind,
    model,
    capabilities: {
      ...existing?.capabilities,
      contextWindowTokens,
    },
  });
}

function fallbackContextWindow(current: ModelCapabilities["contextWindowTokens"] | undefined): number {
  return current === undefined
    ? CONTEXT_WINDOW_FALLBACK_TOKENS
    : Math.min(current, CONTEXT_WINDOW_FALLBACK_TOKENS);
}
