import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import {
  PANEL_BRAND_LOGO_PATHNAME,
  createPanelHtml,
  readPanelBrandLogoAsset,
  readPanelStaticAsset,
} from "./panel-assets.js";
import {
  PanelHttpError,
  readJsonBody,
  writeHtml,
  writeJson,
  writePanelError,
} from "./http-utils.js";
import { handlePanelConfigRoute } from "./settings/config-routes.js";
import { handlePanelContextRoute } from "./workbench/context-routes.js";
import type { PanelServerOptions, StartedPanelServer } from "./types.js";
import { parseSkillStateRequest } from "./request-parsers.js";
import {
  cleanupPanelHostOwnedProcesses,
  createPanelHost,
  type PanelHost,
} from "./panel-host.js";
import { preparePanelStorageForStartup } from "./storage/panel-storage.js";
import { listPanelSkillSettings, refreshPanelSkillSettings, setPanelSkillEnabled } from "./settings/skill-service.js";
import { OrdinaryFeatureError } from "../ordinary-agent/contracts.js";
import { OrdinaryPanelCursorError } from "./ordinary/ordinary-agent-panel-projection.js";
import { handlePanelOrdinaryRoute } from "./ordinary/ordinary-routes.js";
import { agentMemoryHttpError, handlePanelAgentMemoryRoute } from "./ordinary/agent-memory-routes.js";
import { AgentNotesError } from "../agent-notes/index.js";
import { PathDependencyFeatureError } from "../path-dependencies/index.js";
import { SpaceFeatureError } from "../spaces/index.js";
import { handlePanelSpaceRoute, spaceFeatureHttpError } from "./spaces/space-routes.js";
import { handlePanelSpaceMetadataRoute } from "./spaces/space-metadata-routes.js";
import { WorkspaceFeatureError } from "../workspaces/index.js";
import { handlePanelWorkspaceRoute, workspaceFeatureHttpError } from "./spaces/workspace-routes.js";
import { PersonalKnowledgeError } from "../personal-knowledge/index.js";
import { WorkbenchCoordinationError } from "../workbench-coordination/index.js";
import { handlePanelPersonalKnowledgeRoute, personalKnowledgeHttpError } from "./storage/personal-knowledge-routes.js";
import { createPanelUsageStatistics } from "./workbench/panel-usage-statistics.js";
import { handlePanelDataRoute, dataMaintenanceHttpError } from "./storage/data-routes.js";
import { DataMaintenanceError } from "./storage/data-maintenance.js";
import { handlePanelManagedAssetRoute } from "./storage/managed-asset-routes.js";
import { handleWorkbenchProjectionRoute } from "./workbench/workbench-projection-routes.js";
import { initializeProductStorage, resolveProductPaths } from "../../platform/storage/index.js";
import {
  acquireProductHomeRuntimeLease,
  type ProductHomeRuntimeLease,
} from "./product-home-runtime-lease.js";
export type { PanelModelCatalogFetch, PanelProviderFetch, PanelServerOptions, StartedPanelServer } from "./types.js";

const PANEL_REQUEST_DRAIN_TIMEOUT_MS = 1_000;
const PANEL_RUNTIME_SHUTDOWN_TIMEOUT_MS = 30_000;

export type PanelServerCloseOptions = {
  /** Host-level graceful cleanup deadline; production callers use 30 seconds. */
  readonly runtimeCleanupTimeoutMs?: number;
};

export class PanelShutdownTimeoutError extends Error {
  readonly code = "panel_shutdown_timeout";

  constructor(readonly timeoutMs: number) {
    super(`Panel runtime cleanup did not finish within ${timeoutMs} ms.`);
    this.name = "PanelShutdownTimeoutError";
  }
}

export class PanelNonLoopbackHostError extends Error {
  readonly code = "panel_non_loopback_host" as const;

