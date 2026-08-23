import type { ToolExecutor } from "../../domain/tools/index.js";
import type { AgentToolRegistryContribution } from "../tool-center/factory.js";

export type McpToolExecutorProvider = {
  getToolsForRegistry(): readonly ToolExecutor[];
  getDiscoveredToolsForRegistry?(): readonly ToolExecutor[];
  disconnectAll?(): Promise<void>;
};

export function createMcpToolRegistryContribution(
  provider: McpToolExecutorProvider,
  options: { readonly useDiscoveredTools?: boolean } = {},
): AgentToolRegistryContribution {
  return (register) => {
    const executors = options.useDiscoveredTools === true
      ? (provider.getDiscoveredToolsForRegistry?.() ?? provider.getToolsForRegistry())
      : provider.getToolsForRegistry();
    for (const executor of executors) {
      register({ executor, scopes: ["mcp"], enabledByDefault: true });
    }
  };
}
