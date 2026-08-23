import { createHash } from "node:crypto";
import { createReadStream, promises as fs, type BigIntStats } from "node:fs";
import path from "node:path";
import { isFileNotFound } from "../../kernel/values/index.js";
import { StringDecoder } from "node:string_decoder";
import type { SkillRuntimeResourceType } from "./skill-loader.js";

export const DEFAULT_SKILL_RESOURCE_MAX_CHARS = 16_000;

export type SkillResourcePackageInput = {
  readonly packagePath: string;
  readonly sourcePath: string;
};

export type SkillResourceResolverInput = SkillResourcePackageInput & {
  readonly relativePath: string;
  readonly type: SkillRuntimeResourceType;
  readonly maxChars?: number;
  readonly startChar?: number;
  readonly abortSignal?: AbortSignal;
};

export type SkillResourceResolverErrorCode =
  | "empty_path"
  | "nul_in_path"
  | "absolute_path"
  | "path_escape"
  | "resource_type_mismatch"
  | "invalid_max_chars"
  | "invalid_start_char"
  | "package_not_found"
  | "package_not_directory"
  | "source_not_found"
  | "source_not_file"
  | "source_outside_package"
  | "resource_not_found"
  | "resource_not_file"
  | "cross_package_path"
  | "resource_read_failed";

export type SkillResourceResolvedFacts = {
  readonly ok: true;
  readonly relativePath: string;
  readonly type: SkillRuntimeResourceType;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly charCount?: number;
  readonly truncated: boolean;
  readonly content?: string;
  readonly requiresToolExecution?: true;
  readonly notExecutableByResolver?: true;
  readonly executionNote?: string;
};

export type SkillResourceErrorFacts = {
  readonly ok: false;
  readonly relativePath: string;
  readonly type: SkillRuntimeResourceType;
  readonly truncated: false;
  readonly errorCode: SkillResourceResolverErrorCode;
  readonly errorMessage: string;
};

export type SkillResourceResolverResult = SkillResourceResolvedFacts | SkillResourceErrorFacts;

type SkillResourceFileIdentity = {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAtNs: bigint;
  readonly changedAtNs: bigint;
};

class SkillResourceReadError extends Error {
  constructor(readonly code: SkillResourceResolverErrorCode, message: string) {
    super(message);
    this.name = "SkillResourceReadError";
  }
}

export async function resolveSkillResource(input: SkillResourceResolverInput): Promise<SkillResourceResolverResult> {
  return resolveSkillResourceInternal(input, { includeReferenceContent: false });
}

export async function readSkillResource(input: SkillResourceResolverInput): Promise<SkillResourceResolverResult> {
  return resolveSkillResourceInternal(input, { includeReferenceContent: true });
}

async function resolveSkillResourceInternal(
  input: SkillResourceResolverInput,
  options: { readonly includeReferenceContent: boolean }
): Promise<SkillResourceResolverResult> {
  const normalized = normalizeSkillResourcePath(input.relativePath);
  if (!normalized.ok) {
    return errorFacts(input.type, "", normalized.errorCode);
  }

  if (!isPathForResourceType(normalized.relativePath, input.type)) {
    return errorFacts(input.type, normalized.relativePath, "resource_type_mismatch");
  }

  const maxChars = normalizeMaxChars(input.maxChars);
  if (typeof maxChars !== "number") {
    return errorFacts(input.type, normalized.relativePath, maxChars);
  }
  const startChar = normalizeStartChar(input.startChar);
  if (typeof startChar !== "number") {
    return errorFacts(input.type, normalized.relativePath, startChar);
  }

  const packageFacts = await resolvePackageFacts(input);
  if (!packageFacts.ok) {
    return errorFacts(input.type, normalized.relativePath, packageFacts.errorCode);
  }

  const resourcePath = path.resolve(packageFacts.packageRealPath, normalized.relativePath);
  if (!isInsideOrEqual(packageFacts.packageRealPath, resourcePath)) {
    return errorFacts(input.type, normalized.relativePath, "path_escape");
  }

  const resourceRealPath = await fs.realpath(resourcePath).catch((error: unknown) => {
    if (isFileNotFound(error)) {
      return undefined;
    }
    throw error;
  }).catch(() => null);
  if (resourceRealPath === undefined) {
    return errorFacts(input.type, normalized.relativePath, "resource_not_found");
  }
  if (resourceRealPath === null || !isInsideOrEqual(packageFacts.packageRealPath, resourceRealPath)) {
    return errorFacts(input.type, normalized.relativePath, "cross_package_path");
  }

  const stat = await fs.stat(resourceRealPath, { bigint: true }).catch((error: unknown) => {
    if (isFileNotFound(error)) {
      return undefined;
    }
    throw error;
  }).catch(() => null);
  if (stat === undefined) {
    return errorFacts(input.type, normalized.relativePath, "resource_not_found");
  }
  if (stat === null) {
    return errorFacts(input.type, normalized.relativePath, "resource_read_failed");
  }
  if (!stat.isFile()) {
    return errorFacts(input.type, normalized.relativePath, "resource_not_file");
  }
  if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    return errorFacts(input.type, normalized.relativePath, "resource_read_failed");
  }

  const facts = await resourceFactsFromFile({
    resourceRealPath,
    expectedIdentity: fileIdentity(stat),
    includeReferenceContent: options.includeReferenceContent,
    maxChars,
    startChar,
    relativePath: normalized.relativePath,
    type: input.type,
    abortSignal: input.abortSignal,
  }).catch((error: unknown) => {
    if (input.abortSignal?.aborted === true) {
      throw input.abortSignal.reason instanceof Error ? input.abortSignal.reason : error;
    }
    if (error instanceof SkillResourceReadError) {
      return errorFacts(input.type, normalized.relativePath, error.code);
    }
    return undefined;
  });
  if (facts === undefined) {
    return errorFacts(input.type, normalized.relativePath, "resource_read_failed");
  }
  return facts;
}

