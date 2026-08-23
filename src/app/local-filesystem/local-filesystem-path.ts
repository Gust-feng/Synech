/**
 * 中性路径安全模块。
 *
 * 从 space-reference-preview.ts、space-reference-mutations.ts、
 * space-reference-deletion.ts 和 space-managed-folder-store.ts 中提取的
 * 重复路径逃逸防止逻辑。不依赖任何 Space/Knowledge 业务概念。
 */
import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * 规范化相对路径，拒绝 `..` 段。
 * @throws Error 当路径包含 `..` 段时。
 */
export function normalizeRelativePath(value: string): string {
  const slashed = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(slashed) || path.win32.isAbsolute(slashed)) {
    throw new Error("Expected a relative path.");
  }
  const trimmed = slashed.replace(/^\/+|\/+$/gu, "");
  if (trimmed.split("/").some((part) => part === "..")) {
    throw new Error("Relative path contains parent directory traversal.");
  }
  const normalized = path.posix.normalize(trimmed);
  return normalized === "." ? "" : normalized;
}

/** 拼接父子相对路径，自动规范化。 */
export function joinRelativePath(parent: string, child: string): string {
  const normalizedParent = normalizeRelativePath(parent);
  const normalizedChild = normalizeRelativePath(child);
  return normalizedParent.length === 0
    ? normalizedChild
    : normalizeRelativePath(`${normalizedParent}/${normalizedChild}`);
}

/**
 * 检查 `candidate` 是否在 `root` 内（含 root 自身）。
 * 使用 path.relative 进行跨平台比较，不触碰文件系统。
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const relation = path.relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${path.sep}`) && relation !== ".." && !path.isAbsolute(relation));
}

/**
 * 将 `relativePath` 解析为 `rootDir` 内的绝对路径。
 *
 * 统一了原先 resolvePanelSpaceReferencePath 的 realpath + path.relative 检查：
 * - rootDir 的 realpath 解析失败时返回 `path.resolve(rootDir, normalized)`，
 *   由调用方后续 stat 检测缺失。
 * - 目标存在时返回其 realpath，并验证在 root 内。
 * - 目标不存在时（新建/重命名场景）返回 resolved candidate，不报错。
 *
 * @throws Error 当已存在的目标通过 symlink 等手段逃逸到 root 之外时。
 */
export async function resolveWithinRoot(rootDir: string, relativePath: string): Promise<string> {
  const normalized = normalizeRelativePath(relativePath);
  const root = await fs.realpath(rootDir).catch(() => undefined);
  if (root === undefined) return path.resolve(rootDir, normalized);
  const candidate = path.resolve(root, normalized);
  const realCandidate = await fs.realpath(candidate).catch(() => undefined);
  if (realCandidate === undefined) return candidate;
  if (!isWithinRoot(root, realCandidate)) {
    throw new Error("Resolved path escapes the root directory.");
  }
  return realCandidate;
}

/**
 * 将 `relativePath` 解析为目标绝对路径，通过验证其父目录来确保在 root 内。
 *
 * 适用于新建/重命名场景：目标尚不存在，但父目录必须存在且在 root 内。
 *
 * @throws Error 当 root 不存在或父目录逃逸 root 时。
 */
export async function resolveDestinationWithinRoot(rootDir: string, relativePath: string): Promise<string> {
  const normalized = normalizeRelativePath(relativePath);
  const root = await fs.realpath(rootDir).catch(() => undefined);
  if (root === undefined) throw new Error("Root directory does not exist.");
  const parentPath = path.resolve(root, path.dirname(normalized));
  const realParent = await fs.realpath(parentPath).catch(() => undefined);
  if (realParent === undefined || !isWithinRoot(root, realParent)) {
    throw new Error("Resolved path escapes the root directory.");
  }
  return path.join(realParent, path.basename(normalized));
}

/**
 * 判断两个路径是否指向同一个文件系统条目。
 * Windows 下大小写不敏感，其他平台精确匹配。
 */
export function samePathIdentity(left: string, right: string): boolean {
  const l = path.normalize(path.resolve(left));
  const r = path.normalize(path.resolve(right));
  return process.platform === "win32"
    ? l.toLocaleLowerCase("en-US") === r.toLocaleLowerCase("en-US")
    : l === r;
}