  constructor(readonly host: string) {
    super(`Synech v1 only accepts loopback Panel hosts; received: ${host}`);
    this.name = "PanelNonLoopbackHostError";
  }
}

export async function startLocalPanelServer(options: PanelServerOptions = {}): Promise<StartedPanelServer> {
  const host = normalizeLoopbackHost(options.host ?? "127.0.0.1");
  const productPaths = resolveProductPaths({ productHome: options.productHome });
  let runtime: PanelHost | undefined;
  let runtimeLease: ProductHomeRuntimeLease | undefined;
  try {
    runtimeLease = await acquireProductHomeRuntimeLease(productPaths.productHome);
    await initializeProductStorage(productPaths);
    await preparePanelStorageForStartup(productPaths);
    const createdRuntime = createPanelHost({
      configCenter: options.configCenter,
      providerFetch: options.providerFetch,
      modelCatalogFetch: options.modelCatalogFetch,
      directoryPicker: options.directoryPicker,
      contextAttachmentPicker: options.contextAttachmentPicker,
      restorePicker: options.restorePicker,
      externalResourceOpener: options.externalResourceOpener,
      additionalSkillRoots: options.additionalSkillRoots,
      skillRoots: options.skillRoots,
      additionalSubAgentRoots: options.additionalSubAgentRoots,
      subAgentRoots: options.subAgentRoots,
      ordinaryAgentDefinition: options.ordinaryAgentDefinition,
      agentDefinitions: options.agentDefinitions,
      processTerminator: options.processTerminator,
      productPaths,
    });
    runtime = createdRuntime;
    await createdRuntime.spaceFeature.ready();
    await createdRuntime.conversationLifecycle.ready();
    await createdRuntime.spaceConversationDeletion.ready();
    await createdRuntime.workspaceDeletion.ready();
    const server = createServer(createPanelRequestHandler(createdRuntime));
    const port = options.port ?? 9090;

    await listen(server, port, host);
    const address = server.address() as AddressInfo;
    let closing: Promise<void> | undefined;
    return {
      url: `http://${panelUrlHost(host)}:${address.port}/`,
      productHome: createdRuntime.productPaths.productHome,
      configDirectory: createdRuntime.configDirectory,
      close: () => closing ??= (async () => {
        await closePanelServer(server, createdRuntime);
        await runtimeLease!.release();
      })(),
    };
  } catch (startError) {
    const cleanupErrors: unknown[] = [];
    if (runtime !== undefined) {
      try {
        await disposePanelHostAfterFailedStart(runtime);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (runtimeLease !== undefined) {
      try {
        await runtimeLease.release();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [startError, ...cleanupErrors],
        "Panel server startup and cleanup both failed.",
      );
    }
    throw startError;
  }
}

export function normalizeLoopbackHost(value: string): string {
  const host = value.trim().toLowerCase();
  const ipv4Loopback = isIP(host) === 4 && host.split(".")[0] === "127";
  const ipv6Loopback = host === "::1" || host === "0:0:0:0:0:0:0:1";
  if (host !== "localhost" && !ipv4Loopback && !ipv6Loopback) {
    throw new PanelNonLoopbackHostError(value);
  }
  return host;
}

function panelUrlHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

function createPanelRequestHandler(runtime: PanelHost): (request: IncomingMessage, response: ServerResponse) => void {

  return (request, response) => {
    let requestJob: Promise<void>;
    requestJob = handlePanelRequest(runtime, request, response).catch((error) => {
      if (response.headersSent || response.writableEnded) {
        logUnhandledPanelRequestError(request, error);
        if (!response.writableEnded) response.end();
        return;
      }
      if (error instanceof PanelHttpError) {
        writePanelError(response, error);
        return;
      }
      if (error instanceof OrdinaryPanelCursorError) {
        writePanelError(response, new PanelHttpError(400, error.code, error.message));
        return;
      }
      if (error instanceof OrdinaryFeatureError) {
        writePanelError(response, ordinaryFeatureHttpError(error));
        return;
      }
      if (error instanceof AgentNotesError || error instanceof PathDependencyFeatureError) {
        writePanelError(response, agentMemoryHttpError(error));
        return;
      }
      if (error instanceof SpaceFeatureError) {
        writePanelError(response, spaceFeatureHttpError(error));
        return;
      }
      if (error instanceof WorkspaceFeatureError) {
        writePanelError(response, workspaceFeatureHttpError(error));
        return;
      }
      if (error instanceof PersonalKnowledgeError) {
        writePanelError(response, personalKnowledgeHttpError(error));
        return;
      }
      if (error instanceof WorkbenchCoordinationError) {
        writePanelError(response, workbenchCoordinationHttpError(error));
        return;
      }
      if (error instanceof DataMaintenanceError) {
        writePanelError(response, dataMaintenanceHttpError(error));
        return;
      }
      logUnhandledPanelRequestError(request, error);
      writePanelError(response, new PanelHttpError(500, "panel_internal_error", "面板请求失败。"));
    }).finally(() => {
      runtime.activeRequestJobs.delete(requestJob);
    });
    runtime.activeRequestJobs.add(requestJob);
  };
}

async function handlePanelRequest(
  runtime: PanelHost,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/") {
    writeHtml(response, createPanelHtml());
    return;
  }

  if (request.method === "GET" && url.pathname === PANEL_BRAND_LOGO_PATHNAME) {
    const asset = readPanelBrandLogoAsset();
    response.writeHead(200, {
      "content-type": asset.contentType,
      "cache-control": "no-store",
    });
    response.end(asset.body);
    return;
  }

  if (request.method === "GET") {
    const asset = readPanelStaticAsset(url.pathname);
    if (asset !== undefined) {
      response.writeHead(200, {
        "content-type": asset.contentType,
        "cache-control": "no-store",
      });
      response.end(asset.body);
      return;
    }
  }

  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      config: await runtime.configCenter.getModelProviderConfig(),
      informationAccess: await runtime.configCenter.getInformationAccessConfig(),
      configDirectory: runtime.configDirectory,
    });
    return;
  }

  if (runtime.isQuiescing) {
    throw new PanelHttpError(503, "panel_runtime_quiescing", "面板正在关闭，不能接受新的请求。");
  }


  if (await handlePanelConfigRoute({
    configCenter: runtime.configCenter,
    capabilityCenter: runtime.capabilityCenter,
    managedMcpBinDirectory: runtime.productPaths.state.runtimeTools.mcp.bin,
    configDirectory: runtime.configDirectory,
    productPaths: runtime.productPaths,
    modelCatalogFetch: runtime.modelCatalogFetch,
  }, request, response, url)) {
    return;
  }

  if (await handlePanelContextRoute({
    directoryPicker: runtime.directoryPicker,
    contextAttachmentPicker: runtime.contextAttachmentPicker,
    contextAttachmentMedia: runtime.contextAttachmentMedia,
    contextPreviewRoot: process.cwd(),
    ordinaryAgentFeature: runtime.ordinaryAgentFeature,
    resolveManagedAttachmentPath: runtime.resolveManagedAttachmentPath,
  }, request, response, url)) {
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/runtime/usage-statistics") {
    writeJson(response, 200, await createPanelUsageStatistics({ ordinaryAgentFeature: runtime.ordinaryAgentFeature }));
    return;
  }

  if (await handleWorkbenchProjectionRoute({
    projectionChanges: runtime.projectionChanges,
  }, request, response, url)) {
    return;
  }

  if (await handlePanelOrdinaryRoute({
    ordinaryAgentFeature: runtime.ordinaryAgentFeature,
    spaceFeature: runtime.spaceFeature,
    workspaceFeature: runtime.workspaceFeature,
    conversationLifecycle: runtime.conversationLifecycle,
    spaceConversationDeletion: runtime.spaceConversationDeletion,
    workspaceDeletion: runtime.workspaceDeletion,
    prepareOrdinaryRunBirth: runtime.prepareOrdinaryRunBirth,
  }, request, response, url)) {
    return;
  }

  if (await handlePanelAgentMemoryRoute({
    pathDependencyFeature: runtime.pathDependencyFeature,
    agentNotesFeature: runtime.agentNotesFeature,
    ordinaryAgentFeature: runtime.ordinaryAgentFeature,
    spaceFeature: runtime.spaceFeature,
    workspaceFeature: runtime.workspaceFeature,
    spaceConversationDeletion: runtime.spaceConversationDeletion,
    workspaceDeletion: runtime.workspaceDeletion,
  }, request, response, url)) {
    return;
  }

  if (await handlePanelSpaceMetadataRoute({
    spaceFeature: runtime.spaceFeature,
    workspaceFeature: runtime.workspaceFeature,
    ordinaryAgentFeature: runtime.ordinaryAgentFeature,
    workbenchCoordination: runtime.workbenchCoordination,
    ensureDefaultSpace: runtime.ensureDefaultSpace,
    flushSpaceKnowledgeSync: runtime.flushSpaceKnowledgeSync,
  }, request, response, url)) {
    return;
  }

  if (await handlePanelSpaceRoute({
    spaceFeature: runtime.spaceFeature,
    workspaceFeature: runtime.workspaceFeature,
    spaceConversationDeletion: runtime.spaceConversationDeletion,
    workbenchCoordination: runtime.workbenchCoordination,
    unlinkExternalReference: (referenceId) => runtime.spaceReferenceUnlink.unlink(referenceId),
    fileMutationCoordinator: runtime.fileMutationCoordinator,
    managedSpaceFolderRoot: runtime.managedSpaceFolderRoot,
    flushSpaceKnowledgeSync: runtime.flushSpaceKnowledgeSync,
    externalResourceOpener: runtime.externalResourceOpener,
    managedAssets: runtime.managedAssetFeature,
  }, request, response, url)) {
    return;
  }

  if (await handlePanelWorkspaceRoute({
    workspaceFeature: runtime.workspaceFeature,
    workbenchCoordination: runtime.workbenchCoordination,
  }, request, response, url)) {
    return;
  }

  if (await handlePanelManagedAssetRoute({
    ensureDefaultSpace: runtime.ensureDefaultSpace,
    managedAssets: runtime.managedAssetFeature,
  }, request, response, url)) {
    return;
  }

  if (await handlePanelPersonalKnowledgeRoute({
    personalKnowledgeFeature: runtime.personalKnowledgeFeature,
    ensureDefaultSpace: runtime.ensureDefaultSpace,
    knowledgeAssetsReady: runtime.knowledgeAssetsReady,
    knowledgeAssetRoot: runtime.knowledgeAssetRoot,
  }, request, response, url)) {
    return;
  }

  if (await handlePanelDataRoute({
    dataMaintenance: runtime.dataMaintenance,
  }, request, response, url)) {
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/skills") {
    writeJson(response, 200, {
      ok: true,
      skills: await listPanelSkillSettings(runtime),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/skills/refresh") {
    writeJson(response, 200, {
      ok: true,
      skills: await refreshPanelSkillSettings(runtime),
    });
    return;
  }

  const skillStateMatch = /^\/api\/skills\/([^/]+)\/state$/.exec(url.pathname);
  if (request.method === "POST" && skillStateMatch !== null) {
    await handleUpdateSkillStateRequest(runtime, decodeURIComponent(skillStateMatch[1] ?? ""), request, response);
    return;
  }

  writeJson(response, 404, {
    ok: false,
    status: "failed",
    error: {
      code: "not_found",
      message: "请求资源不存在。",
    },
  });
}

function workbenchCoordinationHttpError(error: WorkbenchCoordinationError): PanelHttpError {
  switch (error.code) {
    case "coordination_space_not_found":
    case "coordination_reference_not_found":
    case "workspace_not_found":
    case "space_not_found":
      return new PanelHttpError(404, error.code, error.message);
    case "coordination_workspace_directory_required":
      return new PanelHttpError(400, error.code, error.message);
    case "coordination_reference_kind_invalid":
    case "conversation_deletion_in_progress":
    case "conversation_owner_conflict":
    case "workspace_deletion_in_progress":
    case "workspace_not_available":
    case "space_deletion_in_progress":
    case "background_process_stop_pending":
      return new PanelHttpError(409, error.code, error.message);
    case "coordination_attach_compensation_failed":
      return new PanelHttpError(500, error.code, error.message);
  }
}

async function handleUpdateSkillStateRequest(
  runtime: PanelHost,
  skillId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const input = parseSkillStateRequest(await readJsonBody(request));
  let updated: boolean;
  try {
    updated = await setPanelSkillEnabled(runtime, skillId, input.enabled, input.stateKey);
  } catch (error) {
    throw new PanelHttpError(
      400,
      "ambiguous_skill_state",
      error instanceof Error ? error.message : "技能来源不明确，无法更新状态。"
    );
  }
  if (!updated) {
    throw new PanelHttpError(501, "skill_state_unavailable", "当前环境没有可用的技能状态存储。");
  }
  writeJson(response, 200, {
    ok: true,
    skills: await listPanelSkillSettings(runtime),
  });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function closePanelServer(
  server: Server,
  runtime: PanelHost,
  options: PanelServerCloseOptions = {},
): Promise<void> {
  const runtimeCleanupTimeoutMs = resolveRuntimeCleanupTimeout(options.runtimeCleanupTimeoutMs);
  // Enter quiescing before any asynchronous shutdown work. Ordinary terminal
  // callbacks may still run while active jobs converge, but they must not
  // admit the next queued conversation run.
  runtime.isQuiescing = true;
  const ordinaryDisposal = runtime.ordinaryAgentFeature.release();
  void ordinaryDisposal.catch(() => undefined);
  let serverCloseError: unknown;
  const serverClosed = close(server).catch((error: unknown) => {
    serverCloseError = error;
  });

  const runtimeCleanup = (async () => {
    await cleanupPanelHostOwnedProcesses(runtime);
    await waitForPanelRequestIdle(server, runtime);
    await releasePanelHostResources(runtime, ordinaryDisposal);
  })();
  // A forced timeout may return while a broken provider promise is still
  // pending. Own its eventual rejection so shutdown never creates an unhandled
  // promise rejection.
  void runtimeCleanup.catch(() => undefined);
  let shutdownTimeoutError: PanelShutdownTimeoutError | undefined;
  try {
    const cleaned = await settleWithin([runtimeCleanup], runtimeCleanupTimeoutMs);
    if (cleaned) {
      await runtimeCleanup;
    } else {
      shutdownTimeoutError = new PanelShutdownTimeoutError(runtimeCleanupTimeoutMs);
    }
  } finally {
    // SSE and other long-lived responses are not active request jobs after
    // their handlers install listeners. A timeout still closes the transport.
    server.closeAllConnections();
    await serverClosed;
  }

  if (shutdownTimeoutError !== undefined) {
    throw shutdownTimeoutError;
  }
  if (serverCloseError !== undefined) {
    throw serverCloseError;
  }
}

async function disposePanelHostAfterFailedStart(runtime: PanelHost): Promise<void> {
  runtime.isQuiescing = true;
  const cleanupResults = await Promise.allSettled([
    cleanupPanelHostOwnedProcesses(runtime),
    releasePanelHostResources(runtime),
  ]);
  const cleanupErrors = cleanupResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Panel runtime cleanup after failed startup did not complete.");
  }
}

/** Releases every resource owned by the Panel composition root, without server transport cleanup. */
export async function releasePanelHostResources(
  runtime: PanelHost,
  ordinaryDisposal: Promise<void> = runtime.ordinaryAgentFeature.release(),
): Promise<void> {
  runtime.isQuiescing = true;
  const errors: unknown[] = [];
  await captureCleanupError(errors, () => ordinaryDisposal);
  await captureCleanupError(errors, () => runtime.pathDependencyFeature.release());
  await captureCleanupError(errors, async () => runtime.releaseProjectionChanges());
  await captureCleanupError(errors, () => releaseWorkbenchStorage(runtime));
  await captureCleanupError(errors, () => runtime.releaseAgentSessionStorage());
  await captureCleanupError(errors, () => runtime.toolOutputStore.close?.() ?? runtime.toolOutputStore.clear());
  if (errors.length > 0) throw new AggregateError(errors, "Panel runtime resource cleanup did not complete.");
}

async function captureCleanupError(errors: unknown[], operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
}

async function releaseWorkbenchStorage(runtime: PanelHost): Promise<void> {
  await runtime.flushSpaceKnowledgeSync();
  await runtime.personalKnowledgeFeature.release();
  await runtime.spaceFeature.release();
  runtime.database.close();
}

function ordinaryFeatureHttpError(error: OrdinaryFeatureError): PanelHttpError {
  switch (error.code) {
    case "ordinary_feature_released":
      return new PanelHttpError(503, "panel_runtime_quiescing", "面板正在关闭，不能接受新的请求。");
    case "ordinary_run_not_found":
      return new PanelHttpError(404, "run_not_found", error.message);
    case "ordinary_conversation_not_found":
      return new PanelHttpError(404, "conversation_not_found", error.message);
    case "ordinary_conversation_owner_required":
      return new PanelHttpError(409, "conversation_owner_required", error.message);
    case "ordinary_confirmation_not_found":
    case "ordinary_rollback_target_not_found":
      return new PanelHttpError(404, error.code, error.message);
    case "ordinary_conversation_deleted":
    case "ordinary_run_conflict":
    case "ordinary_revision_conflict":
    case "ordinary_run_state_conflict":
    case "ordinary_conversation_busy":
    case "ordinary_confirmation_in_progress":
    case "ordinary_tool_result_conflict":
    case "ordinary_submission_conflict":
    case "ordinary_conversation_cleanup_pending":
    case "ordinary_managed_attachment_unavailable":
    case "ordinary_memory_scope_unavailable":
    case "ordinary_completion_commit_failed":
      return new PanelHttpError(409, error.code, error.message);
  }
}

function resolveRuntimeCleanupTimeout(value: number | undefined): number {
  const resolved = value ?? PANEL_RUNTIME_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError("Panel runtime cleanup timeout must be a positive safe integer.");
  }
  return resolved;
}

async function waitForPanelRequestIdle(server: Server, runtime: PanelHost): Promise<void> {
  while (runtime.activeRequestJobs.size > 0) {
    const jobs = [...runtime.activeRequestJobs];
    const drained = await settleWithin(jobs, PANEL_REQUEST_DRAIN_TIMEOUT_MS);
    if (drained) {
      continue;
    }
    // An admitted request may need to observe quiescing and write its explicit
    // response. Only idle sockets are disposable here; the Host-level cleanup
    // deadline owns the eventual hard close for requests that never settle.
    server.closeIdleConnections();
    await Promise.allSettled(jobs);
  }
}

function settleWithin(jobs: readonly Promise<void>[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void Promise.allSettled(jobs).then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function logUnhandledPanelRequestError(request: IncomingMessage, error: unknown): void {
  const method = request.method ?? "UNKNOWN";
  const url = request.url ?? "/";
  console.error(`[panel-server] unhandled request failure ${method} ${url}`);
  console.error(error);
}
