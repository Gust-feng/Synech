import type { SpaceReferenceItem } from "../../spaces/index.js";
import { inspectSpaceExternalSource } from "../../spaces/index.js";
import type { WorkspaceFeature } from "../../workspaces/index.js";
import { PanelHttpError } from "../http-utils.js";

export type ResolvedSpaceFilesystemReference = {
  readonly item: SpaceReferenceItem;
  readonly path: string;
  readonly sourceKind: "local_file" | "workspace" | "managed_folder";
  readonly sourceIdentity?: string;
  readonly mountVersion?: string;
};

export type SpaceWorkspaceReferenceDependencies = {
  readonly workspaceFeature: {
    readonly commands: Pick<WorkspaceFeature["commands"], "invalidateMount">;
    readonly queries: Pick<WorkspaceFeature["queries"], "get">;
  };
};

export async function resolveSpaceFilesystemReference(
  dependencies: SpaceWorkspaceReferenceDependencies,
  item: SpaceReferenceItem,
): Promise<ResolvedSpaceFilesystemReference> {
  if (item.reference.kind === "local_file") {
    const current = await inspectSpaceExternalSource(item.reference.path);
    if (current?.kind !== "file") {
      throw new PanelHttpError(409, "space_reference_source_missing", "本地文件引用已不存在。");
    }
    if (item.sourceIdentity !== undefined && current.identity !== item.sourceIdentity) {
      throw new PanelHttpError(409, "space_reference_source_replaced", "本地文件已被其他文件替换，请重新添加引用。");
    }
    return {
      item,
      path: item.reference.path,
      sourceKind: "local_file",
      sourceIdentity: item.sourceIdentity ?? current.identity,
    };
  }
  if (item.reference.kind === "managed_folder") {
    const current = await inspectSpaceExternalSource(item.reference.path);
    if (current?.kind !== "folder") {
      throw new PanelHttpError(409, "space_reference_source_missing", "空间维护的文件夹已不存在。");
    }
    return { item, path: item.reference.path, sourceKind: "managed_folder" };
  }
  if (item.reference.kind !== "workspace") {
    throw new PanelHttpError(409, "space_reference_content_unavailable", "这个引用没有本地文件系统内容。");
  }
  const workspace = await dependencies.workspaceFeature.queries.get(item.reference.workspaceId);
  if (workspace === undefined) throw new PanelHttpError(409, "workspace_not_available", "引用的工作区已经不存在。");
  const mount = workspace.currentMount;
  if (workspace.status !== "available" || mount === undefined) {
    throw new PanelHttpError(409, "workspace_not_available", "工作区已断开，请重新连接后再访问。");
  }
  const current = await inspectSpaceExternalSource(mount.rootPath);
  if (current?.kind !== "folder" || current.identity !== mount.sourceIdentity) {
    await dependencies.workspaceFeature.commands.invalidateMount(workspace.id);
    throw new PanelHttpError(409, "workspace_not_available", "工作区目录已断开，请重新连接后再访问。");
  }
  return { item, path: mount.rootPath, sourceKind: "workspace", sourceIdentity: mount.sourceIdentity, mountVersion: mount.mountVersion };
}
