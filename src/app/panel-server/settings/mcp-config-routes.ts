import type { IncomingMessage, ServerResponse } from "node:http";

import { listBuiltinMcpServerPresets } from "../../../domain/config/index.js";
import type { McpCatalogResponse } from "../../panel-api/tools.js";
import { PanelHttpError, readJsonBody, writeJson } from "../http-utils.js";
import {
  parseMcpEnvironmentRequest,
  parseMcpServerImport,
  parseMcpServerSecretValue,
  parseMcpServerUpdate,
} from "../request-parsers.js";
import {
  checkPanelMcpEnvironment,
  installPanelMcpEnvironment,
  listPanelMcpReferences,
  testPanelMcpServer,
} from "./mcp-management-service.js";
import {
  configCenterHttpError,
  invalidateCapabilityCache,
  type PanelConfigRouteRuntime,
} from "./config-route-payloads.js";

export async function handlePanelMcpConfigRoute(
  runtime: PanelConfigRouteRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/api/config/mcp") {
    const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
    const payload = {
      ok: true,
      status: "completed",
      catalog: capabilitySnapshot.mcpCatalog,
    } satisfies McpCatalogResponse;
    writeJson(response, 200, payload);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/config/mcp/presets") {
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      presets: listBuiltinMcpServerPresets(),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/mcp/import") {
    try {
      const imported = parseMcpServerImport(await readJsonBody(request));
      for (const server of imported) await runtime.configCenter.upsertMcpServer(server);
      invalidateCapabilityCache(runtime);
      const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        importedCount: imported.length,
        catalog: capabilitySnapshot.mcpCatalog,
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/config/mcp") {
    try {
      await runtime.configCenter.upsertMcpServer(parseMcpServerUpdate(await readJsonBody(request)));
      invalidateCapabilityCache(runtime);
      const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        catalog: capabilitySnapshot.mcpCatalog,
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/config/mcp/reload") {
    invalidateCapabilityCache(runtime);
    const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
    const connected = capabilitySnapshot.mcpCatalog
      .filter((server) => server.runtimeStatus === "connected").length;
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      connected,
      catalog: capabilitySnapshot.mcpCatalog,
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/mcp/environment-check") {
    const result = await checkPanelMcpEnvironment({
      ...parseMcpEnvironmentRequest(await readJsonBody(request)),
      managedMcpBinDirectory: runtime.productPaths.state.runtimeTools.mcp.bin,
    });
    writeJson(response, 200, {
      ok: result.ok,
      status: result.status,
      command: result.command,
      resolvedCommand: result.resolvedCommand,
      managed: result.managed,
      installable: result.installable,
      message: result.message,
      checkedAt: result.checkedAt,
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/mcp/environment-install") {
    const result = await installPanelMcpEnvironment({
      ...parseMcpEnvironmentRequest(await readJsonBody(request)),
      managedMcpBinDirectory: runtime.productPaths.state.runtimeTools.mcp.bin,
    });
    writeJson(response, 200, {
      ok: result.ok,
      status: result.status,
      command: result.command,
      resolvedCommand: result.resolvedCommand,
      managed: result.managed,
      installable: result.installable,
      message: result.message,
      checkedAt: result.checkedAt,
    });
    return true;
  }

  const mcpServerMatch = /^\/api\/config\/mcp\/([^/]+)$/.exec(url.pathname);
  if (request.method === "POST" && mcpServerMatch !== null) {
    try {
      await runtime.configCenter.upsertMcpServer({
        ...parseMcpServerUpdate(await readJsonBody(request)),
        serverId: decodeURIComponent(mcpServerMatch[1] ?? ""),
      });
      invalidateCapabilityCache(runtime);
      const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        catalog: capabilitySnapshot.mcpCatalog,
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  if (request.method === "DELETE" && mcpServerMatch !== null) {
    try {
      await runtime.configCenter.deleteMcpServer(decodeURIComponent(mcpServerMatch[1] ?? ""));
      invalidateCapabilityCache(runtime);
      const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        catalog: capabilitySnapshot.mcpCatalog,
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  const mcpToolsMatch = /^\/api\/config\/mcp\/([^/]+)\/tools$/.exec(url.pathname);
  if (request.method === "GET" && mcpToolsMatch !== null) {
    const serverId = decodeURIComponent(mcpToolsMatch[1] ?? "");
    const result = await testPanelMcpServer(runtime, serverId, { persistConnectionState: false });
    if (!result.ok) {
      throw new PanelHttpError(
        502,
        "mcp_list_tools_failed",
        result.errorSummary ?? "MCP 工具列表获取失败。",
      );
    }
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      serverId,
      errorCode: result.errorCode,
      toolCount: result.tools.length,
      tools: result.tools,
      catalog: result.catalog,
    });
    return true;
  }

  const mcpReferencesMatch = /^\/api\/config\/mcp\/([^/]+)\/references$/.exec(url.pathname);
  if (request.method === "GET" && mcpReferencesMatch !== null) {
    const serverId = decodeURIComponent(mcpReferencesMatch[1] ?? "");
    const result = await listPanelMcpReferences(runtime, serverId);
    writeJson(response, 200, {
      ok: result.ok,
      status: result.ok ? "completed" : "failed",
      serverId,
      errorCode: result.errorCode,
      errorSummary: result.errorSummary,
      promptCount: result.prompts.length,
      resourceCount: result.resources.length,
      resourceTemplateCount: result.resourceTemplates.length,
      prompts: result.prompts,
      resources: result.resources,
      resourceTemplates: result.resourceTemplates,
    });
    return true;
  }

  const mcpSecretMatch = /^\/api\/config\/mcp\/([^/]+)\/secrets$/.exec(url.pathname);
  if (request.method === "POST" && mcpSecretMatch !== null) {
    const serverId = decodeURIComponent(mcpSecretMatch[1] ?? "");
    try {
      const parsed = parseMcpServerSecretValue(await readJsonBody(request));
      const secret = await runtime.configCenter.writeMcpServerSecretValue({
        serverId,
        secretRef: parsed.secretRef,
        value: parsed.value,
      });
      invalidateCapabilityCache(runtime);
      const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        serverId,
        secret,
        catalog: capabilitySnapshot.mcpCatalog,
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  const mcpTestMatch = /^\/api\/config\/mcp\/([^/]+)\/test$/.exec(url.pathname);
  if (request.method === "POST" && mcpTestMatch !== null) {
    const serverId = decodeURIComponent(mcpTestMatch[1] ?? "");
    const result = await testPanelMcpServer(runtime, serverId);
    writeJson(response, 200, {
      ok: result.ok,
      status: result.ok ? "completed" : "failed",
      serverId,
      connectedAt: result.connectedAt,
      errorCode: result.errorCode,
      errorSummary: result.errorSummary,
      toolCount: result.tools.length,
      tools: result.tools,
      catalog: result.catalog,
    });
    return true;
  }

  return false;
}
