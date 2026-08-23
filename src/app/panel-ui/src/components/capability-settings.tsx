import React from "react";
import { Cpu, Globe, Link2, MessageSquareText, Plus, RotateCcw, Save, SlidersHorizontal, Trash2, X } from "lucide-react";
import type { ConfigResponse, ModelCapabilities, ModelProviderModelCatalog, SkillTriggerMode } from "../contracts/config";
import type { McpEnvironmentCheckResponse, McpReferenceResponse, ToolsResponse } from "../contracts/tools";
import { modelOptionsFromConfig } from "../model-options";
import type { ChatModelOption, ConversationFollowUpMode } from "../contracts/composer";
import { ModelOptionPicker } from "./model-option-picker";
import { SettingsSelectControl } from "./settings-select-control";
import type { McpServerForm, ToolForm } from "./settings-types";
import "./capability-settings.css";

const SAVED_API_KEY_MASK = "****************";
type McpCatalogServer = NonNullable<ToolsResponse["mcpCatalog"]>[number];
type ModelCapabilityTarget = {
  readonly key: string;
  readonly option: ChatModelOption;
  readonly profileId: string;
  readonly providerKind?: string;
  readonly model: string;
  readonly effectiveCapabilities?: ModelCapabilities;
  readonly overrideCapabilities?: ModelCapabilities;
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

export function BasicCapabilitiesSettings(props: {
  readonly config?: ConfigResponse;
  readonly modelCatalogs?: Readonly<Record<string, ModelProviderModelCatalog>>;
  readonly savingModel?: boolean;
  readonly onSaveModelCapabilities: (form: {
    readonly profileId: string;
    readonly providerKind?: string;
    readonly model: string;
    readonly capabilities: ModelCapabilities;
  }) => Promise<void>;
  readonly modelUsageDisplayEnabled: boolean;
  readonly onModelUsageDisplayChange: (enabled: boolean) => void;
  readonly conversationFollowUpMode: ConversationFollowUpMode;
  readonly onConversationFollowUpModeChange: (mode: ConversationFollowUpMode) => void;
  readonly tools?: ToolsResponse;
  readonly toolForm: ToolForm;
  readonly setToolForm: (form: ToolForm) => void;
  readonly savingTools?: boolean;
  readonly onSaveTools: (form: ToolForm) => void;
  readonly onSaveSkillTriggerMode: (mode: SkillTriggerMode) => void;
  readonly savingOrdinaryAgentPrompt?: boolean;
  readonly onSaveOrdinaryAgentSystemPromptVariant: (variant: string) => Promise<void>;
}): React.ReactElement {
  return (
    <div className="basic-capabilities-settings">
      <WebSearchSettings
        tools={props.tools}
        toolForm={props.toolForm}
        setToolForm={props.setToolForm}
        saving={props.savingTools}
        onSaveTools={props.onSaveTools}
      />
      <CapabilityGroup
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
            saving={props.savingTools}
            onSave={props.onSaveSkillTriggerMode}
          />
          <SystemPromptVariantSettings
            config={props.config}
            saving={props.savingOrdinaryAgentPrompt}
            onSave={props.onSaveOrdinaryAgentSystemPromptVariant}
          />
        </div>
      </CapabilityGroup>
      <ModelInformationSettings
        config={props.config}
        modelCatalogs={props.modelCatalogs}
        saving={props.savingModel}
        onSave={props.onSaveModelCapabilities}
      />
    </div>
  );
}

function CapabilityGroup(props: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly actions?: React.ReactNode;
  readonly busy?: boolean;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="cap-node" aria-label={props.title} aria-busy={props.busy === true}>
      <div className="cap-node-rail" aria-hidden="true">
        <span className="cap-node-dot">{props.icon}</span>
      </div>
      <div className="cap-node-card">
        <header className="cap-group-head">
          <div className="cap-group-heading">
            <h3>{props.title}</h3>
          </div>
          {props.actions !== undefined && <div className="cap-group-actions">{props.actions}</div>}
        </header>
        <div className="cap-group-body">{props.children}</div>
      </div>
    </section>
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
    <CapabilityGroup
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
        Ordinary Agent
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
    </CapabilityGroup>
  );
}

function ModelInformationSettings(props: {
  readonly config?: ConfigResponse;
  readonly modelCatalogs?: Readonly<Record<string, ModelProviderModelCatalog>>;
  readonly saving?: boolean;
  readonly onSave: (form: {
    readonly profileId: string;
    readonly providerKind?: string;
    readonly model: string;
    readonly capabilities: ModelCapabilities;
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
    selectedTarget?.effectiveCapabilities?.contextWindowTokens,
    selectedTarget?.effectiveCapabilities?.maxOutputTokens,
    selectedTarget?.effectiveCapabilities?.supportsVisionInput,
    selectedTarget?.effectiveCapabilities?.supportsReasoningEffort,
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
      capabilities: modelCapabilitiesFromDraft(draft, selectedTarget.overrideCapabilities),
    });
  };

  return (
    <CapabilityGroup
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
    </CapabilityGroup>
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
    const overrideCapabilities = modelCapabilityOverrideForTarget(config, option.profileId, option.modelId);
    return {
      key: option.id,
      option,
      profileId: option.profileId,
      model: option.modelId,
      ...(providerKind === undefined ? {} : { providerKind }),
      ...(option.capabilities === undefined ? {} : { effectiveCapabilities: option.capabilities }),
      ...(overrideCapabilities === undefined ? {} : { overrideCapabilities }),
    };
  });
}

function modelCapabilityOverrideForTarget(
  config: ConfigResponse | undefined,
  profileId: string,
  model: string
): ModelCapabilities | undefined {
  return config?.modelCapabilityProfiles?.find((item) => item.profileId === profileId && item.model === model)?.capabilities;
}

function modelCapabilityDraftFrom(capabilities: ModelCapabilities | undefined): ModelCapabilityDraft {
  return {
    contextWindowTokens: stringFromPositiveInteger(capabilities?.contextWindowTokens),
    maxOutputTokens: stringFromPositiveInteger(capabilities?.maxOutputTokens),
    supportsVisionInput: capabilities?.supportsVisionInput === true,
    supportsReasoningEffort: capabilities?.supportsReasoningEffort === true,
  };
}