async function resourceFactsFromFile(input: {
  readonly resourceRealPath: string;
  readonly expectedIdentity: SkillResourceFileIdentity;
  readonly includeReferenceContent: boolean;
  readonly maxChars: number;
  readonly startChar: number;
  readonly relativePath: string;
  readonly type: SkillRuntimeResourceType;
  readonly abortSignal?: AbortSignal;
}): Promise<SkillResourceResolvedFacts> {
  const hash = createHash("sha256");
  const decoder = input.type === "reference" ? new StringDecoder("utf8") : undefined;
  let observedBytes = 0;
  let charCount = 0;
  let capturedText = "";
  const captureStart = Math.max(0, input.startChar - 1);
  const requestedEnd = Math.min(Number.MAX_SAFE_INTEGER, input.startChar + input.maxChars);
  const captureEnd = Math.min(Number.MAX_SAFE_INTEGER, requestedEnd + 1);
  const appendText = (text: string) => {
    if (text.length === 0) return;
    const chunkStart = charCount;
    const chunkEnd = chunkStart + text.length;
    charCount = chunkEnd;
    if (!input.includeReferenceContent || capturedText.length >= captureEnd - captureStart) return;
    const overlapStart = Math.max(captureStart, chunkStart);
    const overlapEnd = Math.min(captureEnd, chunkEnd);
    if (overlapEnd > overlapStart) {
      capturedText += text.slice(overlapStart - chunkStart, overlapEnd - chunkStart);
    }
  };
  const stream = createReadStream(input.resourceRealPath, { signal: input.abortSignal });
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    observedBytes += chunk.byteLength;
    hash.update(chunk);
    if (decoder !== undefined) appendText(decoder.write(chunk));
  }
  if (decoder !== undefined) appendText(decoder.end());
  const finalStat = await fs.stat(input.resourceRealPath, { bigint: true });
  if (!finalStat.isFile()) {
    throw new Error("Skill resource changed while it was being read.");
  }
  const finalIdentity = fileIdentity(finalStat);
  if (
    observedBytes !== Number(input.expectedIdentity.size) ||
    !sameFileIdentity(input.expectedIdentity, finalIdentity)
  ) {
    throw new Error("Skill resource changed while it was being read.");
  }
  const base = {
    ok: true as const,
    relativePath: input.relativePath,
    type: input.type,
    contentHash: `sha256:${hash.digest("hex")}`,
    byteLength: observedBytes,
  };

  if (input.type === "script") {
    return {
      ...base,
      truncated: false,
      requiresToolExecution: true,
      notExecutableByResolver: true,
      executionNote: "Skill scripts are metadata-only here; execution must go through ToolCenter confirmation.",
    };
  }

  if (input.type === "asset") {
    return {
      ...base,
      truncated: false,
    };
  }

  let content = "";
  if (input.includeReferenceContent && input.startChar <= charCount) {
    const localStart = input.startChar - captureStart;
    if (!isUtf16CodeUnitBoundary(capturedText, localStart)) {
      throw new SkillResourceReadError(
        "invalid_start_char",
        "Skill resource startChar must not split a UTF-16 surrogate pair.",
      );
    }
    const localEnd = utf16SafeWindowEnd(capturedText, localStart, input.maxChars);
    content = capturedText.slice(localStart, localEnd);
  }
  const truncated = input.includeReferenceContent
    ? charCount > input.startChar + content.length
    : charCount > requestedEnd;
  return {
    ...base,
    charCount,
    truncated,
    ...(input.includeReferenceContent ? { content } : {}),
  };
}

