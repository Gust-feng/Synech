import { promises as fs } from "node:fs";
import path from "node:path";

import { renameWithRetry } from "../../../kernel/fs/atomic-write.js";
import { isNodeError } from "../../../kernel/values/index.js";
import { isWithinRoot } from "../../local-filesystem/index.js";
import type { SpaceReferenceDeletionTarget } from "../../spaces/file-system-reference-deletion-journal.js";
import type { SpaceReferenceItem } from "../../spaces/index.js";
import type { SpaceReferenceDeletionFilePort } from "../../spaces/space-reference-deletion.js";
import { PanelHttpError } from "../http-utils.js";

const WINDOWS_UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set(["EINVAL", "EPERM", "ENOTSUP", "EISDIR"]);

/**
 * 路径类引用按规范化路径取互斥键，使不同 Space 指向同一目录的引用共享同一把锁。
 * 跨 Space 重叠引用是合法状态，串行化是它的并发安全边界。
 */
export function spaceReferenceMutationKey(item: SpaceReferenceItem): string {
  if (item.reference.kind !== "local_file" && item.reference.kind !== "managed_folder") {
    return item.id;
  }
  const absolute = path.resolve(item.reference.path);
  return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
}

export function createSpaceReferenceDeletionFilePort(
  managedFolderRoot: string,
): SpaceReferenceDeletionFilePort {
  const resolvedManagedFolderRoot = path.resolve(managedFolderRoot);

  return {
    async prepare({ item, deletionId, targetIndex }) {
      if (item.reference.kind !== "local_file" && item.reference.kind !== "managed_folder") return undefined;
      const sourcePath = path.resolve(item.reference.path);
      if (item.reference.kind === "managed_folder") {
        assertManagedFolderPath(resolvedManagedFolderRoot, sourcePath);
      }

      const sourceStat = await fs.lstat(sourcePath).catch((error: unknown) => {
        if (isNodeError(error, "ENOENT") && item.reference.kind === "local_file") return undefined;
        if (isNodeError(error, "ENOENT")) {
          throw new PanelHttpError(404, "space_reference_source_missing", "来源文件已不存在。");
        }
        throw error;
      });
      if (sourceStat === undefined) return undefined;
      if (item.reference.kind === "local_file" && !sourceStat.isFile() && !sourceStat.isSymbolicLink()) {
        throw new PanelHttpError(409, "space_reference_file_delete_unavailable", "这个引用不再是可删除的单个文件。");
      }
      if (item.reference.kind === "managed_folder" && !sourceStat.isDirectory()) {
        throw new PanelHttpError(409, "space_managed_folder_not_found", "软件维护的文件夹已不存在。");
      }
      if (item.reference.kind === "managed_folder") {
        await assertManagedFolderRealPath(resolvedManagedFolderRoot, sourcePath);
      }

      const stagedPath = stagedSiblingPath(sourcePath, deletionId, targetIndex);
      await assertStagedPathAvailable(stagedPath);
      const target: SpaceReferenceDeletionTarget = {
        referenceId: item.id,
        kind: item.reference.kind,
        sourcePath,
        stagedPath,
      };
      return target;
    },

    async inspect(target) {
      assertManagedTargetPath(resolvedManagedFolderRoot, target);
      const [sourceExists, stagedExists] = await Promise.all([
        exactPathExists(target.sourcePath),
        exactPathExists(target.stagedPath),
      ]);
      return { sourceExists, stagedExists };
    },

    async stage(target) {
      assertManagedTargetPath(resolvedManagedFolderRoot, target);
      await assertStagedPathAvailable(target.stagedPath);
      await renameWithRetry(target.sourcePath, target.stagedPath);
      await fsyncDirectory(path.dirname(target.sourcePath));
    },

    async restore(target) {
      assertManagedTargetPath(resolvedManagedFolderRoot, target);
      if (await exactPathExists(target.sourcePath)) {
        throw new PanelHttpError(
          409,
          "space_reference_deletion_restore_conflict",
          "来源位置已出现新内容，无法覆盖恢复。",
        );
      }
      await renameWithRetry(target.stagedPath, target.sourcePath);
      await fsyncDirectory(path.dirname(target.sourcePath));
    },

    async removeStaged(target) {
      assertManagedTargetPath(resolvedManagedFolderRoot, target);
      await fs.rm(target.stagedPath, {
        recursive: target.kind === "managed_folder",
        force: true,
      });
      await fsyncDirectory(path.dirname(target.stagedPath));
    },
  };
}

function assertManagedTargetPath(
  managedFolderRoot: string,
  target: SpaceReferenceDeletionTarget,
): void {
  if (target.kind !== "managed_folder") return;
  assertManagedFolderPath(managedFolderRoot, path.resolve(target.sourcePath));
  if (path.dirname(path.resolve(target.stagedPath)) !== path.dirname(path.resolve(target.sourcePath))) {
    throw new PanelHttpError(409, "space_managed_folder_not_found", "删除暂存位置不属于软件维护空间。");
  }
}

function assertManagedFolderPath(managedFolderRoot: string, sourcePath: string): void {
  if (path.relative(managedFolderRoot, sourcePath).length === 0 || !isWithinRoot(managedFolderRoot, sourcePath)) {
    throw new PanelHttpError(409, "space_managed_folder_not_found", "软件文件夹不属于当前维护空间。");
  }
}

async function assertManagedFolderRealPath(managedFolderRoot: string, sourcePath: string): Promise<void> {
  const [realManagedFolderRoot, realSourcePath] = await Promise.all([
    fs.realpath(managedFolderRoot),
    fs.realpath(sourcePath),
  ]);
  assertManagedFolderPath(realManagedFolderRoot, realSourcePath);
}

function stagedSiblingPath(sourcePath: string, deletionId: string, targetIndex: number): string {
  return path.join(
    path.dirname(sourcePath),
    `.${path.basename(sourcePath)}.synech-delete-${deletionId}-${targetIndex}`,
  );
}

async function assertStagedPathAvailable(stagedPath: string): Promise<void> {
  if (!await exactPathExists(stagedPath)) return;
  throw new PanelHttpError(
    409,
    "space_reference_deletion_stage_exists",
    "删除暂存位置已存在，无法安全删除这个引用。",
  );
}

async function exactPathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let primaryFailure: unknown;
  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedWindowsDirectoryFsync(error)) {
      primaryFailure = error;
      throw error;
    }
  } finally {
    try {
      await handle?.close();
    } catch (error) {
      if (primaryFailure === undefined) throw error;
    }
  }
}

function isUnsupportedWindowsDirectoryFsync(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  for (const code of WINDOWS_UNSUPPORTED_DIRECTORY_FSYNC_CODES) {
    if (isNodeError(error, code)) return true;
  }
  return false;
}
