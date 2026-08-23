import type { AgentTurnPolicySpec } from "./contracts.js";

export const ORDINARY_AGENT_DEFAULT_MAX_OUTPUT_TOKENS = 3200;

export const ORDINARY_AGENT_TURN_POLICY: AgentTurnPolicySpec = {
  allowModel: true,
  fallback: "disabled",
  purpose: "ordinary_agent",
  sensitivity: "internal",
  defaultMaxOutputTokens: ORDINARY_AGENT_DEFAULT_MAX_OUTPUT_TOKENS,
};
