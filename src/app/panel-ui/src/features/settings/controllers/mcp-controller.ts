import type React from "react";
import {
  checkMcpEnvironment,
  deleteMcpServer,
  fetchMcpReferences,
  importMcpServers,
  installMcpEnvironment,
  saveMcpServerSettings,
  testMcpServer,
  updateMcpToolState,
} from "../config-actions";
import type { McpServerForm } from "../components/types";
import type {
  McpEnvironmentCheckResponse,
  McpReferenceResponse,
  McpServerCatalogItem,
} from "@panel-api/tools";
import type { SettingsControllerContext } from "./controller-types";

export type McpSettingsController = {
  readonly saveMcpServer: (nextMcpServerForm?: McpServerForm) => Promise<void>;
  readonly loadMcpReferences: (serverId: string) => Promise<McpReferenceResponse>;
  readonly importMcpConfig: (config: string) => Promise<void>;
  readonly testMcpServer: (serverId: string) => Promise<void>;
  readonly checkMcpEnvironment: (
    form: Pick<McpServerForm, "command" | "commandLine">
  ) => Promise<McpEnvironmentCheckResponse>;
  readonly installMcpEnvironment: (
    form: Pick<McpServerForm, "command" | "commandLine">
  ) => Promise<McpEnvironmentCheckResponse>;
  readonly deleteMcpServer: (serverId: string) => Promise<void>;
  readonly updateMcpTool: (
    serverId: string,
    toolName: string,
    enabled: boolean,
    autoApproved?: boolean
  ) => Promise<void>;
};

export type McpSettingsControllerOptions = SettingsControllerContext & {
  readonly mcpServerForm: McpServerForm;
  readonly setMcpServerForm: React.Dispatch<React.SetStateAction<McpServerForm>>;
  readonly mcpToolSaveQueueRef: React.MutableRefObject<Promise<void>>;
  readonly mcpToolUpdateVersionRef: React.MutableRefObject<number>;
  readonly mcpToolCatalogDraftRef: React.MutableRefObject<readonly McpServerCatalogItem[] | undefined>;
  readonly setSavingTools: React.Dispatch<React.SetStateAction<boolean>>;
};

export function createMcpSettingsController(options: McpSettingsControllerOptions): McpSettingsController {
  async function saveMcpServer(nextMcpServerForm: McpServerForm = options.mcpServerForm): Promise<void> {
    try {
      const response = await saveMcpServerSettings(nextMcpServerForm);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          tools: {
            ...previous.tools,
            mcpCatalog: response.mcpCatalog ?? [],
          },
        }));
        options.setMcpServerForm((previous) => ({
          ...previous,
          serverId: nextMcpServerForm.serverId || previous.serverId,
          authTouched: false,
          bearerTokenValue: "",
          apiKeyValue: "",
          customHeaderValue: "",
        }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "MCP 服务保存失败。",
        }));
      }
      throw error;
    }
  }

  async function loadMcpReferences(serverId: string): Promise<McpReferenceResponse> {
    try {
      return await fetchMcpReferences(serverId);
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "MCP 提示与资源读取失败。",
        }));
      }
      return { ok: false, errorSummary: "MCP 提示与资源读取失败。", prompts: [], resources: [], resourceTemplates: [] };
    }
  }

  async function importMcpConfig(config: string): Promise<void> {
    options.setSavingTools(true);
    try {
      const response = await importMcpServers(config);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          tools: {
            ...previous.tools,
            mcpCatalog: response.mcpCatalog ?? [],
          },
          error: undefined,
        }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "MCP 配置导入失败。",
        }));
      }
    } finally {
      if (options.mountedRef.current) options.setSavingTools(false);
    }
  }

  async function testSelectedMcpServer(serverId: string): Promise<void> {
    options.setSavingTools(true);
    try {
      const response = await testMcpServer(serverId);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          tools: {
            ...previous.tools,
            mcpCatalog: response.mcpCatalog ?? [],
          },
          error: undefined,
        }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "MCP 连接测试失败。",
        }));
      }
    } finally {
      if (options.mountedRef.current) options.setSavingTools(false);
    }
  }

  async function checkSelectedMcpEnvironment(
    form: Pick<McpServerForm, "command" | "commandLine">
  ): Promise<McpEnvironmentCheckResponse> {
    try {
      return await checkMcpEnvironment(form);
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "MCP 本地运行环境检测失败。",
        }));
      }
      throw error;
    }
  }

  async function installSelectedMcpEnvironment(
    form: Pick<McpServerForm, "command" | "commandLine">
  ): Promise<McpEnvironmentCheckResponse> {
    try {
      return await installMcpEnvironment(form);
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "MCP 本地运行环境安装失败。",
        }));
      }
      throw error;
    }
  }

  async function deleteSelectedMcpServer(serverId: string): Promise<void> {
    options.setSavingTools(true);
    try {
      const response = await deleteMcpServer(serverId);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          tools: {
            ...previous.tools,
            mcpCatalog: response.mcpCatalog ?? [],
          },
          error: undefined,
        }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "MCP 服务删除失败。",
        }));
      }
    } finally {
      if (options.mountedRef.current) options.setSavingTools(false);
    }
  }

  async function updateMcpTool(serverId: string, toolName: string, enabled: boolean, autoApproved?: boolean): Promise<void> {
    const updateVersion = options.mcpToolUpdateVersionRef.current + 1;
    options.mcpToolUpdateVersionRef.current = updateVersion;
    const baseCatalog = options.mcpToolCatalogDraftRef.current ?? options.app.tools?.mcpCatalog ?? [];
    const nextPatch = mcpToolPatchFromCatalog(baseCatalog, serverId, toolName, enabled, autoApproved);
    const nextCatalog = updateLocalMcpCatalogServer(baseCatalog, serverId, nextPatch);
    options.mcpToolCatalogDraftRef.current = nextCatalog;
    if (options.mountedRef.current) {
      options.setApp((previous) => ({
        ...previous,
        tools: {
          ...previous.tools,
          mcpCatalog: nextCatalog,
        },
        error: undefined,
      }));
    }

    const save = options.mcpToolSaveQueueRef.current
      .catch(() => undefined)
      .then(() => updateMcpToolState({
        serverId,
        toolExposureMode: "selected",
        enabledTools: nextPatch.enabledTools,
        autoApprovedTools: nextPatch.autoApprovedTools,
      }));
    options.mcpToolSaveQueueRef.current = save.then(() => undefined, () => undefined);

    try {
      const response = await save;
      if (options.mountedRef.current && options.mcpToolUpdateVersionRef.current === updateVersion) {
        const responseCatalog = response.mcpCatalog ?? [];
        options.mcpToolCatalogDraftRef.current = responseCatalog;
        options.setApp((previous) => ({
          ...previous,
          tools: {
            ...previous.tools,
            mcpCatalog: responseCatalog,
          },
          error: undefined,
        }));
      }
    } catch (error) {
      if (options.mountedRef.current && options.mcpToolUpdateVersionRef.current === updateVersion) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "MCP 工具状态保存失败。",
        }));
      }
    }
  }

  return {
    saveMcpServer,
    loadMcpReferences,
    importMcpConfig,
    testMcpServer: testSelectedMcpServer,
    checkMcpEnvironment: checkSelectedMcpEnvironment,
    installMcpEnvironment: installSelectedMcpEnvironment,
    deleteMcpServer: deleteSelectedMcpServer,
    updateMcpTool,
  };
}

