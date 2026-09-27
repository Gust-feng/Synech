import type { OpenAIModelRequestSettings } from "../../domain/config/index.js";
import type { ToolDefinition } from "../../domain/tools/index.js";

/**
 * OpenAI 兼容请求设置里与并行工具调用相关的那一部分推导。
 *
 * 历史上这里还有 stream / max_output_tokens 等 control-field 组装函数，但 payload
 * 的实际组装由 `model-provider-binding.ts` 的 provider payload transformer 拥有
 * （那里按 completions / responses 两种 API 分别落字段），那些函数零调用方，已删除。
 */
export function configuredOpenAIParallelToolCalls(
  tools: readonly ToolDefinition[] | undefined,
  settings: OpenAIModelRequestSettings | undefined,
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
  return settings?.parallelToolCalls;
}
