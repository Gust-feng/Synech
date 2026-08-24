import type { IncomingMessage, ServerResponse } from "node:http";

import type { ToolsResponse } from "../../panel-api/tools.js";
import { CapabilityCenter } from "../../capability/capability-center.js";
import { ConfigCenter } from "../../config-center/index.js";
import { readJsonBody, writeJson } from "../http-utils.js";
import {
  parseCommandShellUpdate,
  parseInformationAccessUpdate,
  parseOrdinaryAgentPromptUpdate,
  parseSkillTriggerUpdate,
  parseToolConfirmationUpdate,
  parseToolStateUpdate,
  parseWebSearchUpdate,
} from "../request-parsers.js";
import {
  configCenterHttpError,
  invalidateCapabilityCache,
  readPanelToolCatalog,
  type PanelConfigRouteRuntime,
  type PanelToolsConfig,
} from "./config-route-payloads.js";

export async function handlePanelToolConfigRoute(
  runtime: PanelConfigRouteRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/api/config/tools") {
    const tools: PanelToolsConfig = {
      webSearch: await runtime.configCenter.getWebSearchConfig(),
      catalog: await readPanelToolCatalog(runtime),
    };
    const payload = {
      ok: true,
      status: "completed",
      tools,
      capabilities: await runtime.capabilityCenter.snapshot(),
      informationAccess: await runtime.configCenter.getInformationAccessConfig(),
    } satisfies ToolsResponse & {
      readonly capabilities: Awaited<ReturnType<CapabilityCenter["snapshot"]>>;
      readonly informationAccess: Awaited<ReturnType<ConfigCenter["getInformationAccessConfig"]>>;
    };
    writeJson(response, 200, payload);
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/information-sources") {
    const informationAccess = await runtime.configCenter.updateInformationAccessConfig(
      parseInformationAccessUpdate(await readJsonBody(request)),
    );
    invalidateCapabilityCache(runtime);
    writeJson(response, 200, { ok: true, status: "completed", informationAccess });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/tools/web-search") {
    const webSearch = await runtime.configCenter.updateWebSearchConfig(
      parseWebSearchUpdate(await readJsonBody(request)),
    );
    invalidateCapabilityCache(runtime);
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      tools: { webSearch, catalog: await readPanelToolCatalog(runtime) },
      capabilities: await runtime.capabilityCenter.snapshot(),
      informationAccess: await runtime.configCenter.getInformationAccessConfig(),
    });
    return true;
  }

  const toolStateMatch = /^\/api\/config\/tools\/([^/]+)\/state$/.exec(url.pathname);
  if (request.method === "POST" && toolStateMatch !== null) {
    const toolName = decodeURIComponent(toolStateMatch[1] ?? "");
    await runtime.configCenter.updateToolState(
      parseToolStateUpdate(toolName, await readJsonBody(request)),
    );
    invalidateCapabilityCache(runtime);
    const tools: PanelToolsConfig = {
      webSearch: await runtime.configCenter.getWebSearchConfig(),
      catalog: await readPanelToolCatalog(runtime),
    };
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      tools,
      capabilities: await runtime.capabilityCenter.snapshot(),
      informationAccess: await runtime.configCenter.getInformationAccessConfig(),
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/config/sub-agents") {
    const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      subAgents: capabilitySnapshot.subAgentCatalog,
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/sub-agents/refresh") {
    invalidateCapabilityCache(runtime);
    const capabilitySnapshot = await runtime.capabilityCenter.snapshot();
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      subAgents: capabilitySnapshot.subAgentCatalog,
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/command-shell") {
    try {
      const commandShell = await runtime.configCenter.updateCommandShellConfig(
        parseCommandShellUpdate(await readJsonBody(request)),
      );
      invalidateCapabilityCache(runtime);
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        commandShell,
        capabilities: await runtime.capabilityCenter.snapshot(),
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/config/tool-confirmation") {
    try {
      const toolConfirmation = await runtime.configCenter.updateToolConfirmationConfig(
        parseToolConfirmationUpdate(await readJsonBody(request)),
      );
      invalidateCapabilityCache(runtime);
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        toolConfirmation,
        capabilities: await runtime.capabilityCenter.snapshot(),
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/config/ordinary-agent") {
    try {
      const ordinaryAgent = await runtime.configCenter.updateOrdinaryAgentPromptConfig(
        parseOrdinaryAgentPromptUpdate(await readJsonBody(request)),
      );
      writeJson(response, 200, { ok: true, status: "completed", ordinaryAgent });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/config/skill-trigger") {
    try {
      const skillTrigger = await runtime.configCenter.updateSkillTriggerConfig(
        parseSkillTriggerUpdate(await readJsonBody(request)),
      );
      invalidateCapabilityCache(runtime);
      writeJson(response, 200, {
        ok: true,
        status: "completed",
        skillTrigger,
        capabilities: await runtime.capabilityCenter.snapshot(),
      });
      return true;
    } catch (error) {
      throw configCenterHttpError(error);
    }
  }

  return false;
}
