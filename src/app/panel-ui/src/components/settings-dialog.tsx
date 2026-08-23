import React, { useEffect, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  ChartColumn,
  CloudCog,
  Code2,
  Cpu,
  Database,
  FileText,
  Folder,
  Info,
  Monitor,
  Palette,
  Server,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type {
  ConfigResponse,
  ModelCapabilities,
  ModelProviderModelCatalog,
  SkillTriggerMode,
} from "../contracts/config";
import type { ConversationFollowUpMode } from "../contracts/composer";
import type { SkillDefinition } from "../contracts/skills";
import type { SubAgentDefinition } from "../contracts/sub-agents";
import type { McpEnvironmentCheckResponse, McpReferenceResponse, ToolsResponse } from "../contracts/tools";
import { AppearanceSettings } from "./appearance-settings";
import { BasicCapabilitiesSettings, OrdinaryAgentPromptSettings, McpServiceSettings } from "./capability-settings";
import { ModelSettings } from "./model-settings";
import type { McpServerForm, ModelForm, SettingsGroup, ToolForm } from "./settings-types";
import { SkillSettings } from "./skill-settings";
import { SubAgentSettings } from "./sub-agent-settings";
import { DeveloperToolStatistics, UsageStatisticsSettings, preloadUsageStatistics } from "./usage-statistics-settings";
import { ResponsivenessDiagnostics } from "./responsiveness-diagnostics";
import { RuntimeSettings } from "./runtime-settings";

export type { McpServerForm, ModelForm, SettingsGroup, ToolForm } from "./settings-types";

export function SettingsDialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly initialGroup?: SettingsGroup;
  readonly config?: ConfigResponse;
  readonly modelForm: ModelForm;
  readonly setModelForm: (form: ModelForm) => void;
  readonly ordinaryAgentSystemPrompt: string;
  readonly setOrdinaryAgentSystemPrompt: (value: string) => void;
  readonly modelUsageDisplayEnabled: boolean;
  readonly onModelUsageDisplayChange: (enabled: boolean) => void;
  readonly conversationFollowUpMode?: ConversationFollowUpMode;
  readonly onConversationFollowUpModeChange?: (mode: ConversationFollowUpMode) => void;
  readonly developerModeEnabled: boolean;
  readonly onDeveloperModeChange: (enabled: boolean) => void;
  readonly onSaveCommandShell: (kind: "auto" | "cmd" | "powershell" | "pwsh" | "bash" | "sh") => Promise<void> | void;
  readonly savingModel?: boolean;
  readonly savingWorkspace?: boolean;
  readonly savingOrdinaryAgentPrompt?: boolean;
  readonly onSaveModel: (form?: ModelForm) => Promise<void>;
  readonly onCreateCustomProfile: (form?: ModelForm) => Promise<void>;
  readonly onReorderModelProviders: (order: readonly string[]) => Promise<void>;
  readonly onDeleteModelProvider: (profileId: string, fallbackProfileId?: string) => Promise<void>;
  readonly onFetchModels: (profileId?: string) => Promise<ModelProviderModelCatalog | undefined>;
  readonly onSaveModelCatalog: (profileId: string, catalog: ModelProviderModelCatalog) => Promise<void>;
  readonly onSaveModelCapabilities: (form: {
    readonly profileId: string;
    readonly providerKind?: string;
    readonly model: string;
    readonly capabilities: ModelCapabilities;
  }) => Promise<void>;
  readonly onRevealModelApiKey: (profileId: string) => Promise<string | undefined>;
  readonly modelCatalogs?: Readonly<Record<string, ModelProviderModelCatalog>>;
  readonly skills: readonly SkillDefinition[];
  readonly subAgents: readonly SubAgentDefinition[];
  readonly onSaveOrdinaryAgentSystemPrompt: (systemPrompt: string) => Promise<void>;
  readonly onSaveOrdinaryAgentSystemPromptVariant: (variant: string) => Promise<void>;
  readonly onResetOrdinaryAgentSystemPrompt: () => Promise<void>;
  readonly tools?: ToolsResponse;
  readonly toolForm: ToolForm;
  readonly setToolForm: (form: ToolForm) => void;
  readonly mcpServerForm: McpServerForm;
  readonly setMcpServerForm: (form: McpServerForm) => void;
  readonly savingTools?: boolean;
  readonly onSaveTools: (form: ToolForm) => void;
  readonly onSaveSkillTriggerMode: (mode: SkillTriggerMode) => void;
  readonly onSaveMcpServer: (form?: McpServerForm) => Promise<void>;
  readonly onLoadMcpReferences: (serverId: string) => Promise<McpReferenceResponse>;
  readonly onImportMcpConfig: (config: string) => void;
  readonly onTestMcpServer: (serverId: string) => void;
  readonly onCheckMcpEnvironment: (form: Pick<McpServerForm, "command" | "commandLine">) => Promise<McpEnvironmentCheckResponse>;
  readonly onInstallMcpEnvironment: (form: Pick<McpServerForm, "command" | "commandLine">) => Promise<McpEnvironmentCheckResponse>;
  readonly onDeleteMcpServer: (serverId: string) => void;
  readonly onUpdateMcpTool: (serverId: string, toolName: string, enabled: boolean, autoApproved?: boolean) => void;
  readonly onRefreshSkills: () => void;
  readonly onRefreshSubAgents: () => void;
  readonly onUpdateSkill: (skill: Pick<SkillDefinition, "id" | "stateKey">, enabled: boolean) => void;
}): React.ReactElement | null {
  const [activeGroup, setActiveGroup] = useState<SettingsGroup>("models");
  useEffect(() => {
    if (props.open) {
      setActiveGroup(props.initialGroup ?? "models");
      preloadUsageStatistics();
    }
  }, [props.open, props.initialGroup]);

  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.open, props.onClose]);

  useEffect(() => {
    if (!props.open) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
    };
  }, [props.open]);

  useEffect(() => {
    if (!props.developerModeEnabled && DEVELOPER_SETTINGS_GROUPS.has(activeGroup)) {
      setActiveGroup("about");
    }
  }, [activeGroup, props.developerModeEnabled]);

  if (!props.open) return null;

  const visibleGroups = settingsGroupsForDeveloperMode(props.developerModeEnabled);
  const visibleActiveGroup = visibleGroups.some((group) => group.id === activeGroup)
    ? activeGroup
    : visibleGroups[0]?.id ?? "models";
  const activeInfo = visibleGroups.find((group) => group.id === visibleActiveGroup) ?? visibleGroups[0]!;
  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="设置">
      <button type="button" className="settings-backdrop" aria-label="关闭设置" onClick={props.onClose} />
      <section className="settings-dialog">
        <aside className="settings-sidebar">
          <button type="button" className="settings-close-button" onClick={props.onClose} aria-label="关闭">
            <X size={16} />
          </button>
          <nav aria-label="设置分组">
            {visibleGroups.map((group) => (
              <button
                type="button"
                key={group.id}
                className={group.id === visibleActiveGroup ? "active" : ""}
                onClick={() => setActiveGroup(group.id)}
                onFocus={() => {
                  if (group.id === "statistics" || group.id === "developer") preloadUsageStatistics();
                }}
                onMouseEnter={() => {
                  if (group.id === "statistics" || group.id === "developer") preloadUsageStatistics();
                }}
              >
                {group.icon}
                <span>{group.label}</span>
              </button>
            ))}
          </nav>
        </aside>
        <div className="settings-main">
          <header>
            <h2>{activeInfo.label}</h2>
          </header>
          <div className={`settings-content ${visibleActiveGroup === "models" ? "model-settings-content" : ""}`}>
            <div
              className="settings-panel-slot model-settings-slot"
              hidden={visibleActiveGroup !== "models"}
              aria-hidden={visibleActiveGroup !== "models"}
            >
              <ModelSettings
                active={visibleActiveGroup === "models"}
                config={props.config}
                modelForm={props.modelForm}
                setModelForm={props.setModelForm}
                saving={props.savingModel}
                onSave={props.onSaveModel}
                onCreateCustomProfile={props.onCreateCustomProfile}
                onReorderModelProviders={props.onReorderModelProviders}
                onDeleteModelProvider={props.onDeleteModelProvider}
                onFetchModels={props.onFetchModels}
                onSaveModelCatalog={props.onSaveModelCatalog}
                onRevealModelApiKey={props.onRevealModelApiKey}
                modelCatalogs={props.modelCatalogs}
              />
            </div>
            {visibleActiveGroup === "basicCapabilities" && (
              <BasicCapabilitiesSettings
                config={props.config}
                modelCatalogs={props.modelCatalogs}
                savingModel={props.savingModel}
                onSaveModelCapabilities={props.onSaveModelCapabilities}
                modelUsageDisplayEnabled={props.modelUsageDisplayEnabled}
                onModelUsageDisplayChange={props.onModelUsageDisplayChange}
                conversationFollowUpMode={props.conversationFollowUpMode ?? "queue"}
                onConversationFollowUpModeChange={props.onConversationFollowUpModeChange ?? (() => undefined)}
                tools={props.tools}
                toolForm={props.toolForm}
                setToolForm={props.setToolForm}
                savingTools={props.savingTools}
                onSaveTools={props.onSaveTools}
                onSaveSkillTriggerMode={props.onSaveSkillTriggerMode}
                savingOrdinaryAgentPrompt={props.savingOrdinaryAgentPrompt}
                onSaveOrdinaryAgentSystemPromptVariant={props.onSaveOrdinaryAgentSystemPromptVariant}
              />
            )}
            {visibleActiveGroup === "mcp" && (
              <McpServiceSettings
                tools={props.tools}
                mcpServerForm={props.mcpServerForm}
                setMcpServerForm={props.setMcpServerForm}
                savingTools={props.savingTools}
                onSaveMcpServer={props.onSaveMcpServer}
                onLoadMcpReferences={props.onLoadMcpReferences}
                onImportMcpConfig={props.onImportMcpConfig}
                onTestMcpServer={props.onTestMcpServer}
                onCheckMcpEnvironment={props.onCheckMcpEnvironment}
                onInstallMcpEnvironment={props.onInstallMcpEnvironment}
                onDeleteMcpServer={props.onDeleteMcpServer}
                onUpdateMcpTool={props.onUpdateMcpTool}
              />
            )}
            {visibleActiveGroup === "skills" && (
              <SkillSettings
                skills={props.skills}
                saving={props.savingTools}
                onRefreshSkills={props.onRefreshSkills}
                onUpdateSkill={props.onUpdateSkill}
              />
            )}
            {visibleActiveGroup === "subAgents" && (
              <SubAgentSettings
                subAgents={props.subAgents}
                refreshing={props.savingTools}
                onRefresh={props.onRefreshSubAgents}
              />
            )}
            {visibleActiveGroup === "workspace" && (
              <RuntimeSettings
                commandShell={props.config?.commandShell}
                savingCommandShell={props.savingWorkspace}
                onSaveCommandShell={props.onSaveCommandShell}
              />
            )}
            {visibleActiveGroup === "appearance" && <AppearanceSettings />}
            {visibleActiveGroup === "statistics" && <UsageStatisticsSettings />}
            {visibleActiveGroup === "developer" && (
              <>
                <div className="basic-capabilities-settings developer-prompt-settings">
                  <OrdinaryAgentPromptSettings
                    config={props.config}
                    systemPrompt={props.ordinaryAgentSystemPrompt}
                    setSystemPrompt={props.setOrdinaryAgentSystemPrompt}
                    saving={props.savingOrdinaryAgentPrompt}
                    onSave={props.onSaveOrdinaryAgentSystemPrompt}
                    onReset={props.onResetOrdinaryAgentSystemPrompt}
                  />
                </div>
                <ResponsivenessDiagnostics />
                <DeveloperToolStatistics />
              </>
            )}
            {visibleActiveGroup === "about" && (
              <AboutSettings
                config={props.config}
                developerModeEnabled={props.developerModeEnabled}
                onDeveloperModeChange={props.onDeveloperModeChange}
              />
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

const SETTINGS_GROUPS: readonly { readonly id: SettingsGroup; readonly label: string; readonly icon: React.ReactNode }[] = [
  { id: "models", label: "模型服务", icon: <CloudCog size={15} /> },
  { id: "basicCapabilities", label: "基础能力", icon: <SlidersHorizontal size={15} /> },
  { id: "mcp", label: "MCP 服务", icon: <Server size={15} /> },
  { id: "skills", label: "技能", icon: <FileText size={15} /> },
  { id: "subAgents", label: "Sub Agent", icon: <Bot size={15} /> },
  { id: "workspace", label: "运行环境", icon: <Database size={15} /> },
  { id: "appearance", label: "外观", icon: <Palette size={15} /> },
  { id: "statistics", label: "使用统计", icon: <ChartColumn size={15} /> },
  { id: "developer", label: "开发者选项", icon: <Code2 size={15} /> },
  { id: "about", label: "关于", icon: <Info size={15} /> },
];

const DEVELOPER_SETTINGS_GROUPS: ReadonlySet<SettingsGroup> = new Set(["developer"]);
// The current Synech surface has no persisted appearance contract yet.
// Do not expose a setting that cannot affect the production surface.
const TEMPORARILY_HIDDEN_SETTINGS_GROUPS: ReadonlySet<SettingsGroup> = new Set(["appearance"]);

export function settingsGroupsForDeveloperMode(enabled: boolean): typeof SETTINGS_GROUPS {
  return SETTINGS_GROUPS.filter((group) =>
    !TEMPORARILY_HIDDEN_SETTINGS_GROUPS.has(group.id)
    && (enabled || !DEVELOPER_SETTINGS_GROUPS.has(group.id)));
}

const DEVELOPER_MODE_GESTURE_CLICKS = 7;
const DEVELOPER_MODE_GESTURE_WINDOW_MS = 2_000;

export function AboutSettings(props: {
  readonly config?: ConfigResponse;
  readonly developerModeEnabled: boolean;
  readonly onDeveloperModeChange: (enabled: boolean) => void;
}): React.ReactElement {
  const product = props.config?.product;
  const productName = product?.name ?? "Synech";
  const version = product?.version ?? "未提供";
  const defaultEntry = product?.defaultEntry ?? "Synech / Panel";
  const runtimeModeLabel = product?.runtimeModeLabel?.trim();
  const configDirectory = product?.configDirectory ?? "未提供";
  const productHome = product?.productHome ?? "未提供";
  const developerModeGesture = useRef({ count: 0, startedAt: 0 });

  const handleDeveloperModeGesture = (): void => {
    const now = Date.now();
    const previous = developerModeGesture.current;
    const continuesGesture = previous.count > 0 && now - previous.startedAt <= DEVELOPER_MODE_GESTURE_WINDOW_MS;
    const count = continuesGesture ? previous.count + 1 : 1;
    developerModeGesture.current = { count, startedAt: continuesGesture ? previous.startedAt : now };
    if (count < DEVELOPER_MODE_GESTURE_CLICKS) return;
    developerModeGesture.current = { count: 0, startedAt: 0 };
    props.onDeveloperModeChange(!props.developerModeEnabled);
  };

  return (
    <div className="about-settings">
      <section className="settings-card about-product-card">
        <div className="about-product-header">
          <div className="about-product-main">
            <span className="about-product-mark" aria-hidden="true">
              <img src="/favicon.svg" alt="" />
            </span>
            <div>
              <h3>{productName}</h3>
              <div className="about-product-tags">
                <button
                  type="button"
                  className="about-product-version"
                  aria-label={`版本 ${version}`}
                  onClick={handleDeveloperModeGesture}
                >
                  v{version}
                </button>
                {props.developerModeEnabled && runtimeModeLabel !== undefined && runtimeModeLabel.length > 0 && (
                  <span className="about-product-runtime">{runtimeModeLabel}</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {props.developerModeEnabled && (
        <section className="about-fact-grid" aria-label="产品运行信息">
          <AboutFact icon={<Monitor size={16} />} label="默认入口" value={defaultEntry} />
          {runtimeModeLabel !== undefined && runtimeModeLabel.length > 0 ? (
            <AboutFact icon={<Cpu size={16} />} label="运行模式" value={runtimeModeLabel} />
          ) : (
            <AboutFact icon={<CheckCircle2 size={16} />} label="版本" value={version} />
          )}
        </section>
      )}

      {props.developerModeEnabled && <section className="settings-card about-path-card">
        <div className="settings-card-title-row">
          <h3>本机数据</h3>
          <span>仅此设备</span>
        </div>
        <div className="about-path-list" aria-label="本机数据目录">
          <AboutPath icon={<Folder size={16} />} label="产品目录" value={productHome} />
          <AboutPath icon={<Folder size={16} />} label="配置目录" value={configDirectory} />
        </div>
      </section>}
    </div>
  );
}

function AboutFact(props: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: string;
}): React.ReactElement {
  return (
    <div className="about-fact">
      <span className="about-fact-icon" aria-hidden="true">
        {props.icon}
      </span>
      <span className="about-fact-label">{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function AboutPath(props: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: string;
}): React.ReactElement {
  return (
    <div className="about-path-row">
      <span className="about-path-icon" aria-hidden="true">
        {props.icon}
      </span>
      <span className="about-path-label">{props.label}</span>
      <code>{props.value}</code>
    </div>
  );
}
