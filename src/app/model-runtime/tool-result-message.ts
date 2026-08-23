import type { ModelMessage } from "../../domain/intelligence/index.js";
import type { ToolCallResult } from "../../domain/tools/index.js";
import { toolResultMessage } from "../../kernel/intelligence/tool-use-loop-messages.js";

/**
 * Canonical model-facing projection for one factual tool result.
 *
 * The complete request input remains on the durable ToolCallResult and its
 * requested event. Repeating it in the tool message can make a small result
 * arbitrarily large without adding any information the model did not already
 * provide in the preceding assistant tool call.
 */
export function canonicalToolResultMessage(result: ToolCallResult): ModelMessage {
  return toolResultMessage(result);
}
