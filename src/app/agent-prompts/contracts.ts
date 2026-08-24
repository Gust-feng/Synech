import type { CapabilityToolCatalogItem, CapabilityToolScope } from "../../domain/config/index.js";
import type {
  ModelOutputContract,
  ModelRequest,
  OrdinaryModelPurpose,
} from "../../domain/intelligence/index.js";

export type AgentSystemPromptSpec = {
  readonly promptRef: string;
  readonly version: string;
  readonly systemPrompt: string;
};

export type AgentToolVisibilityProfile = {
  readonly profileId: string;
  readonly visibleToolScopes?: readonly CapabilityToolScope[];
  readonly hiddenToolScopes?: readonly CapabilityToolScope[];
  readonly hiddenToolNames?: readonly string[];
};

export type AgentTurnPolicySpec = {
  readonly allowModel: boolean;
  readonly fallback: "deterministic" | "disabled";
  readonly purpose: OrdinaryModelPurpose;
  readonly sensitivity: ModelRequest["sensitivity"];
  readonly defaultMaxOutputTokens: number;
  readonly maxModelRounds?: number;
  readonly maxToolRounds?: number;
};

export type AgentDefinition = {
  readonly agentId: string;
  readonly displayName: string;
  readonly prompt: AgentSystemPromptSpec;
  readonly turnPolicy: AgentTurnPolicySpec;
  readonly outputContract: ModelOutputContract;
  readonly toolVisibilityProfile: AgentToolVisibilityProfile;
};

export function isToolVisibleToAgentProfile(
  profile: AgentToolVisibilityProfile,
  tool: Pick<CapabilityToolCatalogItem, "name" | "scopes">
): boolean {
  if (profile.hiddenToolNames?.includes(tool.name) === true) {
    return false;
  }
  if (
    profile.visibleToolScopes !== undefined &&
    profile.visibleToolScopes.length > 0 &&
    !tool.scopes.some((scope) => profile.visibleToolScopes?.includes(scope))
  ) {
    return false;
  }
  if (profile.hiddenToolScopes?.some((scope) => tool.scopes.includes(scope)) === true) {
    return false;
  }
  return true;
}

export function filterToolsVisibleToAgentProfile(
  profile: AgentToolVisibilityProfile,
  tools: readonly Pick<CapabilityToolCatalogItem, "name" | "scopes">[]
): readonly Pick<CapabilityToolCatalogItem, "name" | "scopes">[] {
  return tools.filter((tool) => isToolVisibleToAgentProfile(profile, tool));
}
