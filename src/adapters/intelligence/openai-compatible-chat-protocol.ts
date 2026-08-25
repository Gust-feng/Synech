import type {
  ModelReasoningControlKind,
  OpenAIModelRequestSettings,
  OpenAIReasoningEffort,
  ProviderProtocolProfileId,
} from "../../domain/config/index.js";
import { asRecord, isPlainRecord } from "./provider-value-utils.js";

export type OpenAICompatibleChatDialect = {
  readonly profileId: ProviderProtocolProfileId;
  readonly reasoningControl: ModelReasoningControlKind;
};

export function resolveOpenAICompatibleChatDialect(input: {
  readonly providerProfileId?: ProviderProtocolProfileId;
  readonly baseUrl: string;
  readonly model: string;
}): OpenAICompatibleChatDialect {
  const profileId = input.providerProfileId ?? inferProviderProfileId(input.baseUrl);
  switch (profileId) {
    case "openai":
      return {
        profileId,
        reasoningControl: "openai_chat_reasoning_effort",
      };
    case "deepseek":
      return {
        profileId,
        reasoningControl: "deepseek_reasoning_effort",
      };
    case "moonshot":
      if (isKimiK3Model(input.model)) {
        return {
          profileId,
          reasoningControl: "kimi_k3_reasoning_effort",
        };
      }
      return {
        profileId,
        reasoningControl: "thinking_enabled_disabled",
      };
    case "glm":
      if (isModernGLMThinkingModel(input.model)) {
        return {
          profileId,
          reasoningControl: "thinking_enabled_disabled",
        };
      }
      return {
        profileId,
        reasoningControl: "thinking_disabled",
      };
    case "minimax":
      return {
        profileId,
        reasoningControl: "reasoning_split",
      };
    default:
      return {
        profileId: "openai_compatible",
        reasoningControl: "none",
      };
  }
}

export function applyOpenAICompatibleChatRequestPolicy(input: {
  readonly fields: Record<string, unknown>;
  readonly dialect: OpenAICompatibleChatDialect;
}): Record<string, unknown> {
  const next = { ...input.fields };
  if (input.dialect.profileId === "moonshot") {
    delete next.temperature;
    delete next.top_p;
  }
  if (input.dialect.profileId === "deepseek" && requestHasThinkingEnabled(next)) {
    delete next.temperature;
    delete next.top_p;
  }
  if (
    (input.dialect.profileId === "deepseek" || input.dialect.profileId === "moonshot") &&
    requestHasThinkingEnabled(next) &&
    isPlainRecord(next.tool_choice)
  ) {
    next.tool_choice = "auto";
  }
  return next;
}

export function applyOpenAICompatibleChatDialectControls(input: {
  readonly fields: Record<string, unknown>;
  readonly dialect: OpenAICompatibleChatDialect;
  readonly settings?: OpenAIModelRequestSettings;
}): Record<string, unknown> {
  const next = { ...input.fields };
  const effort = openAIReasoningEffortOrUndefined(next.reasoning_effort);
  delete next.reasoning_effort;

  switch (input.dialect.reasoningControl) {
    case "openai_chat_reasoning_effort":
      if (effort !== undefined && effort !== "none") {
        next.reasoning_effort = effort;
      }
      return next;
    case "deepseek_reasoning_effort":
      return applyDeepSeekReasoningControls(next, effort);
    case "kimi_k3_reasoning_effort":
      return { ...next, reasoning_effort: "max" };
    case "thinking_enabled_disabled":
      return applyThinkingEnabledControls(next, input.dialect, effort);
    case "thinking_disabled":
      return {
        ...next,
        thinking: { type: "disabled" },
      };
    case "reasoning_split":
      return {
        ...next,
        reasoning_split: true,
      };
    default:
      return next;
  }
}

function applyDeepSeekReasoningControls(
  fields: Record<string, unknown>,
  effort: OpenAIReasoningEffort | undefined
): Record<string, unknown> {
  if (effort === "none") {
    return {
      ...fields,
      thinking: { type: "disabled" },
    };
  }
  if (effort === undefined) {
    return fields;
  }
  return {
    ...fields,
    thinking: { type: "enabled" },
    reasoning_effort: effort === "xhigh" ? "max" : "high",
  };
}

function applyThinkingEnabledControls(
  fields: Record<string, unknown>,
  dialect: OpenAICompatibleChatDialect,
  effort: OpenAIReasoningEffort | undefined,
): Record<string, unknown> {
  const thinking = { type: effort === "none" ? "disabled" : "enabled" };
  if (dialect.profileId === "moonshot") {
    return {
      ...fields,
      thinking,
    };
  }
  return {
    ...fields,
    thinking,
  };
}

function requestHasThinkingEnabled(fields: Readonly<Record<string, unknown>>): boolean {
  const thinking = asRecord(fields.thinking);
  if (thinking.type === "enabled") {
    return true;
  }
  const extraBodyThinking = asRecord(asRecord(fields.extra_body).thinking);
  return extraBodyThinking.type === "enabled";
}

function openAIReasoningEffortOrUndefined(value: unknown): OpenAIReasoningEffort | undefined {
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return undefined;
}

function inferProviderProfileId(baseUrl: string): ProviderProtocolProfileId {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "").toLowerCase();
  if (normalizedBaseUrl === "https://api.openai.com" || normalizedBaseUrl === "https://api.openai.com/v1") {
    return "openai";
  }
  if (normalizedBaseUrl.includes("deepseek")) return "deepseek";
  if (normalizedBaseUrl.includes("moonshot") || normalizedBaseUrl.includes("kimi")) return "moonshot";
  if (
    normalizedBaseUrl.includes("bigmodel") ||
    normalizedBaseUrl.includes("z.ai") ||
    normalizedBaseUrl.includes("zhipu") ||
    normalizedBaseUrl.includes("glm")
  ) {
    return "glm";
  }
  if (normalizedBaseUrl.includes("minimax") || normalizedBaseUrl.includes("minimaxi")) return "minimax";
  return "openai_compatible";
}

function isModernGLMThinkingModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.includes("glm-5.1") ||
    normalized.includes("glm-5") ||
    normalized.includes("glm-4.7");
}

function isKimiK3Model(model: string): boolean {
  return model.toLowerCase().includes("kimi-k3");
}