function modelCapabilitiesFromDraft(
  draft: ModelCapabilityDraft,
  baseCapabilities: ModelCapabilities | undefined
): ModelCapabilities {
  return {
    ...baseCapabilities,
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
    draft.contextWindowTokens !== stringFromPositiveInteger(capabilities?.contextWindowTokens) ||
    draft.maxOutputTokens !== stringFromPositiveInteger(capabilities?.maxOutputTokens) ||
    draft.supportsVisionInput !== (capabilities?.supportsVisionInput === true) ||
    draft.supportsReasoningEffort !== (capabilities?.supportsReasoningEffort === true)
  );
}

function stringFromPositiveInteger(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? String(Math.floor(value)) : "";
}

function positiveIntegerFromString(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function McpServiceSettings(props: {
  readonly tools?: ToolsResponse;
  readonly mcpServerForm: McpServerForm;
  readonly setMcpServerForm: (form: McpServerForm) => void;
  readonly savingTools?: boolean;
  readonly onSaveMcpServer: (form?: McpServerForm) => Promise<void>;
  readonly onLoadMcpReferences: (serverId: string) => Promise<McpReferenceResponse>;
  readonly onImportMcpConfig: (config: string) => void;
  readonly onTestMcpServer: (serverId: string) => void;
  readonly onCheckMcpEnvironment: (form: Pick<McpServerForm, "command" | "commandLine">) => Promise<McpEnvironmentCheckResponse>;
  readonly onInstallMcpEnvironment: (form: Pick<McpServerForm, "command" | "commandLine">) => Promise<McpEnvironmentCheckResponse>;
  readonly onDeleteMcpServer: (serverId: string) => void;
  readonly onUpdateMcpTool: (serverId: string, toolName: string, enabled: boolean, autoApproved?: boolean) => void;
}): React.ReactElement {
  return (
    <div className="service-settings-stack">
      <McpServiceBoard
        tools={props.tools}
        form={props.mcpServerForm}
        setForm={props.setMcpServerForm}
        saving={props.savingTools}
        onSave={props.onSaveMcpServer}
        onLoadReferences={props.onLoadMcpReferences}
        onImport={props.onImportMcpConfig}
        onTest={props.onTestMcpServer}
        onCheckEnvironment={props.onCheckMcpEnvironment}
        onInstallEnvironment={props.onInstallMcpEnvironment}
        onDelete={props.onDeleteMcpServer}
        onUpdateTool={props.onUpdateMcpTool}
      />
    </div>
  );
}

function WebSearchSettings(props: {
  readonly tools?: ToolsResponse;
  readonly toolForm: ToolForm;
  readonly setToolForm: (form: ToolForm) => void;
  readonly saving?: boolean;
  readonly onSaveTools: (form: ToolForm) => void;
}): React.ReactElement {
  const provider = props.toolForm.provider;
  const configured =
    props.tools?.tools?.webSearch?.secretConfigured === true &&
    props.tools.tools.webSearch.provider === provider;
  const externalProvider = provider !== "model_builtin";
  const updateForm = (form: ToolForm, options: { readonly save?: boolean } = { save: true }): void => {
    props.setToolForm(form);
    if (options.save !== false) {
      props.onSaveTools(form);
    }
  };
  const saveSecretOnCommit = (apiKey: string): void => {
    if (apiKey.trim().length === 0) {
      return;
    }
    props.onSaveTools({ ...props.toolForm, apiKey });
  };
  return (
    <CapabilityGroup
      icon={<Globe size={16} />}
      title="网络搜索"
      busy={props.saving === true}
    >
      <div className="service-config-grid web-search-config-grid">
        <label>
          搜索服务
          <SettingsSelectControl
            id="web-search-provider"
            ariaLabel="搜索服务"
            value={props.toolForm.provider}
            options={[
              { value: "tavily", label: "Tavily" },
              { value: "exa", label: "Exa" },
              { value: "zai", label: "Z.AI" },
              { value: "metaso", label: "秘塔搜索" },
              { value: "google", label: "Google" },
              { value: "bing", label: "Bing" },
              { value: "model_builtin", label: "模型内置" },
            ]}
            onChange={(value) => updateForm({ ...props.toolForm, provider: value, apiKey: "" })}
          />
        </label>
        {externalProvider && (
          <label>
            {webSearchApiKeyLabel(provider)}
            <input
              type="password"
              value={props.toolForm.apiKey}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              onBlur={(event) => saveSecretOnCommit(event.currentTarget.value)}
              onChange={(event) => updateForm({ ...props.toolForm, apiKey: event.target.value }, { save: false })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              placeholder={configured ? SAVED_API_KEY_MASK : "请输入密钥"}
            />
          </label>
        )}
        {externalProvider && provider === "google" && (
          <label>
            Engine ID
            <input
              type="text"
              value={props.toolForm.engineId}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              onChange={(event) => updateForm({ ...props.toolForm, engineId: event.target.value })}
              placeholder="cx"
            />
          </label>
        )}
        {externalProvider && (
          <label className="web-search-max-results">
            结果数
            <input
              type="number"
              min={1}
              max={webSearchMaxResults(provider)}
              value={props.toolForm.maxResults}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              onChange={(event) => updateForm({ ...props.toolForm, maxResults: event.target.value })}
            />
          </label>
        )}
      </div>
    </CapabilityGroup>
  );
}

function webSearchApiKeyLabel(provider: string): string {
  if (provider === "exa") return "Exa Key";
  if (provider === "zai") return "Z.AI Key";
  if (provider === "metaso") return "秘塔 Key";
  if (provider === "google") return "Google Key";
  if (provider === "bing") return "Bing Key";
  return "Tavily Key";
}

function webSearchMaxResults(provider: string): number {
  if (provider === "google") return 10;
  if (provider === "tavily") return 20;
  if (provider === "exa") return 100;
  return 50;
}

function skillTriggerModeFromValue(value: string): SkillTriggerMode {
  return value === "model" ? "model" : "keyword";
}

function McpServiceBoard(props: {
  readonly tools?: ToolsResponse;
  readonly form: McpServerForm;
  readonly setForm: (form: McpServerForm) => void;
  readonly saving?: boolean;
  readonly onSave: (form?: McpServerForm) => Promise<void>;
  readonly onLoadReferences: (serverId: string) => Promise<McpReferenceResponse>;
  readonly onImport: (config: string) => void;
  readonly onTest: (serverId: string) => void;
  readonly onCheckEnvironment: (form: Pick<McpServerForm, "command" | "commandLine">) => Promise<McpEnvironmentCheckResponse>;
  readonly onInstallEnvironment: (form: Pick<McpServerForm, "command" | "commandLine">) => Promise<McpEnvironmentCheckResponse>;
  readonly onDelete: (serverId: string) => void;
  readonly onUpdateTool: (serverId: string, toolName: string, enabled: boolean, autoApproved?: boolean) => void;
}): React.ReactElement {
  const [importText, setImportText] = React.useState("");
  const [panelMode, setPanelMode] = React.useState<"overview" | "edit" | "add">("overview");
  const catalog = props.tools?.mcpCatalog ?? [];
  const selectedServer = panelMode === "add" || props.form.serverId.length === 0
    ? undefined
    : catalog.find((server) => server.serverId === props.form.serverId);
  const editingServer = panelMode === "edit" && selectedServer !== undefined;
  const addingServer = panelMode === "add";
  const saveServer = async (form: McpServerForm = props.form): Promise<void> => {
    const nextForm = formWithDerivedServerId(form);
    if (!canSaveMcpServerForm(nextForm)) return;
    try {
      props.setForm(nextForm);
      await props.onSave(nextForm);
      if (addingServer) {
        setPanelMode("edit");
      }
    } catch {
      // The settings controller already publishes the visible error.
    }
  };
  const saveAndTestServer = async (form: McpServerForm = props.form): Promise<void> => {
    const nextForm = formWithDerivedServerId(form);
    const serverId = effectiveMcpServerId(nextForm);
    if (serverId.length === 0 || !canTestMcpServerForm(nextForm)) return;
    try {
      props.setForm(nextForm);
      await props.onSave(nextForm);
      setPanelMode("edit");
      props.onTest(serverId);
    } catch {
      // The settings controller already publishes the visible error.
    }
  };
  const toggleServerEnabled = async (server: McpCatalogServer): Promise<void> => {
    const nextForm = {
      ...formFromMcpCatalog(server, props.form),
      enabled: !server.enabled,
    };
    try {
      props.setForm(nextForm);
      await saveServer(nextForm);
    } catch {
      // The settings controller already publishes the visible error.
    }
  };
  return (
    <section className="mcp-board">
      <header className="mcp-board-header">
        <div>
          <div className="mcp-board-title-row">
            <h3>已连接服务</h3>
            <span>{catalog.length}</span>
          </div>
        </div>
        <button
          type="button"
          className="mcp-connect-button"
          onClick={() => {
            props.setForm(emptyMcpServerForm());
            setPanelMode("add");
          }}
          disabled={props.saving}
        >
          <Plus size={14} />
          连接工具
        </button>
      </header>
      <div className="mcp-service-card-grid" aria-label="MCP 服务列表">
        {catalog.length === 0 ? (
          <div className="mcp-service-empty">暂无服务</div>
        ) : catalog.map((server) => {
          const selected = panelMode === "edit" && server.serverId === props.form.serverId;
          const serverStatus = mcpRuntimeStatusLabel(server.runtimeStatus ?? server.availability);
          const serverDescription = mcpServerCardDescription(server);
          return (
            <article
              key={server.serverId}
              className={`mcp-service-card ${selected ? "selected" : ""}`}
            >
              <button
                type="button"
                className="mcp-service-card-main"
                onClick={() => {
                  props.setForm(formFromMcpCatalog(server, props.form));
                  setPanelMode("edit");
                }}
              >
                <span className="mcp-service-card-top">
                  <span className="mcp-service-card-title">
                    <strong>{server.label}</strong>
                    <span>{transportLabel(server.transport)}</span>
                  </span>
                </span>
                {serverDescription !== undefined && (
                  <span className="mcp-service-card-description">{serverDescription}</span>
                )}
                <span className="mcp-service-card-footer">
                  {mcpServerCardFacts(server).map((fact) => (
                    <span key={fact}>{fact}</span>
                  ))}
                </span>
              </button>
              <span className="mcp-service-card-controls">
                <span className={`mcp-status-pill ${mcpStatusTone(server.runtimeStatus ?? server.availability)}`}>{serverStatus}</span>
                <button
                  type="button"
                  className="mcp-service-enable-toggle"
                  aria-pressed={server.enabled}
                  aria-label={`${server.enabled ? "停用" : "启用"} ${server.label}`}
                  onClick={() => void toggleServerEnabled(server)}
                  disabled={props.saving}
                >
                  <span aria-hidden="true" />
                </button>
              </span>
            </article>
          );
        })}
      </div>
      {editingServer && selectedServer !== undefined && (
        <McpServerPanel
          mode="edit"
          form={props.form}
          setForm={props.setForm}
          selectedServer={selectedServer}
          saving={props.saving}
          importText={importText}
          setImportText={setImportText}
          onImport={props.onImport}
          onSave={saveServer}
          onSaveAndTest={saveAndTestServer}
          onLoadReferences={props.onLoadReferences}
          onCheckEnvironment={props.onCheckEnvironment}
          onInstallEnvironment={props.onInstallEnvironment}
          onDelete={props.onDelete}
          onUpdateTool={props.onUpdateTool}
          onCancel={() => setPanelMode("overview")}
        />
      )}
      {addingServer && (
        <McpServerPanel
          mode="add"
          form={props.form}
          setForm={props.setForm}
          saving={props.saving}
          importText={importText}
          setImportText={setImportText}
          onImport={props.onImport}
          onSave={saveServer}
          onSaveAndTest={saveAndTestServer}
          onCheckEnvironment={props.onCheckEnvironment}
          onInstallEnvironment={props.onInstallEnvironment}
          onCancel={() => setPanelMode("overview")}
        />
      )}
    </section>
  );
}

function McpServerPanel(props: {
  readonly mode: "add" | "edit";
  readonly form: McpServerForm;
  readonly setForm: (form: McpServerForm) => void;
  readonly selectedServer?: McpCatalogServer;
  readonly saving?: boolean;
  readonly importText: string;
  readonly setImportText: (value: string) => void;
  readonly onImport: (config: string) => void;
  readonly onSave: (form?: McpServerForm) => Promise<void>;
  readonly onSaveAndTest: (form?: McpServerForm) => Promise<void>;
  readonly onLoadReferences?: (serverId: string) => Promise<McpReferenceResponse>;
  readonly onCheckEnvironment: (form: Pick<McpServerForm, "command" | "commandLine">) => Promise<McpEnvironmentCheckResponse>;
  readonly onInstallEnvironment: (form: Pick<McpServerForm, "command" | "commandLine">) => Promise<McpEnvironmentCheckResponse>;
  readonly onDelete?: (serverId: string) => void;
  readonly onUpdateTool?: (serverId: string, toolName: string, enabled: boolean, autoApproved?: boolean) => void;
  readonly onCancel: () => void;
}): React.ReactElement {
  const canSave = canSaveMcpServerForm(props.form);
  const canTest = canTestMcpServerForm(props.form);
  const editing = props.mode === "edit";
  const fieldPrefix = editing ? mcpFieldId("mcp-edit", props.form.serverId || "draft") : "mcp-add";
  const visibleTools = props.selectedServer?.tools ?? [];
  const exposedTools = props.selectedServer?.exposedTools ?? [];
  const hasSavedAuth = props.selectedServer?.authSecretRefCount !== undefined && props.selectedServer.authSecretRefCount > 0;
  const selectedStatus = props.selectedServer === undefined
    ? "未保存"
    : mcpRuntimeStatusLabel(props.selectedServer.runtimeStatus ?? props.selectedServer.availability);
  const selectedStatusTone = props.selectedServer === undefined
    ? "neutral"
    : mcpStatusTone(props.selectedServer.runtimeStatus ?? props.selectedServer.availability);
  const activeServer = props.selectedServer;
  const title = editing ? `编辑服务：${props.form.label || props.form.serverId}` : "连接工具";
  const [environmentCheck, setEnvironmentCheck] = React.useState<McpEnvironmentCheckResponse | undefined>();
  const [checkingEnvironment, setCheckingEnvironment] = React.useState(false);
  const [installingEnvironment, setInstallingEnvironment] = React.useState(false);
  const [referenceState, setReferenceState] = React.useState<McpReferenceLoadState>({ status: "idle" });
  const referenceRequestIdRef = React.useRef(0);
  React.useEffect(() => {
    setEnvironmentCheck(undefined);
  }, [props.form.transport, props.form.command, props.form.commandLine]);
  React.useEffect(() => {
    referenceRequestIdRef.current += 1;
    setReferenceState({ status: "idle" });
  }, [editing, props.selectedServer?.serverId]);
  const loadReferences = (): void => {
    if (
      !editing ||
      props.selectedServer === undefined ||
      props.onLoadReferences === undefined ||
      referenceState.status === "loading" ||
      referenceState.status === "ready"
    ) {
      return;
    }
    const requestId = referenceRequestIdRef.current + 1;
    referenceRequestIdRef.current = requestId;
    const serverId = props.selectedServer.serverId;
    setReferenceState({ status: "loading" });
    void props.onLoadReferences(serverId).then((references) => {
      if (referenceRequestIdRef.current === requestId) {
        setReferenceState({ status: references.ok === false ? "failed" : "ready", references });
      }
    }).catch(() => {
      if (referenceRequestIdRef.current === requestId) {
        setReferenceState({ status: "failed" });
      }
    });
  };
  const runEnvironmentCheck = async (): Promise<void> => {
    if (props.form.transport !== "stdio" || checkingEnvironment || installingEnvironment) return;
    setCheckingEnvironment(true);
    try {
      const result = await props.onCheckEnvironment(props.form);
      setEnvironmentCheck(result);
    } catch {
      setEnvironmentCheck({
        ok: false,
        status: "check_failed",
        message: "环境检测未完成。",
        checkedAt: new Date().toISOString(),
      });
    } finally {
      setCheckingEnvironment(false);
    }
  };
  const runEnvironmentInstall = async (): Promise<void> => {
    if (props.form.transport !== "stdio" || checkingEnvironment || installingEnvironment) return;
    setInstallingEnvironment(true);
    setEnvironmentCheck((previous) => ({
      ok: false,
      status: "installing",
      command: previous?.command,
      installable: previous?.installable,
      message: "安装中。",
      checkedAt: new Date().toISOString(),
    }));
    try {
      const result = await props.onInstallEnvironment(props.form);
      setEnvironmentCheck(result);
    } catch {
      setEnvironmentCheck({
        ok: false,
        status: "install_failed",
        message: "安装失败。",
        checkedAt: new Date().toISOString(),
      });
    } finally {
      setInstallingEnvironment(false);
    }
  };
  return (
    <div className="mcp-subpanel-overlay" role="dialog" aria-modal="true" aria-label={editing ? "编辑服务" : "连接工具"}>
      <div className="mcp-subpanel-backdrop" aria-hidden="true" onClick={props.onCancel} />
      <section className={`mcp-subpanel ${editing ? "edit" : "add"}`}>
        <header className="mcp-subpanel-header">
          <div className="mcp-subpanel-title">
            <h4>{title}</h4>
            {editing && <span className={`mcp-status-pill ${selectedStatusTone}`}>{selectedStatus}</span>}
          </div>
          <button type="button" className="settings-close-button" aria-label="关闭" onClick={props.onCancel}>
            <X size={16} />
          </button>
        </header>
        <div className="mcp-subpanel-body">
          {editing && props.selectedServer !== undefined && (
            <div className="mcp-status-strip">
              <span>{mcpRuntimeStatusLabel(props.selectedServer.runtimeStatus ?? props.selectedServer.availability)}</span>
              <span>{transportLabel(props.selectedServer.transport)}</span>
              {mcpServerCapabilityFacts(props.selectedServer).map((fact) => (
                <span key={fact}>{fact}</span>
              ))}
              {props.selectedServer.lastConnectedAt !== undefined && <span>最近连接：{props.selectedServer.lastConnectedAt}</span>}
            </div>
          )}
          <McpConnectionFields
            form={props.form}
            setForm={props.setForm}
            fieldPrefix={fieldPrefix}
            selectedServer={props.selectedServer}
            hasSavedAuth={hasSavedAuth}
            environmentCheck={environmentCheck}
            checkingEnvironment={checkingEnvironment}
            installingEnvironment={installingEnvironment}
            onCheckEnvironment={() => void runEnvironmentCheck()}
            onInstallEnvironment={() => void runEnvironmentInstall()}
            showConfirmationMode={editing}
          />
          {editing && (
            <section className="mcp-form-section">
              <details className="mcp-tool-authorization">
                <summary>
                  <span className="mcp-tool-authorization-copy">
                    <strong>工具授权</strong>
                  </span>
                  <span className="mcp-tool-authorization-actions">
                    <span className="mcp-tool-authorization-count">{exposedTools.length} / {visibleTools.length} 已启用</span>
                  </span>
                </summary>
                <div className="mcp-tool-list">
                  {activeServer === undefined || visibleTools.length === 0 ? (
                    <div className="capability-empty">保存并测试连接后选择工具</div>
                  ) : (
                    <div className="mcp-tool-auth-table">
                      <div className="mcp-tool-auth-header" aria-hidden="true">
                        <span>工具</span>
                        <span>启用</span>
                        <span>跳过确认</span>
                      </div>
                      {visibleTools.map((tool) => {
                        const enabled = isMcpToolEnabled(activeServer, tool.protocolName);
                        const autoApproved = isMcpToolAutoApproved(activeServer, tool.protocolName);
                        return (
                          <McpToolAuthorizationRow
                            key={tool.name}
                            title={mcpToolDisplayTitle(tool)}
                            detail={mcpToolDisplayDetail(tool)}
                            meta={mcpToolDisplayMeta(tool)}
                            enabled={enabled}
                            autoApproved={autoApproved}
                            onToggle={() => props.onUpdateTool?.(activeServer.serverId, tool.protocolName, !enabled)}
                            onToggleAutoApproval={() => props.onUpdateTool?.(
                              activeServer.serverId,
                              tool.protocolName,
                              enabled || !autoApproved,
                              !autoApproved
                            )}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              </details>
            </section>
          )}
          {editing && (
            <McpReferencePanel state={referenceState} onOpen={loadReferences} />
          )}
          {!editing && (
            <details className="mcp-advanced">
              <summary><span className="mcp-advanced-summary-label">高级设置</span></summary>
              <McpAdvancedOptions
                form={props.form}
                setForm={props.setForm}
                fieldPrefix={fieldPrefix}
                importText={props.importText}
                setImportText={props.setImportText}
                saving={props.saving}
                onImport={props.onImport}
              />
            </details>
          )}
        </div>
        <footer className={`mcp-subpanel-footer ${editing ? "split" : ""}`}>
          {editing && props.selectedServer !== undefined && (
            <button
              type="button"
              className="page-action-button danger icon-only"
              aria-label="删除服务"
              onClick={() => props.onDelete?.(props.selectedServer?.serverId ?? "")}
              disabled={props.saving}
            >
              <Trash2 size={14} />
            </button>
          )}
          <div className="mcp-subpanel-footer-actions">
            <button type="button" className="page-action-button" onClick={props.onCancel} disabled={props.saving}>
              {editing ? "关闭" : "取消"}
            </button>
            <button type="button" className="page-action-button" onClick={() => void props.onSave(props.form)} disabled={props.saving || !canSave}>
              <Save size={14} />
              保存
            </button>
            <button type="button" className="page-action-button primary" onClick={() => void props.onSaveAndTest(props.form)} disabled={props.saving || !canTest}>
              {editing && <Link2 size={14} />}
              {props.saving ? "保存中" : editing ? "测试连接" : "保存并测试"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

type McpReferenceLoadState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly references: McpReferenceResponse }
  | { readonly status: "failed"; readonly references?: McpReferenceResponse };

function McpReferencePanel(props: {
  readonly state: McpReferenceLoadState;
  readonly onOpen: () => void;
}): React.ReactElement {
  const references = props.state.status === "ready" || props.state.status === "failed"
    ? props.state.references
    : undefined;
  const totalCount =
    (references?.prompts.length ?? 0) +
    (references?.resources.length ?? 0) +
    (references?.resourceTemplates.length ?? 0);
  return (
    <section className="mcp-form-section">
      <details
        className="mcp-tool-authorization"
        onToggle={(event) => {
          if (event.currentTarget.open) {
            props.onOpen();
          }
        }}
      >
        <summary>
          <span className="mcp-tool-authorization-copy">
            <strong>提示与资源</strong>
          </span>
          <span className="mcp-tool-authorization-actions">
            <span className="mcp-tool-authorization-count">{mcpReferenceSummary(props.state, totalCount)}</span>
          </span>
        </summary>
        <div className="mcp-tool-list">
          {props.state.status === "idle" && <div className="capability-empty">展开后读取提示模板和资源</div>}
          {props.state.status === "loading" && <div className="capability-empty">读取中</div>}
          {props.state.status === "failed" && (
            <div className="capability-empty">读取失败，仅影响提示与资源列表</div>
          )}
          {props.state.status === "ready" && totalCount === 0 && (
            <div className="capability-empty">该服务未暴露提示或资源</div>
          )}
          {props.state.status === "ready" && totalCount > 0 && (
            <div className="mcp-reference-table">
              <div className="mcp-reference-header" aria-hidden="true">
                <span>类型</span>
                <span>名称</span>
                <span>说明</span>
              </div>
              {references?.prompts.map((prompt) => (
                <McpReferenceRow
                  key={`prompt:${prompt.name}`}
                  kind="提示"
                  title={prompt.title ?? prompt.name}
                  detail={prompt.description}
                />
              ))}
              {references?.resources.map((resource) => (
                <McpReferenceRow
                  key={`resource:${resource.uri}`}
                  kind="资源"
                  title={resource.title ?? resource.name}
                  detail={resource.description ?? resource.uri}
                />
              ))}
              {references?.resourceTemplates.map((template) => (
                <McpReferenceRow
                  key={`template:${template.uriTemplate}`}
                  kind="模板"
                  title={template.title ?? template.name}
                  detail={template.description ?? template.uriTemplate}
                />
              ))}
            </div>
          )}
        </div>
      </details>
    </section>
  );
}

function McpReferenceRow(props: {
  readonly kind: string;
  readonly title: string;
  readonly detail?: string;
}): React.ReactElement {
  return (
    <article className="mcp-reference-row">
      <span>{props.kind}</span>
      <strong>{props.title}</strong>
      <span>{props.detail ?? "无说明"}</span>
    </article>
  );
}

function mcpReferenceSummary(state: McpReferenceLoadState, totalCount: number): string {
  if (state.status === "loading") return "读取中";
  if (state.status === "failed") return "读取失败";
  if (state.status === "ready") return totalCount === 0 ? "未暴露" : `${totalCount} 项`;
  return "未读取";
}

function McpConnectionFields(props: {
  readonly form: McpServerForm;
  readonly setForm: (form: McpServerForm) => void;
  readonly fieldPrefix: string;
  readonly selectedServer?: McpCatalogServer;
  readonly hasSavedAuth?: boolean;
  readonly environmentCheck?: McpEnvironmentCheckResponse;
  readonly checkingEnvironment?: boolean;
  readonly installingEnvironment?: boolean;
  readonly onCheckEnvironment: () => void;
  readonly onInstallEnvironment: () => void;
  readonly showConfirmationMode?: boolean;
}): React.ReactElement {
  const authorizationHeaderPlaceholder = props.hasSavedAuth === true ? SAVED_API_KEY_MASK : "Bearer ...";
  const canCheckEnvironment = (props.form.commandLine.trim() || props.form.command.trim()).length > 0;
  const canInstallEnvironment =
    props.environmentCheck?.status === "not_found" &&
    props.environmentCheck.installable === true &&
    props.installingEnvironment !== true;
  return (
    <section className="mcp-form-section">
      <div className="mcp-form-grid mcp-identity-grid">
        <label htmlFor={`${props.fieldPrefix}-transport`}>
          类型
          <SettingsSelectControl
            id={`${props.fieldPrefix}-transport`}
            ariaLabel="类型"
            value={props.form.transport}
            options={[
              { value: "stdio", label: transportOptionLabel("stdio") },
              { value: "http", label: transportOptionLabel("http") },
            ]}
            onChange={(value) => props.setForm(formWithTransport(props.form, transportFromValue(value)))}
          />
        </label>
        <label htmlFor={`${props.fieldPrefix}-label`}>
          名称
          <input
            id={`${props.fieldPrefix}-label`}
            aria-label="名称"
            value={props.form.label}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(event) => props.setForm({ ...props.form, label: event.target.value })}
            placeholder="我的工具服务"
          />
        </label>
        <label className="mcp-description-field" htmlFor={`${props.fieldPrefix}-description`}>
          描述
          <input
            id={`${props.fieldPrefix}-description`}
            aria-label="描述"
            value={props.form.description}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(event) => props.setForm({ ...props.form, description: event.target.value })}
            placeholder="可选"
          />
        </label>
        {props.showConfirmationMode === true && (
          <McpConfirmationModeField
            form={props.form}
            setForm={props.setForm}
            fieldPrefix={props.fieldPrefix}
          />
        )}
      </div>
      <div className="mcp-form-grid mcp-transport-params-grid">
        {props.form.transport === "stdio" ? (
          <>
            <div className="mcp-connection-main mcp-command-field">
              <div className="mcp-field-title-row">
                <label htmlFor={`${props.fieldPrefix}-command`}>命令</label>
                <div className="mcp-field-actions">
                  {props.environmentCheck !== undefined && (
                    <McpEnvironmentCheckResult result={props.environmentCheck} />
                  )}
                  <button
                    type="button"
                    className="mcp-inline-action"
                    onClick={props.onCheckEnvironment}
                    disabled={props.checkingEnvironment === true || props.installingEnvironment === true || !canCheckEnvironment}
                  >
                    {props.checkingEnvironment === true ? "检测中" : "环境检测"}
                  </button>
                  {canInstallEnvironment && (
                    <button
                      type="button"
                      className="mcp-inline-action"
                      onClick={props.onInstallEnvironment}
                      disabled={!canCheckEnvironment}
                    >
                      安装
                    </button>
                  )}
                  {props.installingEnvironment === true && (
                    <button type="button" className="mcp-inline-action" disabled>
                      安装中
                    </button>
                  )}
                </div>
              </div>
              <input
                id={`${props.fieldPrefix}-command`}
                aria-label="命令"
                autoComplete="off"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                value={props.form.commandLine}
                onChange={(event) => props.setForm({ ...props.form, commandLine: event.target.value, command: "" })}
                placeholder={props.selectedServer?.commandSummary ?? "npx -y @modelcontextprotocol/server-filesystem ."}
              />
            </div>
            <label htmlFor={`${props.fieldPrefix}-args`}>
              参数
              <textarea
                id={`${props.fieldPrefix}-args`}
                aria-label="参数"
                value={props.form.args}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                onChange={(event) => props.setForm({ ...props.form, args: event.target.value })}
                placeholder="可选，每行一个参数"
              />
            </label>
            <label htmlFor={`${props.fieldPrefix}-env`}>
              环境变量
              <textarea
                id={`${props.fieldPrefix}-env`}
                aria-label="环境变量"
                value={props.form.envSecretRefs}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                onChange={(event) => props.setForm({ ...props.form, envSecretRefs: event.target.value })}
                placeholder="可选，每行一个变量名"
              />
            </label>
          </>
        ) : (
          <>
            <label className="mcp-url-field" htmlFor={`${props.fieldPrefix}-url`}>
              URL
              <input
                id={`${props.fieldPrefix}-url`}
                aria-label="URL"
                autoComplete="off"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                value={props.form.url}
                onChange={(event) => props.setForm({ ...props.form, url: event.target.value })}
                placeholder={props.selectedServer?.url ?? "https://example.com/mcp"}
              />
            </label>
            <label className="mcp-network-token-field" htmlFor={`${props.fieldPrefix}-authorization`}>
              Authorization 请求头（可选）
              <input
                id={`${props.fieldPrefix}-authorization`}
                aria-label="Authorization 请求头"
                type="password"
                value={props.form.bearerTokenValue}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                onChange={(event) => {
                  const token = event.target.value;
                  props.setForm({
                    ...props.form,
                    authMode: token.trim().length > 0 || props.hasSavedAuth === true ? "bearer" : "none",
                    authTouched: token.trim().length > 0,
                    bearerTokenValue: token,
                    apiKeyValue: "",
                    customHeaderValue: "",
                  });
                }}
                placeholder={authorizationHeaderPlaceholder}
              />
            </label>
          </>
        )}
      </div>
    </section>
  );
}

function McpEnvironmentCheckResult(props: {
  readonly result: McpEnvironmentCheckResponse;
}): React.ReactElement {
  return (
    <div className={`mcp-environment-result ${mcpEnvironmentTone(props.result.status)}`} role="status">
      <span className="mcp-environment-dot" aria-hidden="true" />
      <span>{mcpEnvironmentStatusText(props.result)}</span>
    </div>
  );
}

function McpAdvancedOptions(props: {
  readonly form: McpServerForm;
  readonly setForm: (form: McpServerForm) => void;
  readonly fieldPrefix: string;
  readonly importText: string;
  readonly setImportText: (value: string) => void;
  readonly saving?: boolean;
  readonly onImport: (config: string) => void;
}): React.ReactElement {
  return (
    <div className="mcp-advanced-content">
      <div className="mcp-advanced-row">
        <McpConfirmationModeField form={props.form} setForm={props.setForm} fieldPrefix={props.fieldPrefix} />
      </div>
      <div className="mcp-import-block">
        <div className="mcp-import-title-row">
          <label htmlFor={`${props.fieldPrefix}-import-json`}>导入 JSON</label>
          <button
            type="button"
            className="page-action-button"
            onClick={() => {
              props.onImport(props.importText);
              props.setImportText("");
            }}
            disabled={props.saving || props.importText.trim().length === 0}
          >
            导入配置
          </button>
        </div>
        <textarea
          id={`${props.fieldPrefix}-import-json`}
          aria-label="导入 JSON"
          value={props.importText}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(event) => props.setImportText(event.target.value)}
          placeholder='{"mcpServers":{"context7":{"url":"https://mcp.context7.com/mcp"}}}'
        />
      </div>
    </div>
  );
}

function McpConfirmationModeField(props: {
  readonly form: McpServerForm;
  readonly setForm: (form: McpServerForm) => void;
  readonly fieldPrefix: string;
}): React.ReactElement {
  return (
    <label className="mcp-confirmation-field" htmlFor={`${props.fieldPrefix}-confirmation-mode`}>
      <span>调用确认</span>
      <SettingsSelectControl
        id={`${props.fieldPrefix}-confirmation-mode`}
        ariaLabel="调用确认"
        value={props.form.confirmationMode}
        options={[
          { value: "never", label: "直接调用" },
          { value: "unsafe_only", label: "按工具声明确认" },
          { value: "always", label: "每次调用前确认" },
        ]}
        onChange={(value) => props.setForm({ ...props.form, confirmationMode: confirmationModeFromValue(value) })}
      />
    </label>
  );
}

function McpToolAuthorizationRow(props: {
  readonly title: string;
  readonly detail?: string;
  readonly meta: readonly string[];
  readonly enabled: boolean;
  readonly autoApproved: boolean;
  readonly onToggle: () => void;
  readonly onToggleAutoApproval: () => void;
}): React.ReactElement {
  return (
    <article className="mcp-tool-auth-row">
      <span className="mcp-tool-auth-copy">
        <strong>{props.title}</strong>
        {props.detail !== undefined && <span>{props.detail}</span>}
        {props.meta.length > 0 && (
          <span className="mcp-tool-auth-meta">
            {props.meta.map((item) => <span key={item}>{item}</span>)}
          </span>
        )}
      </span>
      <button
        type="button"
        className="mcp-tool-auth-state"
        aria-pressed={props.enabled}
        aria-label={`${props.enabled ? "停用" : "启用"} ${props.title}`}
        onClick={props.onToggle}
      >
        <span aria-hidden="true" />
      </button>
      <button
        type="button"
        className="mcp-tool-auth-state"
        aria-pressed={props.autoApproved}
        aria-label={`${props.autoApproved ? "关闭跳过确认" : "开启跳过确认"} ${props.title}`}
        onClick={props.onToggleAutoApproval}
      >
        <span aria-hidden="true" />
      </button>
    </article>
  );
}

function formFromMcpCatalog(server: NonNullable<ToolsResponse["mcpCatalog"]>[number], previous: McpServerForm): McpServerForm {
  const authMode = server.authSecretRefCount !== undefined && server.authSecretRefCount > 0 && isNetworkMcpTransport(server.transport)
    ? "bearer"
    : "none";
  return {
    ...previous,
    serverId: server.serverId,
    label: server.label,
    description: server.description ?? "",
    transport: server.transport,
    authMode,
    authTouched: false,
    confirmationMode: server.confirmationMode ?? "never",
    toolExposureMode: server.toolExposureMode ?? "none",
    enabledTools: server.enabledTools ?? [],
    autoApprovedTools: server.autoApprovedTools ?? [],
    command: "",
    args: "",
    commandLine: server.commandSummary ?? "",
    url: server.url ?? "",
    envSecretRefs: "",
    headerSecretRefs: "",
    bearerTokenSecretRef: "",
    bearerTokenValue: "",
    apiKeySecretRef: "",
    apiKeyHeaderName: "X-API-Key",
    apiKeyValue: "",
    customHeaderName: "",
    customHeaderValue: "",
    enabled: server.enabled,
  };
}

function emptyMcpServerForm(): McpServerForm {
  return {
    serverId: "",
    label: "",
    description: "",
    transport: "stdio",
    authMode: "none",
    authTouched: false,
    confirmationMode: "never",
    toolExposureMode: "none",
    enabledTools: [],
    autoApprovedTools: [],
    command: "",
    args: "",
    commandLine: "",
    url: "",
    envSecretRefs: "",
    headerSecretRefs: "",
    bearerTokenSecretRef: "",
    bearerTokenValue: "",
    apiKeySecretRef: "",
    apiKeyHeaderName: "X-API-Key",
    apiKeyValue: "",
    customHeaderName: "",
    customHeaderValue: "",
    enabled: true,
  };
}

function canSaveMcpServerForm(form: McpServerForm): boolean {
  return effectiveMcpServerId(form).length > 0;
}

function canTestMcpServerForm(form: McpServerForm): boolean {
  if (!canSaveMcpServerForm(form)) return false;
  if (!form.enabled) return false;
  if (form.transport === "stdio") {
    return form.commandLine.trim().length > 0 || form.command.trim().length > 0;
  }
  return form.url.trim().length > 0;
}

function formWithDerivedServerId(form: McpServerForm): McpServerForm {
  const serverId = effectiveMcpServerId(form);
  return form.serverId.trim().length > 0 || serverId.length === 0
    ? form
    : { ...form, serverId };
}

function effectiveMcpServerId(form: McpServerForm): string {
  const explicit = form.serverId.trim();
  if (explicit.length > 0) return explicit;
  const fromLabel = normalizeMcpServerId(form.label);
  if (fromLabel.length > 0) return fromLabel;
  return suggestMcpServerId(form.transport === "stdio" ? form.commandLine : form.url, form.transport);
}

function suggestMcpServerId(value: string, transport: McpServerForm["transport"]): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (transport !== "stdio") {
    try {
      const url = new URL(trimmed);
      const pathName = url.pathname.split("/").filter(Boolean).pop();
      return normalizeMcpServerId(pathName ?? url.hostname);
    } catch {
      return normalizeMcpServerId(trimmed);
    }
  }
  const parts = trimmed.split(/\s+/u).filter(Boolean);
  const packageName = [...parts].reverse().find((part) => !part.startsWith("-") && part !== "." && part !== "npx" && part !== "pnpm" && part !== "bunx");
  return normalizeMcpServerId(packageName ?? trimmed);
}

function normalizeMcpServerId(value: string): string {
  const withoutScope = value.replace(/^@/u, "").replace(/\//gu, "-");
  return withoutScope.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function mcpToolDisplayTitle(
  tool: NonNullable<ToolsResponse["mcpCatalog"]>[number]["tools"][number],
): string {
  const title = tool.displayName?.trim();
  if (title !== undefined && title.length > 0 && title !== "扩展工具") {
    return title;
  }
  return tool.protocolName || tool.name;
}

function mcpToolDisplayDetail(tool: NonNullable<ToolsResponse["mcpCatalog"]>[number]["tools"][number]): string | undefined {
  const description = tool.description?.trim() ?? tool.displayDescription?.trim();
  return description === undefined || description.length === 0 ? undefined : description;
}

function mcpToolDisplayMeta(tool: NonNullable<ToolsResponse["mcpCatalog"]>[number]["tools"][number]): readonly string[] {
  return [
    tool.operationLabel,
    tool.riskLabel,
    tool.requiresConfirmation === true ? "需确认" : "可直接调用",
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function mcpStatusTone(status: string): "success" | "danger" | "warning" | "info" | "neutral" {
  switch (status) {
    case "connected":
      return "success";
    case "error":
    case "unavailable":
      return "danger";
    case "connecting":
      return "warning";
    case "configured":
      return "info";
    default:
      return "neutral";
  }
}

function mcpServerCardFacts(server: NonNullable<ToolsResponse["mcpCatalog"]>[number]): readonly string[] {
  return [...mcpServerCapabilityFacts(server), mcpConfirmationModeLabel(server.confirmationMode)];
}

function mcpServerCapabilityFacts(server: NonNullable<ToolsResponse["mcpCatalog"]>[number]): readonly string[] {
  const facts = [`${server.tools.length} 个工具`];
  if (server.promptCount !== undefined) {
    facts.push(`${server.promptCount} 个提示`);
  }
  if (server.resourceCount !== undefined || server.resourceTemplateCount !== undefined) {
    facts.push(`${(server.resourceCount ?? 0) + (server.resourceTemplateCount ?? 0)} 个资源`);
  }
  return facts;
}

function mcpServerCardDescription(server: NonNullable<ToolsResponse["mcpCatalog"]>[number]): string | undefined {
  const description = server.description?.trim();
  return description === undefined || description.length === 0 ? undefined : description;
}

function mcpConfirmationModeLabel(mode?: "always" | "unsafe_only" | "never"): string {
  if (mode === "never") return "直接调用";
  if (mode === "always") return "每次确认";
  return "按声明确认";
}

function isMcpToolEnabled(server: NonNullable<ToolsResponse["mcpCatalog"]>[number], toolName: string): boolean {
  if (server.toolExposureMode === "all") {
    return true;
  }
  if (server.toolExposureMode === "none") {
    return false;
  }
  const enabledTools = server.enabledTools ?? [];
  return enabledTools.includes(toolName);
}

function isMcpToolAutoApproved(server: NonNullable<ToolsResponse["mcpCatalog"]>[number], toolName: string): boolean {
  const autoApprovedTools = server.autoApprovedTools ?? [];
  return autoApprovedTools.includes(toolName);
}

function transportLabel(transport: "stdio" | "http"): string {
  if (transport === "http") return "Streamable HTTP";
  return "stdio";
}

function transportOptionLabel(transport: "stdio" | "http"): string {
  if (transport === "http") return "Streamable HTTP";
  return "stdio";
}

function mcpFieldId(prefix: string, value: string): string {
  const safeValue = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safeValue.length > 0 ? `${prefix}-${safeValue}` : prefix;
}

function transportFromValue(value: string): "stdio" | "http" {
  return value === "http" ? "http" : "stdio";
}

function formWithTransport(form: McpServerForm, transport: McpServerForm["transport"]): McpServerForm {
  if (transport === form.transport) {
    return form;
  }
  if (transport === "stdio") {
    return {
      ...form,
      transport,
      url: "",
      authMode: "none",
      authTouched: false,
      bearerTokenValue: "",
      apiKeyValue: "",
      customHeaderValue: "",
    };
  }
  const hasToken = form.bearerTokenValue.trim().length > 0;
  return {
    ...form,
    transport,
    command: "",
    commandLine: "",
    args: "",
    envSecretRefs: "",
    authMode: hasToken || form.authMode !== "none" ? "bearer" : "none",
    authTouched: hasToken,
    apiKeyValue: "",
    customHeaderValue: "",
  };
}

function isNetworkMcpTransport(transport: "stdio" | "http"): boolean {
  return transport === "http";
}

function confirmationModeFromValue(value: string): "always" | "unsafe_only" | "never" {
  return value === "unsafe_only" || value === "never" ? value : "always";
}

function mcpRuntimeStatusLabel(status: string): string {
  switch (status) {
    case "connected":
      return "已连接";
    case "connecting":
      return "连接中";
    case "configured":
      return "已配置";
    case "disabled":
      return "已停用";
    case "error":
      return "连接失败";
    case "unavailable":
      return "缺少配置";
    default:
      return "已配置";
  }
}

function mcpEnvironmentTone(status: McpEnvironmentCheckResponse["status"]): "success" | "warning" | "danger" {
  if (status === "ready" || status === "installed") return "success";
  if (status === "check_failed" || status === "install_failed") return "danger";
  return "warning";
}

function mcpEnvironmentStatusText(result: McpEnvironmentCheckResponse): string {
  switch (result.status) {
    case "ready":
      return "已就绪";
    case "installed":
      return "已安装";
    case "installing":
      return "安装中";
    case "missing_command":
      return "未填写命令";
    case "check_failed":
      return "检测失败";
    case "install_failed":
      return "安装失败";
    case "unsupported":
      return "不支持安装";
    default:
      return result.command === undefined || result.command.trim().length === 0
        ? "缺少运行文件"
        : `缺少运行文件：${result.command}`;
  }
}
