import { useMemo, useState } from "react";
import { useAppFormStateSync } from "./app-form-state-sync";
import type {
  ComposerReasoningEffort,
  ComposerToolConfirmationPolicy,
  VisibleAiMode,
} from "./app-config-projection";
import type { AppState } from "./app-state";
import type { ChatModelOption } from "./contracts/composer";
import type { McpServerForm, ModelForm, ToolForm } from "./components/settings-types";
import type { ModelProviderModelCatalog } from "./contracts/config";
import { modelOptionSupportsReasoningEffort, modelOptionsFromConfig, selectedModelOptionId } from "./model-options";

export type AppWorkbenchConfigState = {
  readonly aiMode: VisibleAiMode;
  readonly modelForm: ModelForm;
  readonly setModelForm: React.Dispatch<React.SetStateAction<ModelForm>>;
  readonly composerReasoningEffort: ComposerReasoningEffort;
  readonly setComposerReasoningEffort: React.Dispatch<React.SetStateAction<ComposerReasoningEffort>>;
  readonly toolConfirmationPolicy: ComposerToolConfirmationPolicy;
  readonly setToolConfirmationPolicy: React.Dispatch<React.SetStateAction<ComposerToolConfirmationPolicy>>;
  readonly composerSelectedModelId: string | undefined;
  readonly setComposerSelectedModelId: React.Dispatch<React.SetStateAction<string | undefined>>;
  readonly modelCatalogs: Record<string, ModelProviderModelCatalog>;
  readonly setModelCatalogs: React.Dispatch<React.SetStateAction<Record<string, ModelProviderModelCatalog>>>;
  readonly ordinaryAgentSystemPrompt: string;
  readonly setOrdinaryAgentSystemPrompt: React.Dispatch<React.SetStateAction<string>>;
  readonly toolForm: ToolForm;
  readonly setToolForm: React.Dispatch<React.SetStateAction<ToolForm>>;
  readonly mcpServerForm: McpServerForm;
  readonly setMcpServerForm: React.Dispatch<React.SetStateAction<McpServerForm>>;
  readonly modelOptions: readonly ChatModelOption[];
  readonly persistedSelectedModelId: string;
  readonly selectedModelId: string;
  readonly selectedModelSupportsReasoningEffort: boolean;
  readonly selectedModelContextWindowTokens?: number;
};

export function useAppWorkbenchConfigState(app: AppState): AppWorkbenchConfigState {
  const [aiMode, setAiMode] = useState<VisibleAiMode>("openai-responses");
  const [modelForm, setModelForm] = useState<ModelForm>({
    profileId: "",
    label: "",
    logoDataUrl: "",
    logoCleared: false,
    baseUrl: "",
    protocolKind: "openai_compatible_chat_completions",
    model: "",
    apiKey: "",
    apiKeyCleared: false,
  });
  const [composerReasoningEffort, setComposerReasoningEffort] = useState<ComposerReasoningEffort>("");
  const [toolConfirmationPolicy, setToolConfirmationPolicy] = useState<ComposerToolConfirmationPolicy>("prompt");
  const [composerSelectedModelId, setComposerSelectedModelId] = useState<string | undefined>(undefined);
  const [modelCatalogs, setModelCatalogs] = useState<Record<string, ModelProviderModelCatalog>>({});
  const [ordinaryAgentSystemPrompt, setOrdinaryAgentSystemPrompt] = useState("");
  const [toolForm, setToolForm] = useState<ToolForm>({
    provider: "tavily",
    apiKey: "",
    maxResults: "5",
    engineId: "",
  });
  const [mcpServerForm, setMcpServerForm] = useState<McpServerForm>({
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
    apiKeyHeaderName: "Authorization",
    apiKeyValue: "",
    customHeaderName: "",
    customHeaderValue: "",
    enabled: true,
  });

  const modelOptions = useMemo(() => modelOptionsFromConfig(app.config, modelCatalogs), [app.config, modelCatalogs]);
  const persistedSelectedModelId = useMemo(
    () => selectedModelOptionId(app.config, modelOptions),
    [app.config, modelOptions],
  );
  const selectedModelId = useMemo(() => {
    if (composerSelectedModelId !== undefined && modelOptions.some((model) => model.id === composerSelectedModelId)) {
      return composerSelectedModelId;
    }
    return persistedSelectedModelId;
  }, [composerSelectedModelId, modelOptions, persistedSelectedModelId]);
  const selectedModelSupportsReasoningEffort = useMemo(
    () => modelOptionSupportsReasoningEffort(app.config, selectedModelId),
    [app.config, selectedModelId],
  );
  const selectedModelContextWindowTokens = useMemo(
    () => modelOptions.find((model) => model.id === selectedModelId)?.capabilities?.contextWindowTokens,
    [modelOptions, selectedModelId],
  );

  useAppFormStateSync({
    app,
    setAiMode,
    setModelForm,
    setOrdinaryAgentSystemPrompt,
    setToolConfirmationPolicy,
    setToolForm,
    setMcpServerForm,
    setModelCatalogs,
    composerSelectedModelId,
    setComposerSelectedModelId,
    persistedSelectedModelId,
    modelOptions,
    composerReasoningEffort,
    selectedModelSupportsReasoningEffort,
    setComposerReasoningEffort,
  });

  return {
    aiMode,
    modelForm,
    setModelForm,
    composerReasoningEffort,
    setComposerReasoningEffort,
    toolConfirmationPolicy,
    setToolConfirmationPolicy,
    composerSelectedModelId,
    setComposerSelectedModelId,
    modelCatalogs,
    setModelCatalogs,
    ordinaryAgentSystemPrompt,
    setOrdinaryAgentSystemPrompt,
    toolForm,
    setToolForm,
    mcpServerForm,
    setMcpServerForm,
    modelOptions,
    persistedSelectedModelId,
    selectedModelId,
    selectedModelSupportsReasoningEffort,
    selectedModelContextWindowTokens,
  };
}
