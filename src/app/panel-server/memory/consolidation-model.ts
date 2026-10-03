import type { ModelMessage } from "../../../domain/intelligence/index.js";
import { createId, nowIso } from "../../../kernel/id.js";
import type { ConfigCenter } from "../../config-center/index.js";
import {
  ModelRuntimeConfigurationError,
  resolveModelRuntimeConfig,
  type ResolvedModelRuntimeMode,
} from "../../model-runtime/model-runtime-config.js";
import type {
  MaintenanceModelOutcome,
  MemoryMaintenanceModelPort,
} from "../../memory/contracts.js";
import type { MaintenancePromptMessage } from "../../memory/contracts.js";
import { MAINTENANCE_PROMPT_REF } from "../../memory/capture/maintenance-prompt.js";
import { MAINTENANCE_MAX_OUTPUT_TOKENS, MAINTENANCE_MAX_LATENCY_MS } from "../../memory/policy/maintenance-limits.js";
import {
  createAuxiliaryModelChannel,
  createConfigCenterApiKeyResolver,
} from "../settings/model-provider-adapter.js";

/**
 * 记忆整理模型适配器（Host 组合根装配）：用 ConfigCenter 当前配置的模型 provider
 * 发起一次无工具 JSON 请求，purpose 固定为既有 `memory_consolidation`。与
 * ordinary-conversation-title 相同的降级纪律：provider 未配置 / 缺 key / 运行时
 * 配置错误 / 请求失败 / 非 completed 一律返回 `unavailable`，由维护管线把 job
 * 退回就绪队列重试，绝不伪造结果；未预期的配置读取错误继续上抛（不掩盖
 * Product Home 完整性问题）。
 *
 * 三层分离（能力事实 / 调用配置 / 返回事实），与研究侧同一判定：
 * - 能力事实（视觉输入、推理输出、上下文窗口、输出上限）唯一来源是连接显式
 *   `piProviderId` 上的 pi 真实 catalog 精确匹配（adapter 在 binding 内完成），
 *   这里不写死也不省略，也不由产品层传值；
 * - 调用配置：辅助通道内部固定 `thinkingLevel: "off"` 是共享通道自身的行为
 *   （研究与 ordinary-conversation-title 也走这条通道）。记忆整理是后台确定性
 *   任务，这是有理由的用途级配置；
 * - 返回事实：本次请求实际返回的内容块与 usage 由通道上报。
 */

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
  readonly createModelChannel?: typeof createAuxiliaryModelChannel;
}): MemoryMaintenanceModelPort {
  const createModelChannel = input.createModelChannel ?? createAuxiliaryModelChannel;
  return {
    async generate({ messages, maxLatencyMs }) {
      const deadline = Date.now() + Math.max(0, Math.min(MAINTENANCE_MAX_LATENCY_MS, maxLatencyMs ?? MAINTENANCE_MAX_LATENCY_MS));
      const provider = await input.configCenter.getModelProviderConfig();
      const configuredMode = provider.defaultAiMode;
      if (
        configuredMode === "none" ||
        provider.enabled === false ||
        (configuredMode !== "native" && provider.secretConfigured !== true)
      ) {
        return unavailable("model_provider_not_configured");
      }
      const mode: ResolvedModelRuntimeMode = configuredMode;
      const environment = await input.configCenter.createModelRuntimeEnvironment({ modelProvider: provider });
      let resolved;
      try {
        resolved = resolveModelRuntimeConfig({ mode, env: environment, modelProvider: provider });
      } catch (error) {
        if (error instanceof ModelRuntimeConfigurationError) return unavailable("model_provider_not_configured");
        throw error;
      }
      const channel = await createModelChannel({
        configCenter: input.configCenter,
        resolved,
        profileId: provider.profileId,
        providerKind: provider.providerKind,
        resolveApiKey: createConfigCenterApiKeyResolver({
          configCenter: input.configCenter,
          provider,
          mode,
        }),
        supportedPurposes: ["memory_consolidation"],
        ...(provider.piProviderId === undefined ? {} : { piProviderId: provider.piProviderId }),
      });

      if (Date.now() >= deadline) return unavailable("model_request_deadline_exceeded");
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
            maxLatencyMs: Math.max(1, deadline - Date.now()),
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
