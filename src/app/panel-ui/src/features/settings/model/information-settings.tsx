import React from "react";
import { Cpu, Save } from "lucide-react";
import type { ConfigResponse, ModelCapabilities, ModelProviderModelCatalog } from "@panel-api/config";
import type { ChatModelOption } from "../../../contracts/composer";
import { modelOptionsFromConfig } from "./options";
import { ModelOptionPicker } from "./option-picker";
import { CapabilitySettingsSection } from "../components/capability-section";
import {
  formatTokenWindow,
  isConfirmedModelFacts,
  modelContextWindowTokens,
  modelMaxOutputTokens,
  modelSupportsReasoningEffort,
  modelSupportsVisionInput,
  type ModelCapabilityOverride,
} from "./capability-display";

type ModelCapabilityTarget = {
  readonly key: string;
  readonly option: ChatModelOption;
  readonly profileId: string;
  readonly providerKind?: string;
  readonly model: string;
  readonly effectiveCapabilities?: ModelCapabilities;
};

type ModelCapabilityDraft = {
  readonly contextWindowTokens: string;
  readonly maxOutputTokens: string;
  readonly supportsVisionInput: boolean;
  readonly supportsReasoningEffort: boolean;
};

type ModelCapabilityToggleKey =
  | "supportsVisionInput"
  | "supportsReasoningEffort";

