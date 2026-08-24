import { getJson } from "../api";
import type { AppState } from "../workbench/state";
import type { ConfigResponse } from "../../../panel-api/config";
import type { ConversationSummary } from "../contracts/conversation";
import type { SkillDefinition } from "../contracts/skills";
import type { SubAgentDefinition } from "../contracts/sub-agents";
import type { McpServerCatalogItem, ToolsResponse } from "../../../panel-api/tools";

export type AppBootstrapState = Pick<
  AppState,
  "config" | "tools" | "skills" | "subAgents" | "conversations"
>;

export async function loadAppBootstrap(signal?: AbortSignal): Promise<AppBootstrapState> {
  const [config, tools, mcp, skills, subAgents, conversations] = await Promise.all([
    getJson<ConfigResponse>("/api/config", { signal }),
    getJson<ToolsResponse>("/api/config/tools", { signal }),
    getJson<{ readonly catalog?: readonly McpServerCatalogItem[] }>("/api/config/mcp", { signal }),
    getJson<{ readonly skills: readonly SkillDefinition[] }>("/api/skills", { signal }),
    getJson<{ readonly subAgents: readonly SubAgentDefinition[] }>("/api/config/sub-agents", { signal }),
    getJson<{ readonly conversations: readonly ConversationSummary[] }>("/api/conversations", { signal }),
  ]);
  return {
    config,
    tools: { ...tools, mcpCatalog: mcp.catalog ?? [] },
    skills: skills.skills ?? [],
    subAgents: subAgents.subAgents ?? [],
    conversations: conversations.conversations ?? [],
  };
}

export function applyAppBootstrap(previous: AppState, bootstrap: AppBootstrapState): AppState {
  return {
    ...previous,
    ...bootstrap,
  };
}
