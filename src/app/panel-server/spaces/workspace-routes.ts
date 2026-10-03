import type { IncomingMessage, ServerResponse } from "node:http";

import type { WorkspaceFeatureError } from "../../workspaces/index.js";
import { PanelHttpError } from "../http-utils.js";

/**
 * Workspace 不再作为独立产品入口提供 HTTP API。
 *
 * Workspace 仍然是本地目录的稳定登记身份，由 Space reference 通过
 * `/api/spaces/:spaceId/workspaces` 关联、通过 `/api/spaces/references/:id`
 * 管理。这里暂时保留 adapter 作为明确的退役边界，避免旧调用静默落入
 * 404 或继续绕过 Space membership 写入 Workspace。
 *
 * request-handler 仍会调用本模块，直到宿主组合根同步移除这条退役 adapter。
 */
export type WorkspaceRouteDependencies = Record<never, never>;

const RETIRED_WORKSPACE_SURFACE_ERROR = new PanelHttpError(
  410,
  "workspace_surface_retired",
  "工作区不再作为独立入口提供，请从空间内管理本地资源。",
);

/**
 * 明确拒绝已退役的独立 Workspace surface。
 *
 * 这里不读取请求体，也不触碰 WorkspaceFeature，保证旧的独立入口不会
 * 继续创建、隐藏、删除或重连 Workspace。底层 Workspace 能力由 Space
 * reference/application 路径继续使用。
 */
export async function handlePanelWorkspaceRoute(
  _dependencies: WorkspaceRouteDependencies,
  _request: IncomingMessage,
  _response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (isRetiredWorkspacePath(url.pathname)) {
    throw RETIRED_WORKSPACE_SURFACE_ERROR;
  }
  return false;
}

function isRetiredWorkspacePath(pathname: string): boolean {
  return pathname === "/api/workspaces" || /^\/api\/workspaces\/[^/]+(?:\/reconnect)?$/u.test(pathname);
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