function updateLocalMcpCatalogServer(
  catalog: readonly McpServerCatalogItem[],
  serverId: string,
  patch: {
    readonly toolExposureMode: NonNullable<McpServerCatalogItem["toolExposureMode"]>;
    readonly enabledTools: readonly string[];
    readonly autoApprovedTools: readonly string[];
  }
): readonly McpServerCatalogItem[] {
  return catalog.map((server) => {
    if (server.serverId !== serverId) {
      return server;
    }
    const exposedTools = server.tools.filter((tool) =>
      isLocalMcpToolEnabled(patch.toolExposureMode, patch.enabledTools, tool.protocolName));
    return {
      ...server,
      toolExposureMode: patch.toolExposureMode,
      enabledTools: patch.enabledTools,
      autoApprovedTools: patch.autoApprovedTools,
      exposedTools,
    };
  });
}

function mcpToolPatchFromCatalog(
  catalog: readonly McpServerCatalogItem[],
  serverId: string,
  toolName: string,
  enabled: boolean,
  autoApproved?: boolean
): {
  readonly toolExposureMode: NonNullable<McpServerCatalogItem["toolExposureMode"]>;
  readonly enabledTools: readonly string[];
  readonly autoApprovedTools: readonly string[];
} {
  const currentServer = catalog.find((server) => server.serverId === serverId);
  const currentTools = new Set(currentServer?.enabledTools ?? []);
  const currentAutoApprovedTools = new Set(currentServer?.autoApprovedTools ?? []);
  if (enabled) {
    currentTools.add(toolName);
  } else {
    currentTools.delete(toolName);
    currentAutoApprovedTools.delete(toolName);
  }
  if (autoApproved !== undefined) {
    if (autoApproved) {
      currentAutoApprovedTools.add(toolName);
    } else {
      currentAutoApprovedTools.delete(toolName);
    }
  }
  return {
    toolExposureMode: "selected",
    enabledTools: [...currentTools],
    autoApprovedTools: [...currentAutoApprovedTools],
  };
}

function isLocalMcpToolEnabled(
  exposureMode: NonNullable<McpServerCatalogItem["toolExposureMode"]>,
  enabledTools: readonly string[],
  toolName: string
): boolean {
  if (exposureMode === "none") return false;
  if (exposureMode === "all") return true;
  return enabledTools.includes(toolName);
}
