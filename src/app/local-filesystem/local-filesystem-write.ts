/**
 * 统一文件写入模块。
 *
 * 从 space-reference-mutations.ts 中提取的纯机械性文件变更操作：
 * 原子写入（含 CAS 指纹校验）、排他创建文件、创建目录、重命名、递归删除。
 * 不包含任何 reference.kind 业务判断，不抛出 PanelHttpError，
 * 调用方负责将 FsResult 映射为各自的业务错误。
 */
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { FsResult } from "./local-filesystem-types.js";
import { contentFingerprint } from "./local-filesystem-read.js";
import { samePathIdentity } from "./local-filesystem-path.js";

/**
 * 以 CAS（compare-and-swap）方式原子写入文本文件。
 *
 * 流程：读取当前内容 → 指纹校验 → 临时文件写入 + sync → 二次指纹校验 → rename。
 * 临时文件复用原文件权限，写入完成后自动清理。
 *
 * @param filePath 目标绝对路径（必须已存在且为普通文件）。
 * @param content 要写入的 UTF-8 文本。
 * @param expectedFingerprint 期望的当前内容指纹；不匹配时返回 fingerprint_mismatch。
 * @returns 成功时返回写入后的内容指纹。
 */
export async function writeText(
  filePath: string,
  content: string,
  expectedFingerprint?: string,
): Promise<FsResult<{ fingerprint: string }>> {
  const stat = await fs.stat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat === undefined) return { ok: false, error: { kind: "not_found" } };
  if (stat.isDirectory()) return { ok: false, error: { kind: "is_directory" } };
  if (!stat.isFile()) return { ok: false, error: { kind: "io_error", message: "Not a regular file." } };

  const current = await fs.readFile(filePath);
  const currentFingerprint = contentFingerprint(current);
  if (expectedFingerprint !== undefined && currentFingerprint !== expectedFingerprint) {
    return { ok: false, error: { kind: "fingerprint_mismatch", expected: expectedFingerprint, actual: currentFingerprint } };
  }

  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.synech-${randomUUID()}.tmp`);
  const handle = await fs.open(temporaryPath, "wx", stat.mode);
  try {
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (expectedFingerprint !== undefined) {
      const latest = await fs.readFile(filePath).catch(() => undefined);
      if (latest === undefined) return { ok: false, error: { kind: "not_found" } };
      const latestFingerprint = contentFingerprint(latest);
      if (latestFingerprint !== expectedFingerprint) {
        return { ok: false, error: { kind: "fingerprint_mismatch", expected: expectedFingerprint, actual: latestFingerprint } };
      }
    }
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
  return { ok: true, value: { fingerprint: contentFingerprint(Buffer.from(content, "utf8")) } };
}

/**
 * 排他创建空文件（`flag: "wx"`）。
 * 目标已存在时返回 already_exists。
 */
export async function createFile(filePath: string): Promise<FsResult<void>> {
  try {
    await fs.writeFile(filePath, "", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "EEXIST") return { ok: false, error: { kind: "already_exists" } };
    return { ok: false, error: { kind: "io_error", message: e.message } };
  }
  return { ok: true, value: undefined };
}

/**
 * 创建目录。
 * 目标已存在时返回 already_exists。
 */
export async function createDirectory(dirPath: string): Promise<FsResult<void>> {
  try {
    await fs.mkdir(dirPath);
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "EEXIST") return { ok: false, error: { kind: "already_exists" } };
    return { ok: false, error: { kind: "io_error", message: e.message } };
  }
  return { ok: true, value: undefined };
}

/**
 * 重命名文件或目录。
 *
 * 支持仅大小写变化的重命名（Windows 下大小写不敏感，samePathIdentity 判断为同一条目）。
 * 目标已存在且与源非同一条目时返回 already_exists。
 */
export async function renameEntry(oldPath: string, newPath: string): Promise<FsResult<void>> {
  const sourceExists = await fs.stat(oldPath).then(() => true, () => false);
  if (!sourceExists) return { ok: false, error: { kind: "not_found" } };

  const destExists = await fs.stat(newPath).then(() => true, () => false);
  if (destExists && !samePathIdentity(oldPath, newPath)) {
    return { ok: false, error: { kind: "already_exists" } };
  }

  try {
    await fs.rename(oldPath, newPath);
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ok: false, error: { kind: "not_found" } };
    return { ok: false, error: { kind: "io_error", message: e.message } };
  }
  return { ok: true, value: undefined };
}

/**
 * 递归删除文件或目录。
 * 目标不存在时返回 not_found。
 */
export async function deleteEntry(targetPath: string): Promise<FsResult<void>> {
  try {
    await fs.rm(targetPath, { recursive: true, force: false });
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ok: false, error: { kind: "not_found" } };
    return { ok: false, error: { kind: "io_error", message: e.message } };
  }
  return { ok: true, value: undefined };
}
