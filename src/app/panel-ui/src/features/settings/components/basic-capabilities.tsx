import React from "react";
import { MessageSquareText, RotateCcw, Save, SlidersHorizontal } from "lucide-react";
import type { ConfigResponse, SkillTriggerMode } from "@panel-api/config";
import type { ConversationFollowUpMode } from "../../../contracts/composer";
import { SettingsSelectControl } from "./select-control";
import { CapabilitySettingsSection } from "./capability-section";

export function BasicCapabilitiesSettings(props: {
  readonly config?: ConfigResponse;
  readonly modelUsageDisplayEnabled: boolean;
  readonly onModelUsageDisplayChange: (enabled: boolean) => void;
  readonly conversationFollowUpMode: ConversationFollowUpMode;
  readonly onConversationFollowUpModeChange: (mode: ConversationFollowUpMode) => void;
  readonly savingSkillTrigger?: boolean;
  readonly onSaveSkillTriggerMode: (mode: SkillTriggerMode) => void;
  readonly savingOrdinaryAgentPrompt?: boolean;
  readonly onSaveOrdinaryAgentSystemPromptVariant: (variant: string) => Promise<void>;
}): React.ReactElement {
  return (
    <CapabilitySettingsSection
      icon={<SlidersHorizontal size={16} />}
      title="运行偏好"
    >
      <div className="capability-preference-list">
        <ModelUsageDisplaySettings
          enabled={props.modelUsageDisplayEnabled}
          onChange={props.onModelUsageDisplayChange}
        />
        <ConversationFollowUpSettings
          mode={props.conversationFollowUpMode}
          onChange={props.onConversationFollowUpModeChange}
        />
        <SkillTriggerSettings
          config={props.config}
          saving={props.savingSkillTrigger}
          onSave={props.onSaveSkillTriggerMode}
        />
        <SystemPromptVariantSettings
          config={props.config}
          saving={props.savingOrdinaryAgentPrompt}
          onSave={props.onSaveOrdinaryAgentSystemPromptVariant}
        />
      </div>
    </CapabilitySettingsSection>
  );
}

function ModelUsageDisplaySettings(props: {
  readonly enabled: boolean;
  readonly onChange: (enabled: boolean) => void;
}): React.ReactElement {
  return (
    <div className="capability-preference-row" aria-label="回答展示">
      <div className="capability-preference-copy">
        <strong>回答展示</strong>
        <span>模型 token 信息</span>
      </div>
      <button
        type="button"
        className="capability-toggle"
        aria-pressed={props.enabled}
        onClick={() => props.onChange(!props.enabled)}
      >
        {props.enabled ? "显示" : "隐藏"}
      </button>
    </div>
  );
}

function ConversationFollowUpSettings(props: {
  readonly mode: ConversationFollowUpMode;
  readonly onChange: (mode: ConversationFollowUpMode) => void;
}): React.ReactElement {
  return (
    <div className="capability-preference-row" aria-label="默认追加方式">
      <div className="capability-preference-copy">
        <strong>默认追加方式</strong>
        <span>运行中发送新消息时</span>
      </div>
      <SettingsSelectControl
        id="conversation-follow-up-mode"
        ariaLabel="默认追加方式"
        value={props.mode}
        options={[
          { value: "queue", label: "排队" },
          { value: "guide", label: "引导" },
        ]}
        onChange={(value) => props.onChange(value as ConversationFollowUpMode)}
      />
    </div>
  );
}

function SkillTriggerSettings(props: {
  readonly config?: ConfigResponse;
  readonly saving?: boolean;
  readonly onSave: (mode: SkillTriggerMode) => void;
}): React.ReactElement {
  const persistedMode = props.config?.skillTrigger?.mode ?? "keyword";
  const [draftMode, setDraftMode] = React.useState<SkillTriggerMode>(persistedMode);

  React.useEffect(() => {
    setDraftMode(persistedMode);
  }, [persistedMode]);

  const updateMode = (value: string): void => {
    const mode = skillTriggerModeFromValue(value);
    setDraftMode(mode);
    props.onSave(mode);
  };

  return (
    <div className="capability-preference-row" aria-busy={props.saving === true}>
      <div className="capability-preference-copy">
        <strong>Skills 触发方式</strong>
        <span>决定何时加载可用技能</span>
      </div>
      <SettingsSelectControl
        id="skill-trigger-mode"
        ariaLabel="Skills 触发方式"
        value={draftMode}
        options={[
          { value: "keyword", label: "显式/关键词触发" },
          { value: "model", label: "语义路由" },
        ]}
        onChange={updateMode}
        disabled={props.saving === true}
      />
    </div>
  );
}

