import {
  ensureManagedMcpExecutable,
  installMcpExecutable,
  McpManager,
  resolveMcpExecutable,
  type McpReferenceInfo,
} from "../../../adapters/mcp/index.js";
import type { McpCachedReferenceInfo, McpCachedToolInfo, McpServerSettings } from "../../../domain/config/index.js";
import {
  canonicalNamespacedToolName,
  cloneToolInputSchema,
  cloneToolJsonSchema,
} from "../../../domain/tools/index.js";
import type { CapabilityCenter } from "../../capability/capability-center.js";
import type { ConfigCenter } from "../../config-center/index.js";
import { PanelHttpError } from "../http-utils.js";

const PANEL_MCP_CONNECT_TIMEOUT_MS = 8_000;

export type PanelMcpManagementRuntime = {
  readonly configCenter: ConfigCenter;
  readonly capabilityCenter: CapabilityCenter;
  readonly managedMcpBinDirectory: string;
};

export type PanelMcpToolSummary = {
  readonly name: string;
  readonly namespacedName: string;
  readonly title?: string;
  readonly description?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly openWorldHint?: boolean;
};

export type PanelMcpTestResult = {
  readonly ok: boolean;
  readonly connectedAt?: string;
  readonly errorCode?: string;
  readonly errorSummary?: string;
  readonly referenceErrorSummary?: string;
  readonly tools: readonly PanelMcpToolSummary[];
  readonly catalog: Awaited<ReturnType<CapabilityCenter["snapshot"]>>["mcpCatalog"];
};

export type PanelMcpReferenceResult = {
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly errorSummary?: string;
  readonly prompts: McpReferenceInfo["prompts"];
  readonly resources: McpReferenceInfo["resources"];
  readonly resourceTemplates: McpReferenceInfo["resourceTemplates"];
};

export type PanelMcpEnvironmentCheckResult = {
  readonly ok: boolean;
  readonly status: "ready" | "missing_command" | "not_found" | "installing" | "installed" | "unsupported" | "install_failed";
  readonly command?: string;
  readonly resolvedCommand?: string;
  readonly managed?: boolean;
  readonly installable?: boolean;
  readonly message: string;
  readonly checkedAt: string;
};

export async function checkPanelMcpEnvironment(input: {
  readonly commandLine?: string;
  readonly command?: string;
  readonly managedMcpBinDirectory?: string;
}): Promise<PanelMcpEnvironmentCheckResult> {
  const checkedAt = new Date().toISOString();
  const command = normalizeMcpEnvironmentCommand(input);
  if (command === undefined) {
    return {
      ok: false,
      status: "missing_command",
      message: "先填写本地命令。",
      checkedAt,
    };
  }

  const resolution = await ensureManagedMcpExecutable(
    command,
    process.env,
    { managedBinDirectory: input.managedMcpBinDirectory },
  );
  if (resolution.executable !== undefined) {
    return {
      ok: true,
      status: "ready",
      command,
      resolvedCommand: resolution.executable,
      managed: resolution.source === "product",
      installable: false,
      message: mcpExecutableReadyMessage(resolution.source),
      checkedAt,
    };
  }

  return {
    ok: false,
    status: "not_found",
    command,
    installable: isInstallableMcpEnvironmentCommand(command),
    message: `本地 MCP 运行环境缺少 ${command}。`,
    checkedAt,
  };
}

export async function installPanelMcpEnvironment(input: {
  readonly commandLine?: string;
  readonly command?: string;
  readonly managedMcpBinDirectory?: string;
}): Promise<PanelMcpEnvironmentCheckResult> {
  const checkedAt = new Date().toISOString();
  const command = normalizeMcpEnvironmentCommand(input);
  if (command === undefined) {
    return {
      ok: false,
      status: "missing_command",
      message: "先填写本地命令。",
      checkedAt,
    };
  }

  const result = await installMcpExecutable(
    command,
    process.env,
    { managedBinDirectory: input.managedMcpBinDirectory },
  );
  if (result.executable !== undefined && (result.status === "ready" || result.status === "installed")) {
    return {
      ok: true,
      status: result.status === "installed" ? "installed" : "ready",
      command,
      resolvedCommand: result.executable,
      managed: result.source === "product",
      installable: result.installable,
      message: mcpExecutableReadyMessage(result.source),
      checkedAt,
    };
  }

  return {
    ok: false,
    status: result.status === "unsupported" ? "unsupported" : result.status === "install_failed" ? "install_failed" : "not_found",
    command,
    installable: result.installable,
    message: result.errorSummary ?? `本地 MCP 运行环境缺少 ${command}。`,
    checkedAt,
  };
}

