import type { IncomingMessage, ServerResponse } from "node:http";

import type { PanelConfigSnapshotResponse } from "../../panel-api/config.js";
import { writeJson } from "../http-utils.js";
import {
  modelCapabilityProfilesPayload,
  modelProviderMarketPayload,
  productInfoPayload,
  type PanelConfigRouteRuntime,
} from "./config-route-payloads.js";
import { handlePanelMcpConfigRoute } from "./mcp-config-routes.js";
import { handlePanelModelConfigRoute } from "./model-config-routes.js";
import { handlePanelToolConfigRoute } from "./tool-config-routes.js";

export type { PanelConfigRouteRuntime } from "./config-route-payloads.js";

export async function handlePanelConfigRoute(
  runtime: PanelConfigRouteRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/api/config") {
    const config = await runtime.configCenter.getModelProviderConfig();
    const capabilities = await runtime.capabilityCenter.snapshot();
    const payload = {
      ok: true,
      status: "completed",
      config,
      profiles: await runtime.configCenter.listModelProviderProfiles(),
      modelProviderOrder: await runtime.configCenter.getModelProviderOrder(),
      modelCatalogs: await runtime.configCenter.listModelProviderModelCatalogs(),
      modelCapabilityProfiles: await modelCapabilityProfilesPayload(runtime),
      modelProviderMarket: modelProviderMarketPayload(),
      product: productInfoPayload(runtime),
      capabilities,
      informationAccess: await runtime.configCenter.getInformationAccessConfig(),
      commandShell: await runtime.configCenter.getCommandShellConfig(),
      toolConfirmation: await runtime.configCenter.getToolConfirmationConfig(),
      ordinaryAgent: await runtime.configCenter.getOrdinaryAgentPromptConfig(),
      skillTrigger: await runtime.configCenter.getSkillTriggerConfig(),
    } satisfies PanelConfigSnapshotResponse;
    writeJson(response, 200, payload);
    return true;
  }

  if (await handlePanelModelConfigRoute(runtime, request, response, url)) return true;
  if (await handlePanelToolConfigRoute(runtime, request, response, url)) return true;
  return handlePanelMcpConfigRoute(runtime, request, response, url);
}