export function ModelInformationSettings(props: {
  readonly config?: ConfigResponse;
  readonly modelCatalogs?: Readonly<Record<string, ModelProviderModelCatalog>>;
  readonly saving?: boolean;
  readonly onSave: (form: {
    readonly profileId: string;
    readonly providerKind?: string;
    readonly model: string;
    readonly capabilities: ModelCapabilityOverride;
  }) => Promise<void>;
}): React.ReactElement {
  const targets = React.useMemo(
    () => modelCapabilityTargets(props.config, props.modelCatalogs),
    [props.config, props.modelCatalogs]
  );
  const [selectedKey, setSelectedKey] = React.useState("");
  const selectedTarget = targets.find((target) => target.key === selectedKey) ?? targets[0];
  const [draft, setDraft] = React.useState<ModelCapabilityDraft>(() => modelCapabilityDraftFrom(undefined));

  React.useEffect(() => {
    if (targets.length === 0) {
      setSelectedKey("");
      return;
    }
    if (selectedKey.length > 0 && targets.some((target) => target.key === selectedKey)) {
      return;
    }
    const activeProfileId = props.config?.config?.profileId;
    const activeModel = props.config?.config?.model;
    const active = targets.find((target) => target.profileId === activeProfileId && target.model === activeModel);
    setSelectedKey((active ?? targets[0])!.key);
  }, [props.config?.config?.model, props.config?.config?.profileId, selectedKey, targets]);

  React.useEffect(() => {
    setDraft(modelCapabilityDraftFrom(selectedTarget?.effectiveCapabilities));
  }, [
    selectedTarget?.key,
    selectedTarget?.effectiveCapabilities,
  ]);

  const updateDraft = (patch: Partial<ModelCapabilityDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const dirty = selectedTarget !== undefined && modelCapabilityDraftChanged(draft, selectedTarget.effectiveCapabilities);

  const save = async (): Promise<void> => {
    if (selectedTarget === undefined) return;
    await props.onSave({
      profileId: selectedTarget.profileId,
      providerKind: selectedTarget.providerKind,
      model: selectedTarget.model,
      capabilities: modelCapabilityOverrideFromDraft(draft, selectedTarget.effectiveCapabilities?.override),
    });
  };

  return (
    <CapabilitySettingsSection
      icon={<Cpu size={16} />}
      title="模型信息"
      busy={props.saving === true}
      actions={
        <button
          type="button"
          className="model-info-save-button"
          onClick={() => void save()}
          disabled={selectedTarget === undefined || dirty !== true || props.saving === true}
        >
          <Save size={14} />
          <span>{props.saving ? "保存中" : "保存"}</span>
        </button>
      }
    >
      {selectedTarget === undefined ? (
        <div className="capability-empty">暂无可配置模型。请先在模型服务中添加模型。</div>
      ) : (
        <>
          <div className="model-info-grid">
            <div className="model-info-field model-info-field-wide">
              <span>模型</span>
              <ModelOptionPicker
                options={targets.map((target) => target.option)}
                selectedId={selectedTarget.key}
                onSelect={setSelectedKey}
                emptyLabel="暂无可配置模型"
                ariaLabel="选择模型"
                variant="settings"
                placement="top"
              />
            </div>
          </div>
          <ModelFactsSummary capabilities={selectedTarget.effectiveCapabilities} />
          <div className="model-info-grid">
            <label className="model-info-field">
              上下文窗口
              <input
                type="number"
                min={1}
                value={draft.contextWindowTokens}
                disabled={props.saving === true}
                aria-label="上下文窗口"
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                onChange={(event) => updateDraft({ contextWindowTokens: event.target.value })}
                placeholder="token"
              />
            </label>
            <label className="model-info-field">
              最大输出
              <input
                type="number"
                min={1}
                value={draft.maxOutputTokens}
                disabled={props.saving === true}
                aria-label="最大输出"
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                onChange={(event) => updateDraft({ maxOutputTokens: event.target.value })}
                placeholder="token"
              />
            </label>
          </div>
          <p className="model-info-override-hint">
            以下为你的显式声明，可覆盖 Pi 事实；Pi 未识别的模型只能由这里声明能力。
          </p>
          <div className="model-info-toggle-grid" aria-label="模型信息开关">
            {MODEL_CAPABILITY_TOGGLES.map((item) => (
              <div className="model-info-toggle-row" key={item.key}>
                <span>{item.label}</span>
                <button
                  type="button"
                  className="capability-toggle"
                  aria-pressed={draft[item.key]}
                  onClick={() => updateDraft({ [item.key]: !draft[item.key] })}
                >
                  {draft[item.key] ? "开启" : "关闭"}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </CapabilitySettingsSection>
  );
}

/** Pi 事实投影：已知模型展示真实事实，未确认模型不展示任何未确认能力信息。 */
function ModelFactsSummary(props: { readonly capabilities?: ModelCapabilities }): React.ReactElement {
  const facts = props.capabilities?.facts;
  if (!isConfirmedModelFacts(facts)) {
    return (
      <div className="capability-empty">
        远程发现的模型，Pi 未识别：不展示上下文窗口、视觉与推理等未确认信息。
      </div>
    );
  }
  const contextWindow = formatTokenWindow(facts.contextWindowTokens);
  const maxOutput = formatTokenWindow(facts.maxOutputTokens);
  return (
    <div className="model-info-grid" aria-label="Pi 模型事实">
      <div className="model-info-field">
        <span>Pi Provider</span>
        <strong>{facts.piProviderId}</strong>
      </div>
      <div className="model-info-field">
        <span>上下文窗口</span>
        <strong>{contextWindow ?? "未提供"}</strong>
      </div>
      <div className="model-info-field">
        <span>最大输出</span>
        <strong>{maxOutput ?? "未提供"}</strong>
      </div>
      <div className="model-info-field">
        <span>视觉输入</span>
        <strong>{facts.supportsVisionInput ? "支持" : "不支持"}</strong>
      </div>
      <div className="model-info-field model-info-field-wide">
        <span>推理档位</span>
        <strong>
          {facts.thinkingLevels.length === 0 ? "未提供" : facts.thinkingLevels.join(" / ")}
        </strong>
      </div>
    </div>
  );
}

const MODEL_CAPABILITY_TOGGLES: readonly {
  readonly key: ModelCapabilityToggleKey;
  readonly label: string;
}[] = [
  { key: "supportsVisionInput", label: "视觉输入" },
  { key: "supportsReasoningEffort", label: "思考强度" },
];

function modelCapabilityTargets(
  config: ConfigResponse | undefined,
  modelCatalogs: Readonly<Record<string, ModelProviderModelCatalog>> | undefined
): readonly ModelCapabilityTarget[] {
  type ProviderProfile = NonNullable<ConfigResponse["profiles"]>[number];
  const providers = new Map<string, ProviderProfile>();
  for (const profile of config?.profiles ?? []) {
    if (typeof profile.profileId === "string" && profile.profileId.trim().length > 0) {
      providers.set(profile.profileId, profile);
    }
  }
  return modelOptionsFromConfig(config, modelCatalogs ?? {}, { includeCapabilityProfileModels: true }).map((option) => {
    const providerKind = providers.get(option.profileId)?.providerKind;
    return {
      key: option.id,
      option,
      profileId: option.profileId,
      model: option.modelId,
      ...(providerKind === undefined ? {} : { providerKind }),
      ...(option.capabilities === undefined ? {} : { effectiveCapabilities: option.capabilities }),
    };
  });
}

function modelCapabilityDraftFrom(capabilities: ModelCapabilities | undefined): ModelCapabilityDraft {
  return {
    contextWindowTokens: stringFromPositiveInteger(modelContextWindowTokens(capabilities)),
    maxOutputTokens: stringFromPositiveInteger(modelMaxOutputTokens(capabilities)),
    supportsVisionInput: modelSupportsVisionInput(capabilities) === true,
    supportsReasoningEffort: modelSupportsReasoningEffort(capabilities) === true,
  };
}

function modelCapabilityOverrideFromDraft(
  draft: ModelCapabilityDraft,
  baseOverride: ModelCapabilityOverride | undefined
): ModelCapabilityOverride {
  return {
    ...baseOverride,
    contextWindowTokens: positiveIntegerFromString(draft.contextWindowTokens),
    maxOutputTokens: positiveIntegerFromString(draft.maxOutputTokens),
    supportsVisionInput: draft.supportsVisionInput,
    supportsReasoningEffort: draft.supportsReasoningEffort,
  };
}

function modelCapabilityDraftChanged(
  draft: ModelCapabilityDraft,
  capabilities: ModelCapabilities | undefined
): boolean {
  return (
    draft.contextWindowTokens !== stringFromPositiveInteger(modelContextWindowTokens(capabilities)) ||
    draft.maxOutputTokens !== stringFromPositiveInteger(modelMaxOutputTokens(capabilities)) ||
    draft.supportsVisionInput !== (modelSupportsVisionInput(capabilities) === true) ||
    draft.supportsReasoningEffort !== (modelSupportsReasoningEffort(capabilities) === true)
  );
}

function stringFromPositiveInteger(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? String(Math.floor(value)) : "";
}

function positiveIntegerFromString(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}
