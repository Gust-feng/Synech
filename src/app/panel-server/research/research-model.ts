import { createId, nowIso } from "../../../kernel/id.js";
import type { ModelMessage } from "../../../domain/intelligence/index.js";
import type { ConfigCenter } from "../../config-center/index.js";
import {
  ModelRuntimeConfigurationError,
  resolveOpenAIModelRuntimeConfig,
  type OpenAIModelRuntimeMode,
} from "../../model-runtime/openai-runtime-config.js";
import type { ResearchModelPort } from "../../application/research-application.js";
import { RESEARCH_POLICY } from "../../research/index.js";
import { createOpenAIAuxiliaryModelChannel } from "../settings/model-provider-adapter.js";

/**
 * 判定某次模型失败是否值得重试。
 *
 * 只重试「传输类」失败：连接中断、网络不可达、上游超时。这类失败重发一次
 * 通常就好了，而且模型请求本身没有副作用——重试不会重复产生用户可见的结果。
 *
 * 明确不重试：`failed` 之外的任何状态，以及 provider_config / provider_auth /
 * provider_rate_limit（配置、鉴权、限流都是确定性的，重试只会浪费一次额度）、
 * 输出版本相关的失败（重试得到同样的输出）。
 *
 * 注意：当前适配层把连接错误一律归为 `provider_response`（见
 * adapters/intelligence/model-collection-channel.ts 对 Pi `stopReason: error` 的映射），
 * 因此传输类失败在这里必须按消息特征识别。这是对适配层分类粒度的代偿，
 * 不是用文案恢复业务语义——业务分支仍走 status/failure.kind，只有「是否重试」这一条
 * 在分类不足时借助消息判断。
 */
const RETRYABLE_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "provider_network",
  "provider_timeout",
]);

const TRANSIENT_MESSAGE_PATTERNS: readonly RegExp[] = [
  /connection error/i,
  /network/i,
  /socket hang up/i,
  /econnreset|econnrefused|etimedout|enotfound|epipe/i,
  /fetch failed/i,
  /temporarily unavailable/i,
];

export function isRetryableModelFailure(failure: { readonly kind: string; readonly message: string } | undefined): boolean {
  if (failure === undefined) return false;
  if (RETRYABLE_FAILURE_KINDS.has(failure.kind)) return true;
  if (failure.kind !== "provider_response") return false;
  return TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(failure.message));
}

/**
 * 深度研究的模型适配器（Host 组合根装配）。
 *
 * 与记忆整理、会话标题同一条链路：ConfigCenter 当前配置 → 冻结运行配置 →
 * 无工具辅助通道一次请求。纪律同样一致——provider 未配置、缺 key、运行时
 * 配置错误、请求失败或非 completed 一律返回 unavailable 由编排降级，绝不伪造结果；
 * 未预期的配置读取错误继续上抛（不掩盖 Product Home 完整性问题）。
 *
 * 与那两处调用方的差别只有一个：研究是用户主动发起、耗时分钟级、失败要用户重来的
 * 长任务，所以对**传输抖动**做一次有界重试（见 isRetryableModelFailure），
 * 避免一次瞬时连接失败让整项研究在起步阶段就废掉。重试次数与间隔取自 research-policy。
 */