export async function testPanelMcpServer(
  runtime: PanelMcpManagementRuntime,
  serverId: string,
  options: { readonly persistConnectionState?: boolean } = {}
): Promise<PanelMcpTestResult> {
  const server = (await runtime.configCenter.listMcpServers()).find((item) => item.serverId === serverId);
  if (server === undefined) {
    throw new PanelHttpError(404, "mcp_server_not_found", "未找到 MCP 服务。");
  }
  if (!server.enabled) {
    return {
      ok: false,
      errorCode: "mcp_server_disabled",
      errorSummary: "MCP 服务已停用。",
      tools: [],
      catalog: (await runtime.capabilityCenter.snapshot()).mcpCatalog,
    };
  }
  if (!hasCompleteMcpRuntimeConfig(server)) {
    if (options.persistConnectionState !== false) {
      await runtime.configCenter.updateMcpServerConnectionState({
        serverId,
        errorSummary: "缺少连接配置。",
      });
      runtime.capabilityCenter.invalidate();
    }
    return {
      ok: false,
      errorCode: missingConfigCode(server),
      errorSummary: "缺少连接配置。",
      tools: [],
      catalog: (await runtime.capabilityCenter.snapshot()).mcpCatalog,
    };
  }
  const missingCommand = missingStdioCommand(server, runtime.managedMcpBinDirectory);
  if (missingCommand !== undefined) {
    const errorSummary = `MCP command not found: ${missingCommand}`;
    if (options.persistConnectionState !== false) {
      await runtime.configCenter.updateMcpServerConnectionState({ serverId, errorSummary });
      runtime.capabilityCenter.invalidate();
    }
    return {
      ok: false,
      errorCode: "command_not_found",
      errorSummary,
      tools: [],
      catalog: (await runtime.capabilityCenter.snapshot()).mcpCatalog,
    };
  }

  const mcpEnv = await runtime.configCenter.createMcpRuntimeEnvironment({
    servers: [server],
    baseEnv: await runtime.configCenter.createModelRuntimeEnvironment(),
  });
  const manager = new McpManager({
    servers: [{ ...server, enabled: true }],
    env: mcpEnv,
    managedBinDirectory: runtime.managedMcpBinDirectory,
    connectTimeoutMs: PANEL_MCP_CONNECT_TIMEOUT_MS,
  });
  try {
    await manager.connectAll();
    const snapshot = manager.getServerRuntimeSnapshots().find((item) => item.serverId === server.serverId);
    if (snapshot?.status === "connected") {
      const connectedAt = snapshot.lastConnectedAt ?? new Date().toISOString();
      const testedTools = manager.getServerTools(server.serverId).map((tool) => ({
        name: tool.name,
        namespacedName: canonicalNamespacedToolName(serverId, tool.name),
        title: tool.title,
        description: tool.description,
        readOnlyHint: tool.annotations?.readOnlyHint,
        destructiveHint: tool.annotations?.destructiveHint,
        openWorldHint: tool.annotations?.openWorldHint,
      }));
      let references: McpReferenceInfo | undefined;
      let referenceErrorSummary: string | undefined;
      try {
        references = await manager.getServerReferences(server.serverId);
      } catch (error) {
        referenceErrorSummary = panelMcpErrorMessage(
          error instanceof Error ? error.message : "MCP prompts/resources 获取失败。",
        );
      }
      if (options.persistConnectionState !== false) {
        await runtime.configCenter.updateMcpServerConnectionState({
          serverId,
          connectedAt,
          errorSummary: undefined,
          cachedTools: manager.getServerTools(server.serverId).map(cachedToolFromMcpTool),
          ...(references === undefined ? {} : {
            cachedReferences: cachedReferencesFromMcpReferenceInfo(references),
          }),
        });
        runtime.capabilityCenter.invalidate();
      }
      return {
        ok: true,
        connectedAt,
        tools: testedTools,
        ...(referenceErrorSummary === undefined ? {} : { referenceErrorSummary }),
        catalog: (await runtime.capabilityCenter.snapshot()).mcpCatalog,
      };
    }

    const errorSummary = snapshot?.errorSummary ?? "MCP 连接失败。";
    const errorCode = classifyMcpConnectionError(errorSummary, server);
    if (options.persistConnectionState !== false) {
      await runtime.configCenter.updateMcpServerConnectionState({ serverId, errorSummary });
      runtime.capabilityCenter.invalidate();
    }
    return {
      ok: false,
      errorCode,
      errorSummary,
      tools: [],
      catalog: (await runtime.capabilityCenter.snapshot()).mcpCatalog,
    };
  } finally {
    await manager.disconnectAll();
  }
}

