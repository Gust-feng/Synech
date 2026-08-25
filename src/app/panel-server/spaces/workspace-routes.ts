import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { inspectSpaceExternalSource } from "../../spaces/index.js";
import type { WorkspaceFeature, WorkspaceFeatureError } from "../../workspaces/index.js";
import type { WorkbenchCoordination } from "../../workbench-coordination/index.js";
import { PanelHttpError, readJsonBody, writeJson } from "../http-utils.js";

const registerSchema = z.object({
  rootPath: z.string().trim().min(1).max(4_096),
}).strict();

const visibilitySchema = z.object({
  visibility: z.enum(["listed", "implicit"]),
}).strict();

export type WorkspaceRouteDependencies = {
  readonly workspaceFeature: {
    readonly commands: Pick<WorkspaceFeature["commands"], "ensureWorkspace" | "setVisibility" | "reconnectWorkspace">;
    readonly queries: Pick<WorkspaceFeature["queries"], "list" | "get">;
  };
  readonly workbenchCoordination: {
    readonly commands: Pick<WorkbenchCoordination["commands"], "reconnectWorkspace" | "hideWorkspace" | "deleteWorkspace">;
  };
};

/**
 * Workspace 功能的 HTTP adapter。
 *
 * 注册路径必须来自系统文件夹选择器或等价 Host 接口；后端捕获来源身份并做唯一性
 * 校验，模型不能通过任意路径创建持久化 Workspace。
 */
export async function handlePanelWorkspaceRoute(
  dependencies: WorkspaceRouteDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const feature = dependencies.workspaceFeature;

  if (url.pathname === "/api/workspaces") {
    if (request.method === "GET") {
      writeJson(response, 200, { ok: true, workspaces: await feature.queries.list() });
      return true;
    }
    if (request.method === "POST") {
      const input = parse(registerSchema, await readJsonBody(request), "工作区路径无效。");
      const source = await inspectSpaceExternalSource(input.rootPath);
      if (source === undefined || source.kind !== "folder") {
        throw new PanelHttpError(400, "workspace_directory_required", "所选路径必须是存在的文件夹。");
      }
      const registered = await feature.commands.ensureWorkspace({
        rootPath: input.rootPath,
        sourceIdentity: source.identity,
        visibility: "listed",
      });
      writeJson(response, 201, { ok: true, workspace: registered.workspace, mount: registered.mount });
      return true;
    }
    return false;
  }

  const reconnectMatch = /^\/api\/workspaces\/([^/]+)\/reconnect$/u.exec(url.pathname);
  if (reconnectMatch !== null && request.method === "POST") {
    const workspaceId = decode(reconnectMatch[1]);
    const input = parse(registerSchema, await readJsonBody(request), "工作区路径无效。");
    const reconnected = await dependencies.workbenchCoordination.commands.reconnectWorkspace({ workspaceId, rootPath: input.rootPath });
    writeJson(response, 200, { ok: true, workspace: reconnected.workspace, mount: reconnected.mount });
    return true;
  }

  const visibilityMatch = /^\/api\/workspaces\/([^/]+)$/u.exec(url.pathname);
  if (visibilityMatch !== null && request.method === "PATCH") {
    const workspaceId = decode(visibilityMatch[1]);
    const workspace = await feature.queries.get(workspaceId);
    if (workspace === undefined) throw new PanelHttpError(404, "workspace_not_found", "工作区不存在。");
    const input = parse(visibilitySchema, await readJsonBody(request), "工作区可见性无效。");
    const updated = input.visibility === "implicit"
      ? await dependencies.workbenchCoordination.commands.hideWorkspace(workspaceId)
      : await feature.commands.setVisibility(workspaceId, "listed");
    writeJson(response, 200, { ok: true, workspace: updated });
    return true;
  }

  if (visibilityMatch !== null && request.method === "DELETE") {
    const workspaceId = decode(visibilityMatch[1]);
    await dependencies.workbenchCoordination.commands.deleteWorkspace(workspaceId);
    writeJson(response, 200, { ok: true });
    return true;
  }

  return false;
}

function parse<T>(schema: z.ZodType<T>, raw: unknown, invalidMessage: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new PanelHttpError(400, "workspace_invalid_input", invalidMessage);
  }
  return result.data;
}

function decode(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new PanelHttpError(400, "workspace_invalid_input", "工作区标识无效。");
  }
}

export function workspaceFeatureHttpError(error: WorkspaceFeatureError): PanelHttpError {
  switch (error.code) {
    case "workspace_feature_released":
      return new PanelHttpError(503, "panel_runtime_quiescing", "面板正在关闭，不能接受新的请求。");
    case "workspace_not_found":
      return new PanelHttpError(404, error.code, error.message);
    case "workspace_duplicate_path":
    case "workspace_duplicate_identity":
    case "workspace_nested_path":
    case "workspace_mount_conflict":
    case "workspace_not_available":
    case "workspace_discard_not_allowed":
      return new PanelHttpError(409, error.code, error.message);
    case "workspace_mount_invalid":
      return new PanelHttpError(400, error.code, error.message);
    case "workspace_not_deleting":
      return new PanelHttpError(409, error.code, error.message);
    case "workspace_invalid_input":
      return new PanelHttpError(400, error.code, error.message);
    case "workspace_snapshot_incompatible":
    case "workspace_repository_failure":
      return new PanelHttpError(500, error.code, error.message);
  }
}

export type { WorkspaceFeatureError };
