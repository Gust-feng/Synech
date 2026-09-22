import { InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import type { ConfigCenter } from "../../config-center/index.js";
import type { ResearchFeature } from "../../research/index.js";
import type {
  ResearchApplication,
  ResearchTurnOpening,
  ResearchTurnPort,
} from "../../application/research-application.js";
import { createResearchApplication } from "../../application/research-application.js";
import { createConfigCenterResearchSearch } from "../research/research-search.js";
import { createResearchContentFetcher } from "../research/research-content.js";
import { createResearchWorker, type ResearchWorker } from "../research/research-worker.js";
import {
  RESEARCH_TASK_RESOURCE_OWNER_KIND,
  createResearchLoopTools,
} from "../research/research-loop-tools.js";
import { ToolRegistry } from "../../tool-center/tool-registry.js";
import { createAgentSessionLoop } from "../../../adapters/intelligence/agent-session-loop.js";
import { createModelProviderBinding } from "../../../adapters/intelligence/model-provider-binding.js";
import {
  ModelRuntimeConfigurationError,
  resolveOpenAIModelRuntimeConfig,
  type OpenAIModelRuntimeMode,
  type ResolvedOpenAIModelRuntimeConfig,
} from "../../model-runtime/openai-runtime-config.js";
import { createConfigCenterResearchModel } from "../research/research-model.js";
import { createResearchFinalization } from "../../application/research-finalization.js";

/**
 * 深度研究能力组合：显式创建端口、应用与执行 worker，并交出唯一入口。
 *
 * 与其他 composition builder 相同的纪律：只做装配与依赖注入，不做业务判断。
 * Search provider 与模型都经 ConfigCenter 解析——研究不持有第二份配置。
 *
 * turn 驱动（ADR 0001 §2.3）的装配面：
 * - 研究自己的工具注册表与工具中心：loop 工具只注册在 `research` scope；
 *   会话侧工具（ResearchStart / ResearchStatus）不进入研究 loop 的边界——
 *   研究模型无权发起新研究，那两个入口只属于会话 agent 的工具中心；
 * - 每个 turn 新 Session（账本恢复语义，不重放 transcript）+ 复用 ConfigCenter
 *   当前模型配置的 provider binding；配置类不可用如实返回，让应用层立即收敛；
 * - 成稿端口接入报告库（src/app/research/report/**）：写作/核验的模型调用复用同一份
 *   ConfigCenter 模型配置的单 shot 通道（createConfigCenterResearchModel），编排规则在
 *   application/research-finalization.ts，本文件只负责把它和模型端口接起来。
 */

const RESEARCH_LOOP_CALLER_AGENT_ID = "research";
const RESEARCH_TOOL_SCOPE = "research";

export type ResearchRuntime = {
  readonly application: ResearchApplication;
  readonly worker: ResearchWorker;
};

export function createResearchRuntime(input: {
  readonly feature: Pick<ResearchFeature, "commands" | "queries" | "events" | "cancel" | "ready">;
  readonly configCenter: ConfigCenter;
  /** 可注入的抓取实现（测试或宿主替换浏览器能力）。 */
  readonly contentFetcher?: ReturnType<typeof createResearchContentFetcher>;
  readonly onDiagnostic?: (topic: string, error: unknown) => void;
}): ResearchRuntime {
  const configCenter = input.configCenter;
  const onDiagnostic = input.onDiagnostic;
  const search = createConfigCenterResearchSearch({ configCenter });
  const content = input.contentFetcher ?? createResearchContentFetcher({});

  // 研究自己的工具中心：loop 工具全集（能力缺失时对应工具不注册）。
  const toolRegistry = new ToolRegistry();
  for (const executor of createResearchLoopTools({
    feature: input.feature,
    search: search.port,
    content,
  })) {
    toolRegistry.register({ executor, scopes: [RESEARCH_TOOL_SCOPE], enabledByDefault: true });
  }
  const researchToolCenter = toolRegistry.createToolCenter(RESEARCH_TOOL_SCOPE);

  const turns: ResearchTurnPort = {
    async openTurn({ taskId, signal }): Promise<ResearchTurnOpening> {
      const resolved = await resolveResearchModelConfig({ configCenter });
      if (resolved.status === "unavailable") {
        return { status: "unavailable", reason: resolved.reason };
      }
      const binding = createResearchModelBinding({ configCenter, resolved });
      const definitions = researchToolCenter.list();
      const executionEnvironment = new NodeExecutionEnv({ cwd: process.cwd() });
      // 每个 turn 新 Session：逐步驱动从账本重新装配上下文，不重放 transcript。
      const loop = createAgentSessionLoop({
        executionEnvironment,
        modelRegistry: binding.modelRegistry,
        selectedModel: binding.selectedModel,
        thinkingLevel: binding.thinkingLevel,
        ...(binding.transformProviderPayload === undefined
          ? {}
          : { transformProviderPayload: binding.transformProviderPayload }),
        agentSession: new Session(new InMemorySessionStorage()),
      });
      const originalRelease = loop.release.bind(loop);
      return {
        status: "ready",
        loop: {
          execute: (executeInput) => loop.execute(executeInput),
          release: async () => {
            try {
              await originalRelease();
            } finally {
              await executionEnvironment.cleanup().catch(() => undefined);
            }
          },
        },
        tools: {
          definitions,
          gateway: researchToolCenter,
          context: {
            callerAgentId: RESEARCH_LOOP_CALLER_AGENT_ID,
            traceId: taskId,
            goalId: taskId,
            // 任务身份由 Host 绑定：模型入参无法指定任务，不存在跨任务读写入口。
            resourceScope: { ownerKind: RESEARCH_TASK_RESOURCE_OWNER_KIND, ownerId: taskId },
            abortSignal: signal,
          },
          permission: {
            callerAgentId: RESEARCH_LOOP_CALLER_AGENT_ID,
            allowedTools: definitions.map((definition) => definition.name),
          },
        },
      };
    },
  };

  // 成稿端口：报告库经 application 编排层接入，模型走 ConfigCenter 单 shot 通道。
  const finalization = createResearchFinalization({
    feature: input.feature,
    model: createConfigCenterResearchModel({ configCenter }),
    describeVerifierModel: async () => {
      const resolved = await resolveResearchModelConfig({ configCenter });
      return resolved.status === "ready" ? resolved.model : null;
    },
    ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
  });

  const application = createResearchApplication({
    feature: input.feature,
    turns,
    finalization,
    readiness: async () => ({ search: await search.readiness() }),
    ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
  });
  const worker = createResearchWorker({
    feature: input.feature,
    application,
    ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
  });
  return { application, worker };
}

/** 当前这一份模型配置的形状（ConfigCenter 只读投影，不引入第二份配置事实）。 */
type ResearchModelProviderConfig = Awaited<ReturnType<ConfigCenter["getModelProviderConfig"]>>;

/**
 * 模型运行时配置解析：ConfigCenter 当前这一份模型配置 → 冻结运行配置。
 *
 * turn 回路（provider binding）与成稿期的 verifier 模型标识共用同一实现，不读两份配置。
 * 配置类问题（未配置 / 停用 / 缺 key / 配置不完整）返回 unavailable：应用层立即如实
 * 收敛，不烧检索与抓取额度；其余错误继续上抛（不掩盖 Product Home 完整性问题）。
 */
async function resolveResearchModelConfig(input: {
  readonly configCenter: ConfigCenter;
}): Promise<
  | {
      readonly status: "ready";
      /** 模型标识：用户可见面的溯源事实（如核验记录里的 verifierModel）。 */
      readonly model: string;
      /** 本次解析读到的配置：整个 turn 内冻结使用，不随用户改配置漂移。 */
      readonly provider: ResearchModelProviderConfig;
      readonly config: ResolvedOpenAIModelRuntimeConfig;
    }
  | { readonly status: "unavailable"; readonly reason: string }
> {
  const configCenter = input.configCenter;
  const provider = await configCenter.getModelProviderConfig();
  if (provider.enabled === false) {
    return { status: "unavailable", reason: "model_provider_disabled" };
  }
  const configuredMode = provider.defaultAiMode;
  if (configuredMode === "none") {
    return { status: "unavailable", reason: "model_provider_not_configured" };
  }
  if (provider.secretConfigured !== true) {
    return { status: "unavailable", reason: "model_api_key_missing" };
  }
  const mode: OpenAIModelRuntimeMode = configuredMode;
  const environment = await configCenter.createModelRuntimeEnvironment({ modelProvider: provider });
  let config: ResolvedOpenAIModelRuntimeConfig;
  try {
    config = resolveOpenAIModelRuntimeConfig({ mode, env: environment, modelProvider: provider });
  } catch (error) {
    if (error instanceof ModelRuntimeConfigurationError) {
      // 配置缺项（典型是只填了服务地址与密钥、没填模型名）如实带回原因。
      return { status: "unavailable", reason: `model_config_incomplete:${error.message}` };
    }
    throw error;
  }
  return { status: "ready", model: config.model, provider, config };
}

/** 研究 loop 的 provider binding（每个 turn 新建一次；loop 释放即释放）。 */
type ResearchModelBinding = {
  readonly modelRegistry: ReturnType<typeof createModelProviderBinding>["modelRegistry"];
  readonly selectedModel: ReturnType<typeof createModelProviderBinding>["selectedModel"];
  readonly thinkingLevel: ReturnType<typeof createModelProviderBinding>["thinkingLevel"];
  readonly transformProviderPayload: ReturnType<typeof createModelProviderBinding>["transformProviderPayload"];
};

function createResearchModelBinding(input: {
  readonly configCenter: ConfigCenter;
  readonly resolved: Extract<
    Awaited<ReturnType<typeof resolveResearchModelConfig>>,
    { readonly status: "ready" }
  >;
}): ResearchModelBinding {
  const configCenter = input.configCenter;
  const provider = input.resolved.provider;
  const resolved = input.resolved.config;
  const binding = createModelProviderBinding({
    protocol: resolved.protocol,
    baseUrl: resolved.baseUrl,
    model: resolved.model,
    profileId: provider.profileId,
    resolveApiKey: async () => {
      try {
        const current = await configCenter.createModelRuntimeEnvironment({ modelProvider: provider });
        return resolveOpenAIModelRuntimeConfig({
          mode: resolved.mode,
          env: current,
          modelProvider: provider,
        }).apiKey;
      } catch (error) {
        if (error instanceof ModelRuntimeConfigurationError) return undefined;
        throw error;
      }
    },
    providerProfileId: resolved.providerProfileId,
    requestSettings: resolved.requestSettings,
    enableWebSearch: resolved.enableWebSearch,
    supportsVisionInput: false,
    supportsReasoningOutput: false,
  });
  return {
    modelRegistry: binding.modelRegistry,
    selectedModel: binding.selectedModel,
    thinkingLevel: binding.thinkingLevel,
    transformProviderPayload: binding.transformProviderPayload,
  };
}
