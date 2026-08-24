/**
 * 对话转录的模型徽标投影。
 *
 * 把“本轮回答由哪个模型产出”解析成可在转录中展示的徽标：
 * - 持久化 turn 优先使用 turn.responseModel（回答时的真实模型）；
 * - 尚无持久化信息的进行中/独立 run 回退到 composer 当前选中的模型；
 * - 未配置模型的合成占位不展示徽标。
 *
 * 身份与图标解析复用中性能力模块 model-provider-logos / model-icons，
 * 这里只负责把 turn 与模型选项组合成展示数据。
 */
import type { ConversationTurn } from "@ui/contracts/conversation";
import type { ChatModelOption } from "@ui/contracts/composer";
import { resolveModelIconSvgForModel } from "@ui/features/settings/model/icons";
import { resolveModelProviderIdentity, type ModelProviderIdentity } from "@ui/features/settings/model/provider-logos";

export type ConversationModelBadge = {
  readonly modelName: string;
  readonly providerLabel: string;
  readonly providerIdentity: ModelProviderIdentity;
  readonly iconSvg?: string;
};

export function assistantModelForTurn(
  turn: ConversationTurn,
  models: readonly ChatModelOption[],
  selectedModelId: string
): ConversationModelBadge | undefined {
  if (turn.responseModel !== undefined) {
    if (isSyntheticResponseModel(turn)) {
      return undefined;
    }
    const matched = models.find(
      (model) =>
        model.profileId === turn.responseModel?.profileId &&
        model.modelId === turn.responseModel?.model
    );
    if (matched !== undefined) {
      return modelBadgeFromOption(matched);
    }
    const identity = resolveModelProviderIdentity({
      title: turn.responseModel.label,
      profileId: turn.responseModel.profileId,
      baseUrl: turn.responseModel.baseUrl,
      model: turn.responseModel.model,
    });
    return {
      modelName: turn.responseModel.model ?? turn.responseModel.label ?? "模型",
      providerLabel: turn.responseModel.label ?? "模型",
      providerIdentity: identity,
      iconSvg: resolveModelIconSvgForModel({
        providerIdentity: identity,
        modelId: turn.responseModel.model,
        displayName: turn.responseModel.label,
      }),
    };
  }
  return selectedComposerModel(models, selectedModelId);
}

export function selectedComposerModel(
  models: readonly ChatModelOption[],
  selectedModelId: string
): ConversationModelBadge | undefined {
  const selected = models.find((model) => model.id === selectedModelId);
  return selected === undefined ? undefined : modelBadgeFromOption(selected);
}

function isSyntheticResponseModel(turn: ConversationTurn): boolean {
  const profileId = turn.responseModel?.profileId?.trim().toLowerCase() ?? "";
  const model = turn.responseModel?.model?.trim().toLowerCase() ?? "";
  const providerKind = turn.responseModel?.providerKind?.trim().toLowerCase() ?? "";
  return profileId === "default" && model.length === 0 ||
    profileId === "none" ||
    model === "none" ||
    providerKind === "none";
}

function modelBadgeFromOption(model: ChatModelOption): ConversationModelBadge {
  return {
    modelName: model.name,
    providerLabel: model.providerLabel,
    providerIdentity: model.providerIdentity,
    iconSvg: model.iconSvg,
  };
}
