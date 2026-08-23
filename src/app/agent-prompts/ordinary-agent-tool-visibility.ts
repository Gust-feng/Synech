import type { AgentToolVisibilityProfile } from "./contracts.js";
import { ORDINARY_AGENT_TOOL_VISIBILITY_PROFILE_ID } from "./ordinary-agent-identity.js";

export const ORDINARY_AGENT_TOOL_VISIBILITY: AgentToolVisibilityProfile = {
  profileId: ORDINARY_AGENT_TOOL_VISIBILITY_PROFILE_ID,
  runMode: "agent",
  visibleToolScopes: ["agent-basic", "workspace", "mcp", "research"],
};
