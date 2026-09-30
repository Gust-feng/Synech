import type { AgentHarnessTool, AgentTool, Context } from "@earendil-works/pi-agent-core";

/**
 * Bridges a Synech `AgentTool` into the pi harness tool shape.
 *
 * Synech tools execute against an `AbortSignal` and a progress callback; the
 * harness supplies cancellation through `Context` and passes two extra
 * provider-only arguments (`toolContext`, `invocation`). Keeping the
 * translation here means product tools never adopt the provider signature,
 * and the next provider signature change stays inside the adapter.
 */
export function toHarnessTool(
  tool: AgentTool,
  fallbackAbortSignal: AbortSignal | undefined,
): AgentHarnessTool<undefined> {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
    async execute(toolCallId, params, onUpdate, _toolContext, _invocation, context) {
      return tool.execute(toolCallId, params, context.abortSignal ?? fallbackAbortSignal, onUpdate);
    },
  };
}
