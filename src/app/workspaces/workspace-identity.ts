/**
 * Workspace 路径身份与唯一性校验（ADR-0035 §4.2）。
 *
 * 注册 Workspace 前必须对规范化路径、realpath、大小写、junction 和 symlink 做唯一性
 * 检查：拒绝重复目录和父子嵌套目录；同一物理对象（sourceIdentity）只能登记一个
 * Workspace。
 */

import path from "node:path";

import { WorkspaceFeatureError } from "./contracts.js";

/** 规范化绝对路径（Windows 不区分大小写，Unix 保留大小写）。 */
export function canonicalWorkspacePathIdentity(absolutePath: string): string {
  const normalized = path.resolve(absolutePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export type WorkspacePathNesting =
  | { readonly kind: "duplicate" }
  | { readonly kind: "nested" }
  | { readonly kind: "parent" }
  | { readonly kind: "none" };

/** 判定 candidate 与 existing 的嵌套关系（目录边界），供唯一性校验使用。 */
export function workspacePathNesting(candidate: string, existing: string): WorkspacePathNesting {
  const left = canonicalWorkspacePathIdentity(candidate);
  const right = canonicalWorkspacePathIdentity(existing);
  if (left === right) return { kind: "duplicate" };
  const leftBoundary = left.endsWith(path.sep) ? left : `${left}${path.sep}`;
  const rightBoundary = right.endsWith(path.sep) ? right : `${right}${path.sep}`;
  if (rightBoundary.startsWith(leftBoundary)) return { kind: "parent" };
  if (leftBoundary.startsWith(rightBoundary)) return { kind: "nested" };
  return { kind: "none" };
}

/** 校验 candidate 不与任何已登记路径重复或父子嵌套；冲突时抛出明确错误。 */
export function assertWorkspacePathUniqueness(existingRootPaths: readonly string[], candidatePath: string): void {
  for (const existing of existingRootPaths) {
    const nesting = workspacePathNesting(candidatePath, existing);
    if (nesting.kind === "duplicate") {
      throw new WorkspaceFeatureError(
        "workspace_duplicate_path",
        `Workspace root already registered: ${existing}`,
      );
    }
    if (nesting.kind === "nested" || nesting.kind === "parent") {
      throw new WorkspaceFeatureError(
        "workspace_nested_path",
        `Workspace roots must not nest: ${candidatePath} vs ${existing}`,
      );
    }
  }
}
