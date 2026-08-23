import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { inspectSpaceExternalSource } from "../spaces/index.js";
import type { WorkspaceFeature, WorkspaceFeatureError } from "../workspaces/index.js";
import { PanelHttpError, readJsonBody, writeJson } from "./http-utils.js";
import type { WorkspaceDeletionCoordinator } from "./workspace-deletion-coordinator.js";

const registerSchema = z.object({
  rootPath: z.string().trim().min(1).max(4_096),
}).strict();

const linkSchema = z.object({
  spaceId: z.string().min(1),
}).strict();

export type WorkspaceRouteDependencies = {
  readonly workspaceFeature: {
    readonly commands: Pick<WorkspaceFeature["commands"], "registerWorkspace" | "linkWorkspaceToSpace" | "unlinkWorkspaceFromSpace">;
    readonly queries: Pick<WorkspaceFeature["queries"], "list" | "listLinksBySpace">;
  };
  readonly workspaceDeletion: Pick<WorkspaceDeletionCoordinator, "admit" | "deleteWorkspace">;
};

/**
 * HTTP adapter for WorkspaceFeature（ADR-0035 阶段二）。
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
      const registered = await feature.commands.registerWorkspace({
        rootPath: input.rootPath,
        sourceIdentity: source.identity,
      });
      writeJson(response, 201, { ok: true, workspace: registered.workspace, mount: registered.mount });
      return true;
    }
    return false;
  }

  const linkMatch = /^\/api\/workspaces\/([^/]+)\/links$/u.exec(url.pathname);
  if (linkMatch !== null) {
    if (request.method === "POST") {
      const workspaceId = decode(linkMatch[1]);
      const input = parse(linkSchema, await readJsonBody(request), "链接参数无效。");
      const link = await dependencies.workspaceDeletion.admit(workspaceId, () =>
        feature.commands.linkWorkspaceToSpace({ spaceId: input.spaceId, workspaceId }));
      writeJson(response, 201, { ok: true, link });
      return true;
    }
    if (request.method === "DELETE") {
      const workspaceId = decode(linkMatch[1]);
      const input = parse(linkSchema, await readJsonBody(request), "链接参数无效。");
      await dependencies.workspaceDeletion.admit(workspaceId, async () => {
        const links = await feature.queries.listLinksBySpace(input.spaceId);
        const target = links.find((link) => link.workspaceId === workspaceId && link.status === "active");
        if (target === undefined) {
          throw new PanelHttpError(404, "workspace_link_not_found", "未找到该工作区引用。");
        }
        await feature.commands.unlinkWorkspaceFromSpace(target.linkId);
      });
      writeJson(response, 200, { ok: true });
      return true;
    }
    return false;
  }

  const deleteMatch = /^\/api\/workspaces\/([^/]+)$/u.exec(url.pathname);
  if (deleteMatch !== null && request.method === "DELETE") {
    const workspaceId = decode(deleteMatch[1]);
    // deleteWorkspace is idempotent and is also the explicit retry path for a
    // cascade that persisted `deleting` before a later cleanup step failed.
    // Calling assertAvailable here would make that durable retry impossible in
    // the same process.
    await dependencies.workspaceDeletion.deleteWorkspace(workspaceId);
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
    case "workspace_link_not_found":
      return new PanelHttpError(404, error.code, error.message);
    case "workspace_duplicate_path":
    case "workspace_duplicate_identity":
    case "workspace_nested_path":
    case "workspace_mount_conflict":
    case "workspace_link_conflict":
    case "workspace_not_available":
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