function SystemPromptVariantSettings(props: {
  readonly config?: ConfigResponse;
  readonly saving?: boolean;
  readonly onSave: (variant: string) => Promise<void>;
}): React.ReactElement {
  const ordinaryAgent = props.config?.ordinaryAgent;
  const customPromptActive = ordinaryAgent?.isDefault === false;
  const persistedVariant = ordinaryAgent?.systemPromptVariant ?? "en";
  const [draftVariant, setDraftVariant] = React.useState(persistedVariant);

  React.useEffect(() => {
    setDraftVariant(persistedVariant);
  }, [persistedVariant]);

  const options = (ordinaryAgent?.variants?.length ?? 0) > 0
    ? ordinaryAgent!.variants!.map((variant) => ({
        value: variant.id,
        label: variant.label,
      }))
    : DEFAULT_SYSTEM_PROMPT_VARIANTS;

  const updateVariant = (value: string): void => {
    setDraftVariant(value);
    void props.onSave(value);
  };

  return (
    <div className="capability-preference-row" aria-busy={props.saving === true}>
      <div className="capability-preference-copy">
        <strong>提示词偏好</strong>
        <span>
          {customPromptActive
            ? "自定义提示词生效中，恢复默认后本偏好生效"
            : "选择默认系统提示词的版本与默认回答语言"}
        </span>
      </div>
      <SettingsSelectControl
        id="ordinary-agent-system-prompt-variant"
        ariaLabel="提示词偏好"
        value={draftVariant}
        options={options}
        onChange={updateVariant}
        disabled={customPromptActive || props.saving === true}
      />
    </div>
  );
}

const DEFAULT_SYSTEM_PROMPT_VARIANTS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "en", label: "English" },
  { value: "zh-v1", label: "简体中文" },
];

export function OrdinaryAgentPromptSettings(props: {
  readonly config?: ConfigResponse;
  readonly systemPrompt: string;
  readonly setSystemPrompt: (value: string) => void;
  readonly saving?: boolean;
  readonly onSave: (systemPrompt: string) => Promise<void>;
  readonly onReset: () => Promise<void>;
}): React.ReactElement {
  const maxChars = props.config?.ordinaryAgent?.maxSystemPromptChars ?? 20_000;
  const normalized = props.systemPrompt.trim();
  const persistedPrompt = props.config?.ordinaryAgent?.systemPrompt;
  const configLoaded = props.config?.ordinaryAgent !== undefined;
  const dirty = persistedPrompt === undefined ? normalized.length > 0 : normalized !== persistedPrompt.trim();
  const canSave = configLoaded && dirty && normalized.length > 0 && normalized.length <= maxChars && props.saving !== true;
  const canReset = props.saving !== true && (dirty || props.config?.ordinaryAgent?.isDefault !== true);
  const stateLabel = configLoaded
    ? dirty
      ? "未保存"
      : props.config?.ordinaryAgent?.isDefault === true
        ? "默认"
        : "自定义"
    : "加载中";
  return (
    <CapabilitySettingsSection
      icon={<MessageSquareText size={16} />}
      title="系统提示词"
      busy={props.saving === true}
      actions={
        <>
          <button
            type="button"
            className="model-info-save-button"
            onClick={() => void props.onReset()}
            disabled={!canReset}
          >
            <RotateCcw size={14} />
            <span>恢复默认</span>
          </button>
          <button
            type="button"
            className="model-info-save-button"
            onClick={() => void props.onSave(props.systemPrompt)}
            disabled={!canSave}
          >
            <Save size={14} />
            <span>{props.saving ? "保存中" : "保存"}</span>
          </button>
        </>
      }
    >
      <label className="ordinary-agent-prompt-field">
        Agent
        <textarea
          value={props.systemPrompt}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          maxLength={maxChars}
          onChange={(event) => props.setSystemPrompt(event.target.value)}
          placeholder="输入系统提示词"
        />
      </label>
      <div className="ordinary-agent-prompt-meta">
        <span>{normalized.length}/{maxChars}</span>
        <span>{stateLabel}</span>
      </div>
    </CapabilitySettingsSection>
  );
}


function skillTriggerModeFromValue(value: string): SkillTriggerMode {
  return value === "model" ? "model" : "keyword";
}