function cachedToolFromMcpTool(tool: ReturnType<McpManager["getServerTools"]>[number]): McpCachedToolInfo {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: cloneToolInputSchema(tool.inputSchema),
    outputSchema: tool.outputSchema === undefined ? undefined : cloneToolJsonSchema(tool.outputSchema),
    annotations: tool.annotations === undefined ? undefined : { ...tool.annotations },
  };
}

function cachedReferencesFromMcpReferenceInfo(references: McpReferenceInfo): McpCachedReferenceInfo {
  return {
    prompts: references.prompts.map((prompt) => ({
      name: prompt.name,
      title: prompt.title,
      description: prompt.description,
      arguments: prompt.arguments?.map((argument) => ({
        name: argument.name,
        description: argument.description,
        required: argument.required,
      })),
    })),
    resources: references.resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      title: resource.title,
      description: resource.description,
      mimeType: resource.mimeType,
      size: resource.size,
    })),
    resourceTemplates: references.resourceTemplates.map((template) => ({
      uriTemplate: template.uriTemplate,
      name: template.name,
      title: template.title,
      description: template.description,
      mimeType: template.mimeType,
    })),
  };
}

export async function listPanelMcpReferences(
  runtime: PanelMcpManagementRuntime,
  serverId: string
): Promise<PanelMcpReferenceResult> {
  const server = (await runtime.configCenter.listMcpServers()).find((item) => item.serverId === serverId);
  if (server === undefined) {
    throw new PanelHttpError(404, "mcp_server_not_found", "未找到 MCP 服务。");
  }
  if (!server.enabled) {
    return {
      ok: false,
      errorCode: "mcp_server_disabled",
      errorSummary: "MCP 服务已停用。",
      prompts: [],
      resources: [],
      resourceTemplates: [],
    };
  }
  if (server.cachedReferences !== undefined && server.lastError === undefined) {
    return {
      ok: true,
      prompts: server.cachedReferences.prompts,
      resources: server.cachedReferences.resources,
      resourceTemplates: server.cachedReferences.resourceTemplates,
    };
  }
  if (!hasCompleteMcpRuntimeConfig(server)) {
    return {
      ok: false,
      errorCode: missingConfigCode(server),
      errorSummary: "缺少连接配置。",
      prompts: [],
      resources: [],
      resourceTemplates: [],
    };
  }
  const missingCommand = missingStdioCommand(server, runtime.managedMcpBinDirectory);
  if (missingCommand !== undefined) {
    return {
      ok: false,
      errorCode: "command_not_found",
      errorSummary: `MCP command not found: ${missingCommand}`,
      prompts: [],
      resources: [],
      resourceTemplates: [],
    };
  }

  const mcpEnv = await runtime.configCenter.createMcpRuntimeEnvironment({
    servers: [server],
    baseEnv: await runtime.configCenter.createModelRuntimeEnvironment(),
  });
  const manager = new McpManager({
    servers: [{ ...server, enabled: true }],
    env: mcpEnv,
    managedBinDirectory: runtime.managedMcpBinDirectory,
    connectTimeoutMs: PANEL_MCP_CONNECT_TIMEOUT_MS,
  });
  try {
    await manager.connectAll();
    const snapshot = manager.getServerRuntimeSnapshots().find((item) => item.serverId === server.serverId);
    if (snapshot?.status !== "connected") {
      const errorSummary = snapshot?.errorSummary ?? "MCP 连接失败。";
      return {
        ok: false,
        errorCode: classifyMcpConnectionError(errorSummary, server),
        errorSummary,
        prompts: [],
        resources: [],
        resourceTemplates: [],
      };
    }
    const references = await manager.getServerReferences(server.serverId);
    return {
      ok: true,
      prompts: references?.prompts ?? [],
      resources: references?.resources ?? [],
      resourceTemplates: references?.resourceTemplates ?? [],
    };
  } catch (error) {
    const errorSummary = panelMcpErrorMessage(error instanceof Error ? error.message : "MCP prompts/resources 获取失败。");
    return {
      ok: false,
      errorCode: classifyMcpConnectionError(errorSummary, server),
      errorSummary,
      prompts: [],
      resources: [],
      resourceTemplates: [],
    };
  } finally {
    await manager.disconnectAll();
  }
}

