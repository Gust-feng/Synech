import { hasApi, type Api, type Model } from "@earendil-works/pi-ai";
import type { ModelVisibleToolDefinitionSerialization } from "../../app/model-runtime/tool-definition-visibility-cost.js";

/** Freeze only the cost format actually served by this Pi model, not the connection mode. */
export function modelToolDefinitionSerialization(model: Model<Api>): ModelVisibleToolDefinitionSerialization | undefined {
  if (hasApi(model, "openai-completions")) {
    return { api: "openai-completions", includeStrict: model.compat?.supportsStrictMode !== false };
  }
  if (hasApi(model, "openai-responses")) return { api: "openai-responses", includeStrict: true };
  if (hasApi(model, "anthropic-messages")) {
    return {
      api: "anthropic-messages",
      includeStrict: false,
      anthropicEagerInput: model.compat?.supportsEagerToolInputStreaming ?? true,
    };
  }
  return undefined;
}
