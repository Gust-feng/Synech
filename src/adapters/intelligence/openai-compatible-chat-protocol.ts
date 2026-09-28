import type {
  OpenAIModelRequestSettings,
  ProviderProtocolProfileId,
} from "../../domain/config/index.js";
import { asRecord, isPlainRecord } from "./provider-value-utils.js";

/**
 * OpenAI 兼容聊天的厂商方言。
 *
 * 这里只承载「连接级显式事实」：`providerProfileId` 来自连接配置（预置或用户
 * 显式选择），不再按 model id / baseUrl 猜厂商。它只用于 pi 没有 compat 的
 * 少量请求字段策略，不再是能力事实链——模型语义、能力、protocol/transport 与
 * 推理档位全部由真实 Pi Model 决定。
 */
export type OpenAICompatibleChatDialect = {
  readonly providerProfileId: ProviderProtocolProfileId | undefined;
};

export function resolveOpenAICompatibleChatDialect(input: {
  readonly providerProfileId?: ProviderProtocolProfileId;
}): OpenAICompatibleChatDialect {
  return { providerProfileId: input.providerProfileId };
}

/**
 * Provider fields Pi has no compat for.
 *
 * 这些是厂商端点自身的请求字段策略，不是模型能力事实，因此只在连接显式声明了
 * 对应 vendor 家族时应用；连接没有显式 vendor 时一条都不写。Kimi K3 的两字段
 * 是 pi 无对应格式的供应商字段，按连接显式的 moonshot 家族 + 模型 ID 识别。
 */
export function applyOpenAICompatibleChatRequestPolicy(input: {
  readonly fields: Record<string, unknown>;
  readonly dialect: OpenAICompatibleChatDialect;
  readonly modelId: string;
  readonly effort?: OpenAIModelRequestSettings["reasoningEffort"];
}): Record<string, unknown> {
  const next = { ...input.fields };
  if (input.dialect.providerProfileId === "moonshot" && isKimiK3Model(input.modelId)) {
    next.reasoning_effort = "max";
    next.thinking = { type: input.effort === undefined || input.effort === "none" ? "disabled" : "enabled" };
  }
  if (input.dialect.providerProfileId === "moonshot") {
    delete next.temperature;
    delete next.top_p;
  }
  if (input.dialect.providerProfileId === "deepseek" && requestHasThinkingEnabled(next)) {
    delete next.temperature;
    delete next.top_p;
  }
  if (
    (input.dialect.providerProfileId === "deepseek" || input.dialect.providerProfileId === "moonshot") &&
    requestHasThinkingEnabled(next) &&
    isPlainRecord(next.tool_choice)
  ) {
    next.tool_choice = "auto";
  }
  if (input.dialect.providerProfileId === "minimax") {
    next.reasoning_split = true;
  }
  return next;
}

function requestHasThinkingEnabled(fields: Readonly<Record<string, unknown>>): boolean {
  const thinking = asRecord(fields.thinking);
  if (thinking.type === "enabled") {
    return true;
  }
  const extraBodyThinking = asRecord(asRecord(fields.extra_body).thinking);
  return extraBodyThinking.type === "enabled";
}

function isKimiK3Model(model: string): boolean {
  return model.toLowerCase().includes("kimi-k3");
}
