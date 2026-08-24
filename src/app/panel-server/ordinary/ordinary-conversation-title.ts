import type { ModelMessage, ModelOutputContract, ModelResponse } from "../../../domain/intelligence/index.js";
import { createId, nowIso } from "../../../kernel/id.js";
import type { ConfigCenter } from "../../config-center/index.js";
import {
  ModelRuntimeConfigurationError,
  resolveOpenAIModelRuntimeConfig,
  type OpenAIModelRuntimeMode,
  type ResolvedOpenAIModelRuntimeConfig,
} from "../../model-runtime/openai-runtime-config.js";
import { createOpenAIAuxiliaryModelChannel } from "../settings/model-provider-adapter.js";
import type { OrdinaryConversationTitleGenerator, OrdinaryRunBirth } from "../../ordinary-agent/index.js";

/** 标题输出上限极小：只承载列表摘要字段，不承载任何模型正文职责。 */
const TITLE_MAX_OUTPUT_TOKENS = 64;
const TITLE_PROMPT_REF = "prompt:ordinary.conversation_title.v1";

/**
 * Host 侧实现 Ordinary 的会话标题生成端口：用与 run 相同的冻结 provider
 * 配置发起一次无工具轻量请求，模型按预设人设直接返回 JSON 标题。
 * 配置缺失（未启用模型、未配 key）与模型请求失败均返回 undefined，
 * 由 Ordinary 继续使用首条消息截断回退。
 */
export function createOrdinaryConversationTitleGenerator(input: {
  readonly configCenter: ConfigCenter;
  readonly createModelChannel?: typeof createOpenAIAuxiliaryModelChannel;
}): OrdinaryConversationTitleGenerator {
  const createModelChannel = input.createModelChannel ?? createOpenAIAuxiliaryModelChannel;
  return async ({ conversationId, userMessage, birth }) => {
    const mode = birth.aiMode;
    if (mode !== "openai-compatible" && mode !== "openai-responses") return undefined;
    if (birth.config.secretConfigured !== true) return undefined;
    const environment = await input.configCenter.createModelRuntimeEnvironment({
      modelProvider: birth.config,
      informationAccess: birth.informationAccess,
    });
    const resolved = resolveRuntimeConfig({ mode, environment, birth });
    if (resolved === undefined) return undefined;
    const channel = createModelChannel({
      resolved,
      profileId: birth.config.profileId,
      resolveApiKey: async () => {
        const current = await input.configCenter.createModelRuntimeEnvironment({
          modelProvider: birth.config,
          informationAccess: birth.informationAccess,
        });
        return resolveRuntimeConfig({ mode, environment: current, birth })?.apiKey;
      },
      supportsVisionInput: birth.capabilitySnapshot.modelCapabilities.supportsVisionInput === true,
      supportsReasoningOutput: birth.capabilitySnapshot.modelCapabilities.supportsReasoningOutput === true,
      contextWindow: birth.capabilitySnapshot.modelCapabilities.contextWindowTokens,
      maxOutputTokens: birth.capabilitySnapshot.modelCapabilities.maxOutputTokens,
      providerKind: birth.config.providerKind,
      supportedPurposes: ["conversation_title"],
    });
    const requestId = createId("model-request");
    const response = await channel.request({
      requestId,
      traceId: requestId,
      callerRef: { kind: "goal", id: `conversation:${conversationId}`, label: "conversation_title" },
      purpose: "conversation_title",
      inputRefs: [],
      sanitizedMessages: conversationTitleMessages(userMessage),
      outputContract: conversationTitleOutputContract(),
      budget: { maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS },
      sensitivity: "internal",
      requestedAt: nowIso(),
      toolChoice: "none",
      tools: [],
    }, {});
    if (response.status !== "completed") return undefined;
    return extractConversationTitle(response);
  };
}

/** 缺 key/模型名等预期环境状态转换为 undefined（回退），其余错误继续上抛。 */
function resolveRuntimeConfig(input: {
  readonly mode: OpenAIModelRuntimeMode;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly birth: OrdinaryRunBirth;
}): ResolvedOpenAIModelRuntimeConfig | undefined {
  try {
    return resolveOpenAIModelRuntimeConfig({
      mode: input.mode,
      env: input.environment,
      modelProvider: input.birth.config,
    });
  } catch (error) {
    if (error instanceof ModelRuntimeConfigurationError) return undefined;
    throw error;
  }
}

function conversationTitleMessages(userMessage: string): readonly ModelMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是会话标题助手，为 Synech 的会话列表提炼简短标题。",
        "要求：",
        "- 只输出一个 JSON 对象，形如 {\"title\": \"标题文本\"}，不要输出任何其他内容",
        "- 标题使用与用户消息相同的语言",
        "- 中文标题 4-20 字，英文不超过 10 个词",
        "- 概括消息的核心意图，不照抄原文，不加引号、句号或解释性文字",
      ].join("\n"),
      ref: TITLE_PROMPT_REF,
    },
    {
      role: "user",
      content: userMessage,
    },
  ];
}

function conversationTitleOutputContract(): ModelOutputContract {
  return {
    contractId: "ordinary.conversation_title.v1",
    outputKind: "explanation",
    format: "text",
    minTextLength: 1,
    maxTextLength: 160,
    visibleOutput: {
      fields: ["text"],
      maxFieldLength: 80,
    },
  };
}

/**
 * 优先正则提取 JSON 的 title 字段；模型不按 JSON 返回时把整段文本当作
 * 标题（去掉首尾引号），空结果返回 undefined 走首条消息回退。
 */
function extractConversationTitle(response: ModelResponse): string | undefined {
  const text = typeof response.textOutput === "string" ? response.textOutput.trim() : "";
  if (text.length === 0) return undefined;
  const jsonField = /"title"\s*:\s*"([^"]*)"/u.exec(text);
  const candidate = jsonField?.[1]?.trim() ?? text.replace(/^["'“”]+|["'“”]+$/gu, "").trim();
  return candidate.length === 0 ? undefined : candidate;
}