async function resolvePackageFacts(input: SkillResourcePackageInput): Promise<{
  readonly ok: true;
  readonly packageRealPath: string;
} | {
  readonly ok: false;
  readonly errorCode: SkillResourceResolverErrorCode;
}> {
  const packageRealPath = await fs.realpath(input.packagePath).catch((error: unknown) => {
    if (isFileNotFound(error)) {
      return undefined;
    }
    throw error;
  }).catch(() => null);
  if (packageRealPath === undefined) {
    return { ok: false, errorCode: "package_not_found" };
  }
  if (packageRealPath === null) {
    return { ok: false, errorCode: "package_not_found" };
  }

  const packageStat = await fs.stat(packageRealPath).catch(() => undefined);
  if (packageStat === undefined || !packageStat.isDirectory()) {
    return { ok: false, errorCode: "package_not_directory" };
  }

  const sourceRealPath = await fs.realpath(input.sourcePath).catch((error: unknown) => {
    if (isFileNotFound(error)) {
      return undefined;
    }
    throw error;
  }).catch(() => null);
  if (sourceRealPath === undefined) {
    return { ok: false, errorCode: "source_not_found" };
  }
  if (sourceRealPath === null || !isInsideOrEqual(packageRealPath, sourceRealPath)) {
    return { ok: false, errorCode: "source_outside_package" };
  }

  const sourceStat = await fs.stat(sourceRealPath).catch(() => undefined);
  if (sourceStat === undefined) {
    return { ok: false, errorCode: "source_not_found" };
  }
  if (!sourceStat.isFile()) {
    return { ok: false, errorCode: "source_not_file" };
  }

  return { ok: true, packageRealPath };
}

function normalizeSkillResourcePath(value: string): {
  readonly ok: true;
  readonly relativePath: string;
} | {
  readonly ok: false;
  readonly errorCode: SkillResourceResolverErrorCode;
} {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, errorCode: "empty_path" };
  }
  if (trimmed.includes("\0")) {
    return { ok: false, errorCode: "nul_in_path" };
  }
  if (
    path.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed) ||
    path.posix.isAbsolute(trimmed) ||
    /^[A-Za-z]:/.test(trimmed)
  ) {
    return { ok: false, errorCode: "absolute_path" };
  }

  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/")).replace(/^\.\//, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    return { ok: false, errorCode: "path_escape" };
  }
  return { ok: true, relativePath: normalized };
}

function isPathForResourceType(relativePath: string, type: SkillRuntimeResourceType): boolean {
  const folder = resourceFolder(type);
  return relativePath === folder || relativePath.startsWith(`${folder}/`);
}

function resourceFolder(type: SkillRuntimeResourceType): string {
  switch (type) {
    case "reference":
      return "references";
    case "asset":
      return "assets";
    case "script":
      return "scripts";
  }
}

function normalizeMaxChars(value: number | undefined): number | SkillResourceResolverErrorCode {
  if (value === undefined) {
    return DEFAULT_SKILL_RESOURCE_MAX_CHARS;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    return "invalid_max_chars";
  }
  return value;
}

function normalizeStartChar(value: number | undefined): number | SkillResourceResolverErrorCode {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    return "invalid_start_char";
  }
  return value;
}

function fileIdentity(stat: BigIntStats): SkillResourceFileIdentity {
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedAtNs: stat.mtimeNs,
    changedAtNs: stat.ctimeNs,
  };
}

function sameFileIdentity(left: SkillResourceFileIdentity, right: SkillResourceFileIdentity): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAtNs === right.modifiedAtNs &&
    left.changedAtNs === right.changedAtNs;
}

function isUtf16CodeUnitBoundary(value: string, offset: number): boolean {
  return offset <= 0 ||
    offset >= value.length ||
    !isHighSurrogate(value.charCodeAt(offset - 1)) ||
    !isLowSurrogate(value.charCodeAt(offset));
}

function utf16SafeWindowEnd(value: string, start: number, maxCodeUnits: number): number {
  let end = Math.min(value.length, start + maxCodeUnits);
  if (!isUtf16CodeUnitBoundary(value, end)) {
    end -= 1;
  }
  return Math.max(start, end);
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function errorFacts(
  type: SkillRuntimeResourceType,
  relativePath: string,
  errorCode: SkillResourceResolverErrorCode
): SkillResourceErrorFacts {
  return {
    ok: false,
    relativePath,
    type,
    truncated: false,
    errorCode,
    errorMessage: errorMessageFor(errorCode),
  };
}

function errorMessageFor(code: SkillResourceResolverErrorCode): string {
  switch (code) {
    case "empty_path":
      return "Skill resource path must not be empty.";
    case "nul_in_path":
      return "Skill resource path must not contain NUL bytes.";
    case "absolute_path":
      return "Skill resource path must be package-relative.";
    case "path_escape":
      return "Skill resource path must stay inside the skill package.";
    case "resource_type_mismatch":
      return "Skill resource path does not match the requested resource type.";
    case "invalid_max_chars":
      return "Skill resource maxChars must be a non-negative safe integer.";
    case "invalid_start_char":
      return "Skill resource startChar must be a non-negative safe integer and must not split a UTF-16 surrogate pair.";
    case "package_not_found":
      return "Skill package directory does not exist.";
    case "package_not_directory":
      return "Skill package path is not a directory.";
    case "source_not_found":
      return "Skill source file does not exist.";
    case "source_not_file":
      return "Skill source path is not a file.";
    case "source_outside_package":
      return "Skill source file must stay inside the skill package.";
    case "resource_not_found":
      return "Skill resource file does not exist.";
    case "resource_not_file":
      return "Skill resource path is not a file.";
    case "cross_package_path":
      return "Skill resource resolved outside the skill package.";
    case "resource_read_failed":
      return "Skill resource file could not be read.";
  }
}

function isInsideOrEqual(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}
