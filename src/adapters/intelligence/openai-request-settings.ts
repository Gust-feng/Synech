import type { ToolDefinition } from "../../domain/tools/index.js";

/**
 * OpenAI-compatible tool calls may run in parallel only for a read-only batch.
 *
 * Pi deliberately leaves `parallel_tool_calls` to the caller; Synech must send
 * it because otherwise a provider may parallelize a batch that contains a write.
 * This is a product safety decision, not a user-selectable provider field.
 */
export function safeParallelToolCalls(
  tools: readonly ToolDefinition[] | undefined,
  options: {
    readonly includeWithoutTools?: boolean;
  } = {}
): boolean | undefined {
  if ((tools === undefined || tools.length === 0) && options.includeWithoutTools !== true) {
    return undefined;
  }
  if (tools !== undefined && tools.length > 0 && tools.some((tool) => tool.metadata?.operationType !== "read-only")) {
    return false;
  }
  return true;
}

/**
 * Preserve an explicit connection preference while still preventing write
 * tools from being sent as a parallel batch.
 */
export function configuredOpenAIParallelToolCalls(
  tools: readonly ToolDefinition[] | undefined,
  settings: { readonly parallelToolCalls?: boolean } | undefined,
  options: { readonly includeWithoutTools?: boolean } = {},
): boolean | undefined {
  const safe = safeParallelToolCalls(tools, options);
  if (safe === false) return false;
  if (safe === undefined) return undefined;
  return settings?.parallelToolCalls ?? safe;
}
