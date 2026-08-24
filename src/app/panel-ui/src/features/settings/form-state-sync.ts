import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import {
  catalogRecordFromList,
  normalizeComposerToolConfirmationPolicy,
  normalizeVisibleAiMode,
  visibleConfigBaseUrl,
  visibleConfigLabel,
  type ComposerReasoningEffort,
  type ComposerToolConfirmationPolicy,
  type VisibleAiMode,
} from "./config-projection";
import type { AppState } from "../../workbench/state";
import type { McpServerForm, ModelForm, ToolForm } from "./components/types";
import type { ModelProviderModelCatalog } from "@panel-api/config";

type ModelOptionRef = {
  readonly id: string;
};

export type AppFormStateSyncOptions = {
  readonly app: AppState;
  readonly setAiMode: Dispatch<SetStateAction<VisibleAiMode>>;
  readonly setModelForm: Dispatch<SetStateAction<ModelForm>>;
  readonly setOrdinaryAgentSystemPrompt: Dispatch<SetStateAction<string>>;
  readonly setToolConfirmationPolicy: Dispatch<SetStateAction<ComposerToolConfirmationPolicy>>;
  readonly setToolForm: Dispatch<SetStateAction<ToolForm>>;
  readonly setMcpServerForm: Dispatch<SetStateAction<McpServerForm>>;
  readonly setModelCatalogs: Dispatch<SetStateAction<Record<string, ModelProviderModelCatalog>>>;
  readonly composerSelectedModelId: string | undefined;
  readonly setComposerSelectedModelId: Dispatch<SetStateAction<string | undefined>>;
  readonly persistedSelectedModelId: string;
  readonly modelOptions: readonly ModelOptionRef[];
  readonly composerReasoningEffort: ComposerReasoningEffort;
  readonly selectedModelSupportsReasoningEffort: boolean;
  readonly setComposerReasoningEffort: Dispatch<SetStateAction<ComposerReasoningEffort>>;
};

export function useAppFormStateSync(options: AppFormStateSyncOptions): void {
  const lastActiveProfileIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const activeProfileId = options.app.config?.config?.profileId;
    if (activeProfileId !== undefined && activeProfileId !== lastActiveProfileIdRef.current) {
      lastActiveProfileIdRef.current = activeProfileId;
      options.setAiMode(normalizeVisibleAiMode(options.app.config!.config!.defaultAiMode));
      options.setModelForm((previous) => {
        // 保存厂商配置本身就会激活该厂商；当表单已经指向新激活的 profile 时，
        // 用户正在编辑（例如刚输入的 API Key）不能被整体重置覆盖。
        if (previous.profileId === activeProfileId) return previous;
        return {
          profileId: activeProfileId,
          label: visibleConfigLabel(options.app.config!.config!),
          logoDataUrl: options.app.config!.config!.logoDataUrl ?? "",
          logoCleared: false,
          baseUrl: visibleConfigBaseUrl(options.app.config!.config!),
          protocolKind: options.app.config!.config!.protocolKind ?? "openai_compatible_chat_completions",
          model: options.app.config!.config!.model ?? "",
          apiKey: "",
          apiKeyCleared: false,
        };
      });
    }
    if (options.app.config?.ordinaryAgent?.systemPrompt !== undefined) {
      options.setOrdinaryAgentSystemPrompt(options.app.config.ordinaryAgent.systemPrompt);
    }
  }, [options.app.config]);

  useEffect(() => {
    if (options.app.config?.toolConfirmation?.policy !== undefined) {
      options.setToolConfirmationPolicy(
        normalizeComposerToolConfirmationPolicy(options.app.config.toolConfirmation.policy),
      );
    }
  }, [options.app.config?.toolConfirmation?.policy]);

  useEffect(() => {
    const webSearch = options.app.tools?.tools?.webSearch;
    if (webSearch !== undefined) {
      options.setToolForm({
        provider: webSearch.provider === "none" ? "model_builtin" : (webSearch.provider ?? "tavily"),
        apiKey: "",
        maxResults: String(webSearch.maxResults ?? 5),
        engineId: webSearch.engineId ?? "",
      });
    }
  }, [options.app.tools]);

  useEffect(() => {
    options.setMcpServerForm((previous) => {
      if (previous.serverId.length > 0) return previous;
      const firstServer = options.app.tools?.mcpCatalog?.[0];
      if (firstServer === undefined) return previous;
      return {
        ...previous,
        serverId: firstServer.serverId,
        label: firstServer.label,
        description: firstServer.description ?? "",
        transport: firstServer.transport,
        confirmationMode: firstServer.confirmationMode ?? "never",
        toolExposureMode: firstServer.toolExposureMode ?? "none",
        url: firstServer.url ?? "",
        headerSecretRefs: "",
        enabled: firstServer.enabled,
      };
    });
  }, [options.app.tools?.mcpCatalog]);

  useEffect(() => {
    if (options.app.config?.modelCatalogs !== undefined) {
      options.setModelCatalogs(catalogRecordFromList(options.app.config.modelCatalogs));
    }
  }, [options.app.config?.modelCatalogs]);

  useEffect(() => {
    if (
      options.composerSelectedModelId !== undefined &&
      !options.modelOptions.some((model) => model.id === options.composerSelectedModelId)
    ) {
      options.setComposerSelectedModelId(undefined);
    }
  }, [options.composerSelectedModelId, options.modelOptions, options.setComposerSelectedModelId]);

  useEffect(() => {
    if (
      options.composerSelectedModelId !== undefined &&
      options.composerSelectedModelId === options.persistedSelectedModelId
    ) {
      options.setComposerSelectedModelId(undefined);
    }
  }, [
    options.composerSelectedModelId,
    options.persistedSelectedModelId,
    options.setComposerSelectedModelId,
  ]);

  useEffect(() => {
    if (!options.selectedModelSupportsReasoningEffort && options.composerReasoningEffort !== "") {
      options.setComposerReasoningEffort("");
    }
  }, [
    options.composerReasoningEffort,
    options.selectedModelSupportsReasoningEffort,
    options.setComposerReasoningEffort,
  ]);
}