export function createConfigCenterResearchModel(input: {
  readonly configCenter: ConfigCenter;
  readonly createModelChannel?: typeof createOpenAIAuxiliaryModelChannel;
}): ResearchModelPort {
  const createModelChannel = input.createModelChannel ?? createOpenAIAuxiliaryModelChannel;
  return {
    async complete(request) {
      const provider = await input.configCenter.getModelProviderConfig();
      const configuredMode = provider.defaultAiMode;
      if (provider.enabled === false) {
        return { status: "unavailable", reason: "model_provider_disabled" };
      }
      if (configuredMode === "none") {
        return { status: "unavailable", reason: "model_provider_not_configured" };
      }
      if (provider.secretConfigured !== true) {
        return { status: "unavailable", reason: "model_api_key_missing" };
      }
      const mode: OpenAIModelRuntimeMode = configuredMode;
      const environment = await input.configCenter.createModelRuntimeEnvironment({ modelProvider: provider });
      let resolved;
      try {
        resolved = resolveOpenAIModelRuntimeConfig({ mode, env: environment, modelProvider: provider });
      } catch (error) {
        // 配置缺项（典型是只填了服务地址与密钥、没填模型名）在这里才会暴露。
        // 把原因原样带出去，否则用户只会看到「模型不可用」，无从知道要补什么。
        if (error instanceof ModelRuntimeConfigurationError) {
          return { status: "unavailable", reason: `model_config_incomplete:${error.message}` };
        }
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
        supportedPurposes: ["deep_research"],
      });

      const requestId = createId("research-model");
      const messages: ModelMessage[] = [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ];

      /** 单次尝试：把响应收敛成「成功文本」或「失败事实」，不抛异常。 */
      const attempt = async (): Promise<
        | { readonly ok: true; readonly text: string; readonly inputTokens: number | null; readonly outputTokens: number | null }
        | { readonly ok: false; readonly reason: string; readonly retryable: boolean }
      > => {
        // 单次尝试的超时由调用方给定（拆题与成稿的合理耗时相差数倍），
        // 与任务取消信号合并：任一触发都中止本次尝试。
        const attemptSignal = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]);
        try {
          const response = await channel.request({
            requestId: createId("research-model"),
            traceId: requestId,
            callerRef: { kind: "goal", id: `deep_research:${provider.profileId}`, label: "deep_research" },
            purpose: "deep_research",
            inputRefs: [],
            sanitizedMessages: messages,
            outputContract: request.format === "json_object"
              ? {
                  contractId: "research.planning.v1",
                  outputKind: "explanation",
                  format: "json_object",
                  maxTextLength: 32_768,
                }
              : {
                  contractId: "research.report.v1",
                  outputKind: "draft",
                  format: "text",
                  maxTextLength: 64_000,
                },
            budget: { maxOutputTokens: request.maxOutputTokens, maxLatencyMs: request.timeoutMs },
            sensitivity: "internal",
            requestedAt: nowIso(),
            toolChoice: "none",
            tools: [],
          }, { abortSignal: attemptSignal });
          if (response.status !== "completed") {
            return {
              ok: false,
              reason: `model_response_${response.status}:${response.failure?.kind ?? "unknown"}`,
              // `cancelled` 是我们自己的超时或用户停止，重试只会再等一个完整超时；
              // 只有传输类失败才值得重发。
              retryable: response.status !== "cancelled" && isRetryableModelFailure(response.failure),
            };
          }
          return {
            ok: true,
            text: response.textOutput ?? "",
            inputTokens: response.usage?.inputTokens ?? null,
            outputTokens: response.usage?.outputTokens ?? null,
          };
        } catch (error) {
          // 请求期网络/通道错误按模型不可用降级：模型不可用时不伪造研究报告。
          // 只有当外层任务没被取消时才值得重试（超时/停止都应立刻收敛）。
          return {
            ok: false,
            reason: error instanceof Error ? `model_request_failed:${error.name}` : "model_request_failed",
            retryable: !request.signal.aborted,
          };
        }
      };

      for (let number = 1; number <= RESEARCH_POLICY.modelMaxAttempts; number += 1) {
        const result = await attempt();
        if (result.ok) {
          return {
            status: "completed",
            text: result.text,
            usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
          };
        }
        const lastAttempt = number >= RESEARCH_POLICY.modelMaxAttempts;
        if (!result.retryable || lastAttempt || request.signal.aborted) {
          return { status: "unavailable", reason: result.reason };
        }
        console.warn(
          `[research] 模型调用第 ${number} 次失败（${result.reason}），${RESEARCH_POLICY.modelRetryBackoffMs}ms 后重试。`,
        );
        await delay(RESEARCH_POLICY.modelRetryBackoffMs);
      }
      // 循环必然在内部返回；此处仅为类型完备。
      return { status: "unavailable", reason: "model_request_failed" };
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