export function classifyMcpConnectionError(message: string, server: Pick<McpServerSettings, "transport" | "url" | "command">): string {
  const normalized = message.toLowerCase();
  if (server.transport === "http" && server.url !== undefined) {
    try {
      new URL(server.url);
    } catch {
      return "invalid_url";
    }
  }
  if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("did not connect") || normalized.includes("did not list tools")) {
    return "timeout";
  }
  if (
    normalized.includes("enoent") ||
    normalized.includes("not recognized") ||
    normalized.includes("command not found") ||
    normalized.includes("spawn") ||
    normalized.includes("找不到") ||
    normalized.includes("无法找到")
  ) {
    return "command_not_found";
  }
  if (normalized.includes("unauthorized") || normalized.includes("forbidden") || normalized.includes("401") || normalized.includes("403") || normalized.includes("api密钥无效") || normalized.includes("invalid api")) {
    return "auth_failed";
  }
  if (normalized.includes("list tools") || normalized.includes("listtools")) {
    return "list_tools_failed";
  }
  return "connection_failed";
}

function missingStdioCommand(server: McpServerSettings, managedBinDirectory: string): string | undefined {
  if (server.transport !== "stdio" || server.command === undefined) {
    return undefined;
  }
  return resolveMcpExecutable(
    server.command,
    process.env,
    { managedBinDirectory },
  ).executable !== undefined ? undefined : server.command;
}

function normalizeMcpEnvironmentCommand(input: {
  readonly commandLine?: string;
  readonly command?: string;
}): string | undefined {
  const commandLine = input.commandLine?.trim();
  if (commandLine !== undefined && commandLine.length > 0) {
    return firstCommandToken(commandLine);
  }
  const command = input.command?.trim();
  return command !== undefined && command.length > 0 ? command : undefined;
}

function firstCommandToken(value: string): string | undefined {
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "\\") {
      const next = value[index + 1];
      if (next === quote || next === "\\") {
        current += next;
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      return current.length > 0 ? current : undefined;
    }
    current += char;
  }
  return current.length > 0 ? current : undefined;
}

function isInstallableMcpEnvironmentCommand(command: string): boolean {
  const normalized = command.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/u, "");
  return ["uv", "uvx", "node", "npm", "npx", "pnpm", "pnpx", "bun", "bunx"].includes(pathBasename(normalized));
}

function pathBasename(value: string): string {
  const slashIndex = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return slashIndex < 0 ? value : value.slice(slashIndex + 1);
}

function mcpExecutableReadyMessage(source: ReturnType<typeof resolveMcpExecutable>["source"]): string {
  if (source === "product") {
    return "产品管理的 MCP 运行环境已就绪。";
  }
  if (source === "common") {
    return "已找到本机可用的 MCP 运行文件。";
  }
  if (source === "absolute") {
    return "已确认该运行文件可用。";
  }
  return "当前环境可以直接运行该命令。";
}

function missingConfigCode(server: McpServerSettings): string {
  if (server.transport === "http" && (server.url === undefined || server.url.trim().length === 0)) {
    return "missing_url";
  }
  if (server.transport === "stdio" && (server.command === undefined || server.command.trim().length === 0)) {
    return "missing_command";
  }
  return "missing_config";
}

function hasCompleteMcpRuntimeConfig(server: McpServerSettings): boolean {
  if (server.transport === "stdio") {
    return server.command !== undefined && server.command.trim().length > 0;
  }
  return server.url !== undefined && server.url.trim().length > 0;
}

function panelMcpErrorMessage(message: string): string {
  const normalized = message.trim();
  return normalized.length === 0 ? "MCP prompts/resources 获取失败。" : normalized;
}
