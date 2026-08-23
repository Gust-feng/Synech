import path from "node:path";

/**
 * 中性 Host path resolver：所有文件工具和后台进程复用同一份路径事实。
 * 规范化只回答“这个真实路径落在哪个引用根里”，不决定权限模式，也不读写文件内容。
 */
export type SpacePathIdentity = (value: string) => Promise<string>;

/** Run-frozen filesystem authority; callers derive it from their owning run facts. */
export type SpacePathGrant = {
  readonly referenceId: string;
  readonly kind: "file" | "folder";
  readonly path: string;
  readonly sourceIdentity?: string;
};

export type SpacePathResolution =
  | {
    readonly outcome: "resolved";
    readonly referenceId: string;
    readonly rootPath: string;
    readonly relativePath: string;
    readonly normalizedPath: string;
  }
  | { readonly outcome: "outside_reference"; readonly normalizedPath: string }
  | { readonly outcome: "mount_conflict"; readonly referenceIds: readonly string[]; readonly normalizedPath: string };

/**
 * 规范化为比较用身份：绝对化、realpath 跟随 symlink/junction、统一分隔符、去掉非根末尾分隔符。
 * Windows 用不区分大小写的形式，Unix 保留大小写语义。目标不存在时保留词法路径。
 */
export async function canonicalSpacePathIdentity(
  value: string,
  realpath: (target: string) => Promise<string>,
  platform: string = process.platform,
): Promise<string> {
  const absolute = path.resolve(value);
  const canonical = await resolveExistingAncestor(absolute, realpath);
  const slashed = canonical.replaceAll("\\", "/").replace(/(?<=[^/])\/+$/u, "");
  return platform === "win32" ? slashed.toLocaleLowerCase("en-US") : slashed;
}

async function resolveExistingAncestor(
  absolute: string,
  realpath: (target: string) => Promise<string>,
): Promise<string> {
  let candidate = absolute;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const existing = await realpath(candidate);
      return path.resolve(existing, ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) return absolute;
      missingSegments.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/** 判断 `ancestor` 是否为 `candidate` 的祖先或其本身，按段边界比较避免 `C:/work` 命中 `C:/work-2`。 */
function containsPath(ancestor: string, candidate: string): boolean {
  if (candidate === ancestor) return true;
  const prefix = ancestor.endsWith("/") ? ancestor : `${ancestor}/`;
  return candidate.startsWith(prefix);
}

/**
 * 把模型给出的真实路径解析到本轮有效的引用身份。
 * 已撤销或已删除的引用不会进入 grants；多个根同时命中时拒绝而不猜测。
 */
export async function resolveSpacePath(input: {
  readonly requestedPath: string;
  readonly grants: readonly SpacePathGrant[];
  readonly identity: SpacePathIdentity;
}): Promise<SpacePathResolution> {
  const normalizedPath = await input.identity(input.requestedPath);
  const roots = await Promise.all(
    input.grants.map(async (grant) => ({
      grant,
      root: await input.identity(grant.path),
    })),
  );

  const matches = roots.filter(({ grant, root }) =>
    grant.kind === "file" ? root === normalizedPath : containsPath(root, normalizedPath)
  );
  if (matches.length === 0) return { outcome: "outside_reference", normalizedPath };

  if (matches.length > 1) {
    return { outcome: "mount_conflict", referenceIds: matches.map(({ grant }) => grant.referenceId), normalizedPath };
  }

  const matched = matches[0]!;
  const relative = matched.grant.kind === "file"
    ? path.basename(matched.grant.path)
    : normalizedPath.slice(matched.root.length).replace(/^\/+/u, "");
  return {
    outcome: "resolved",
    referenceId: matched.grant.referenceId,
    rootPath: matched.grant.kind === "file" ? path.dirname(matched.grant.path) : matched.grant.path,
    relativePath: relative,
    normalizedPath,
  };
}
