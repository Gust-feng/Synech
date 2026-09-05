import type { ModelMessage } from "../../../domain/intelligence/index.js";
import { createId, nowIso } from "../../../kernel/id.js";
import type { ConfigCenter } from "../../config-center/index.js";
import {
  ModelRuntimeConfigurationError,
  resolveOpenAIModelRuntimeConfig,
  type OpenAIModelRuntimeMode,
} from "../../model-runtime/openai-runtime-config.js";
import type {
  MaintenanceModelOutcome,
  MemoryMaintenanceModelPort,
} from "../../memory/capture/consolidation.js";
import type { MaintenancePromptMessage } from "../../memory/capture/consolidation.js";
import { MAINTENANCE_PROMPT_REF } from "../../memory/capture/consolidation.js";
import { createOpenAIAuxiliaryModelChannel } from "../settings/model-provider-adapter.js";

/**
 * 记忆整理模型适配器（Host 组合根装配）：用 ConfigCenter 当前配置的模型 provider
 * 发起一次无工具 JSON 请求，purpose 固定为既有 `memory_consolidation`。与
 * ordinary-conversation-title 相同的降级纪律：provider 未配置 / 缺 key / 运行时
 * 配置错误 / 请求失败 / 非 completed 一律返回 `unavailable`，由维护管线把 job
 * 退回就绪队列重试，绝不伪造结果；未预期的配置读取错误继续上抛（不掩盖
 * Product Home 完整性问题）。
 */

/** 输出上限：双正文 + JSON 开销（正式设计 §13，实验参数，不照搬旧 1024 限制）。 */
const MAINTENANCE_MAX_OUTPUT_TOKENS = 12_000;
/** 后台整理不阻塞主链路，但也不允许无限挂起占用单飞 worker。 */
const MAINTENANCE_MAX_LATENCY_MS = 120_000;

function unavailable(reason: string): MaintenanceModelOutcome {
  return { status: "unavailable", reason };
}

function toModelMessage(message: MaintenancePromptMessage): ModelMessage {
  return message.role === "system"
    ? { role: "system", content: message.content, ref: MAINTENANCE_PROMPT_REF }
    : { role: "user", content: message.content };
}

export function createConfigCenterConsolidationModel(input: {
  readonly configCenter: ConfigCenter;
  readonly createModelChannel?: typeof createOpenAIAuxiliaryModelChannel;
}): MemoryMaintenanceModelPort {
  const createModelChannel = input.createModelChannel ?? createOpenAIAuxiliaryModelChannel;
  return {
    async generate({ messages }) {
      const provider = await input.configCenter.getModelProviderConfig();
      const configuredMode = provider.defaultAiMode;
      if (
        configuredMode === "none" ||
        provider.enabled === false ||
        provider.secretConfigured !== true
      ) {
        return unavailable("model_provider_not_configured");
      }
      const mode: OpenAIModelRuntimeMode = configuredMode;
      const environment = await input.configCenter.createModelRuntimeEnvironment({ modelProvider: provider });
      let resolved;
      try {
        resolved = resolveOpenAIModelRuntimeConfig({ mode, env: environment, modelProvider: provider });
      } catch (error) {
        if (error instanceof ModelRuntimeConfigurationError) return unavailable("model_provider_not_configured");
        throw error;
      }
      const channel = createModelChannel({
        resolved,
        profileId: provider.profileId,
        providerKind: provider.providerKind,
        resolveApiKey: async () => {
          try {
            const current = await input.configCenter.createModelRuntimeEnvironment({ modelProvider: provider });
            return resolveOpenAIModelRuntimeConfig({ mode, env: current, modelProvider: provider }).apiKey;
          } catch (error) {
            if (error instanceof ModelRuntimeConfigurationError) return undefined;
            throw error;
          }
        },
        supportsVisionInput: false,
        supportsReasoningOutput: false,
        supportedPurposes: ["memory_consolidation"],
      });

      const requestId = createId("model-request");
      let textOutput: string | undefined;
      try {
        const response = await channel.request({
          requestId,
          traceId: requestId,
          callerRef: {
            kind: "goal",
            id: `memory_maintenance:${provider.profileId}`,
            label: "memory_maintenance",
          },
          purpose: "memory_consolidation",
          inputRefs: [],
          sanitizedMessages: messages.map(toModelMessage),
          outputContract: {
            contractId: "memory.maintenance.v1",
            outputKind: "explanation",
            format: "json_object",
            maxTextLength: 32_768,
          },
          budget: {
            maxOutputTokens: MAINTENANCE_MAX_OUTPUT_TOKENS,
            maxLatencyMs: MAINTENANCE_MAX_LATENCY_MS,
          },
          sensitivity: "internal",
          requestedAt: nowIso(),
          toolChoice: "none",
          tools: [],
        }, {});
        if (response.status !== "completed") {
          return unavailable(`model_response_${response.status}`);
        }
        textOutput = response.textOutput;
      } catch (error) {
        // 请求期网络/通道错误按模型不可用降级：模型不可用时不伪造 Memory。
        return unavailable(error instanceof Error ? `model_request_failed:${error.name}` : "model_request_failed");
      }
      return { status: "completed", text: textOutput ?? "" };
    },
  };
}
