import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import type {
  ConfirmedModelFacts,
  ModelFacts,
  ModelThinkingLevelName,
  ModelTransportKind,
} from "../../domain/config/index.js";

/**
 * 远程发现模型的二态解析（adapter 内部结构）。
 *
 * - `KnownPiModel`：模型 ID 在**连接显式声明的 piProviderId** 作用域内被 pi-ai
 *   真实 catalog 精确命中。运行事实（api / compat / input / contextWindow /
 *   maxTokens / thinkingLevelMap / reasoning / cost）直接取自真实 Pi Model，
 *   Synech 只覆盖 baseUrl / auth / provider 注册键。
 * - `UnknownDiscoveredModel`：Pi 在该 provider 下没有这个模型 ID。不持有任何
 *   能力事实；请求仍用连接级默认 transport 把模型 ID 原样发给上游。
 *
 * 约束：pi 类型只存在于本文件与 binding；这里向外只投影 domain 层的无 pi 类型
 * 二态结构（`ModelFacts`）。已知/未知不得合并为同一伪造事实。
 */

export type KnownPiModel = {
  readonly status: "known";
  readonly piProviderId: string;
  readonly modelId: string;
  /** 真实 Pi Model；调用方不得改写它的能力字段，只能覆盖连接事实。 */
  readonly model: Model<Api>;
};

export type UnknownDiscoveredModel = {
  readonly status: "unknown";
  readonly modelId: string;
};

export type DiscoveredModelResolution = KnownPiModel | UnknownDiscoveredModel;

/**
 * pi-ai 真实 provider catalog 的同步精确查找。
 *
 * 语义：`getModel(piProviderId, modelId)` 只在显式命名的 provider 作用域内做
 * `model.id === modelId` 精确比较——不做模糊匹配、不按 model id 猜厂商、不在
 * 多个 Pi Provider 中取第一条同名模型。因此同一个模型 ID 在不同 Pi Provider 下
 * 的事实不会互相串用。
 */
export function resolveDiscoveredModel(input: {
  readonly piProviderId: string | undefined;
  readonly modelId: string | undefined;
}): DiscoveredModelResolution {
  const piProviderId = trimmedOrUndefined(input.piProviderId);
  const modelId = trimmedOrUndefined(input.modelId);
  if (piProviderId === undefined || modelId === undefined) {
    return { status: "unknown", modelId: modelId ?? "" };
  }
  const model = piModelCatalog().getModel(piProviderId, modelId);
  return model === undefined
    ? { status: "unknown", modelId }
    : { status: "known", piProviderId, modelId, model };
}

/** 产品层（无 pi 类型）的二态事实投影：由调用方注入 `piProviderId` + modelId。 */
export function resolveDiscoveredModelFacts(input: {
  readonly piProviderId: string | undefined;
  readonly modelId: string | undefined;
}): ModelFacts {
  const resolution = resolveDiscoveredModel(input);
  return resolution.status === "known"
    ? confirmedFactsFromPiModel(resolution)
    : { status: "unconfirmed", modelId: resolution.modelId };
}

function confirmedFactsFromPiModel(resolution: KnownPiModel): ConfirmedModelFacts {
  const { model, piProviderId, modelId } = resolution;
  return {
    status: "confirmed",
    piProviderId,
    modelId,
    transport: piModelTransport(model.api),
    contextWindowTokens: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    supportsVisionInput: model.input.includes("image"),
    supportsReasoningOutput: model.reasoning === true,
    thinkingLevels: supportedThinkingLevels(model),
    supportsStrictToolSchemas: supportsStrictToolSchemasFor(model),
    // 并行工具调用是 OpenAI 协议特性：只有连接显式指向 pi 的 openai provider
    // 时，命中的模型才确实说 OpenAI 方言。
    supportsParallelToolCalls: piProviderId === "openai",
  };
}

/** 已知模型的 transport 由真实 Pi Model.api 投影；本产品无法服务的 api 为 undefined。 */
export function piModelTransport(api: Api): ModelTransportKind | undefined {
  switch (api) {
    case "openai-completions":
      return "openai_compatible_chat_completions";
    case "openai-responses":
      return "openai_responses";
    default:
      return undefined;
  }
}

const SUPPORTED_THINKING_LEVELS: readonly ModelThinkingLevelName[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** 真实 Pi Model.thinkingLevelMap 中受支持的档位；`null` 条目 = 该档位不支持。 */
function supportedThinkingLevels(model: Model<Api>): readonly ModelThinkingLevelName[] {
  const map = model.thinkingLevelMap;
  if (map === undefined || map === null) return [];
  const levels: ModelThinkingLevelName[] = [];
  for (const level of SUPPORTED_THINKING_LEVELS) {
    const value = (map as Readonly<Record<string, string | null>>)[level];
    if (value !== null && value !== undefined) levels.push(level);
  }
  return levels;
}

function supportsStrictToolSchemasFor(model: Model<Api>): boolean {
  if (model.api === "openai-responses") return true;
  const compat = model.compat as { readonly supportsStrictMode?: boolean } | undefined;
  return compat?.supportsStrictMode !== false;
}

let cachedCatalog: MutableModels | undefined;

/**
 * pi-ai 真实 catalog（构建期生成、随包发布）。运行时只读；未知 provider id 或未知
 * model id 的查找返回空，绝不退回「跨 provider 第一条同名」之类的模糊匹配。
 */
function piModelCatalog(): MutableModels {
  cachedCatalog ??= builtinModels();
  return cachedCatalog;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
