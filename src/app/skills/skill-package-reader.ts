import { promises as fs } from "node:fs";
import path from "node:path";
import { isFileNotFound } from "../../kernel/values/index.js";
import type { SkillDefinition } from "./contracts.js";
import { skillStateKeyForFacts } from "./skill-state-store.js";
import {
  normalizeSkillFrontmatter,
  parseSkillMarkdown,
  validateSkillFrontmatter,
  validateSkillOptionalFrontmatter,
  type NormalizedSkillFrontmatter,
  type SkillCompatibility,
  type SkillJsonValue,
  type SkillValidationIssue,
} from "./skill-validation.js";

export type SkillSourceKind = "project" | "user" | "plugin" | "admin" | "custom";

export type SkillRootDescriptor = {
  readonly rootPath: string;
  readonly sourceKind: SkillSourceKind;
  readonly sourceRootId: string;
  readonly precedence: number;
};

export type SkillDisclosureLevel = "header" | "summary" | "full";

export type SkillPackageResourceType = "script" | "reference" | "asset" | "eval";

export type SkillRuntimeResourceType = Exclude<SkillPackageResourceType, "eval">;

export type SkillPackageResourceIndexItem = {
  readonly relativePath: string;
  readonly type: SkillPackageResourceType;
  readonly exists: boolean;
  readonly source: "frontmatter" | "directory";
};

export type SkillBodyFacts = {
  readonly body: string;
  readonly contentHash: string;
  readonly bodyHash: string;
  readonly metadataHash: string;
};

export type AgentSkillDefinition = SkillDefinition & {
  readonly packageName: string;
  readonly packagePath: string;
  readonly loadError?: string;
  readonly validationErrors?: readonly SkillValidationIssue[];
  readonly license?: string;
  readonly compatibility?: SkillCompatibility;
  readonly version?: string;
  readonly provenance?: Readonly<Record<string, SkillJsonValue>>;
  readonly metadata?: Readonly<Record<string, SkillJsonValue>>;
  readonly allowedTools?: readonly string[];
  readonly whenToUse?: string;
  readonly disableModelInvocation?: boolean;
  readonly userInvocable?: boolean;
  readonly sourceKind: SkillSourceKind;
  readonly sourceRootId: string;
  readonly sourcePrecedence: number;
  readonly sourceRootPath: string;
  readonly stateKey: string;
  readonly assets?: readonly string[];
  readonly evals?: readonly string[];
  readonly resourceIndex: readonly SkillPackageResourceIndexItem[];
  readonly contentHash: string;
  readonly bodyHash: string;
  readonly metadataHash: string;
};

type ResourceDiscoveryResult = {
  readonly index: readonly SkillPackageResourceIndexItem[];
  readonly scripts: readonly string[];
  readonly references: readonly string[];
  readonly assets: readonly string[];
  readonly evals: readonly string[];
  readonly issues: readonly SkillValidationIssue[];
};

export async function loadSkillBody(skill: SkillDefinition): Promise<string> {
  return (await loadSkillBodyFacts(skill)).body;
}

export async function loadSkillBodyFacts(skill: SkillDefinition): Promise<SkillBodyFacts> {
  const loadError = skillLoadError(skill);
  if (loadError !== undefined) {
    throw new Error(`Cannot load invalid skill "${skill.id}": ${loadError}`);
  }
  const raw = await fs.readFile(skill.sourcePath, "utf8");
  const parsed = parseSkillMarkdown(raw);
  return {
    body: parsed.body.trim(),
    contentHash: parsed.contentHash,
    bodyHash: parsed.bodyHash,
    metadataHash: parsed.metadataHash,
  };
}

export function getSkillDisclosure(
  skill: SkillDefinition,
  level: SkillDisclosureLevel
): string {
  switch (level) {
    case "header":
      return `${skill.name}: ${skill.description}`;
    case "summary":
      return skill.summary ?? skill.description;
    case "full":
      // Full body must be loaded via loadSkillBody; return description as a
      // fallback placeholder when the caller does not await the async load.
      return skill.summary ?? skill.description;
  }
}

export async function readSkillDefinition(
  root: SkillRootDescriptor,
  skillDir: string,
  packageName: string
): Promise<AgentSkillDefinition> {
  const sourcePath = path.join(skillDir, "SKILL.md");
  const resolvedSourcePath = path.resolve(sourcePath);
  const resolvedSkillDir = path.resolve(skillDir);
  const missingSourceHashes = parseSkillMarkdown("");
  const raw: string | Error | undefined = await fs.readFile(sourcePath, "utf8").catch((error: unknown) => {
    if (isFileNotFound(error)) {
      return undefined;
    }
    return error instanceof Error ? error : new Error(String(error));
  });
  if (raw === undefined || raw instanceof Error) {
    const message = raw === undefined
      ? "Skill package must contain SKILL.md."
      : `Failed to read SKILL.md: ${errorMessage(raw)}`;
    return invalidSkillDefinition({
      packageName,
      packagePath: resolvedSkillDir,
      sourcePath: resolvedSourcePath,
      root,
      loadError: message,
      hashes: missingSourceHashes,
      issues: [{
        code: raw === undefined ? "missing_skill_md" : "skill_read_failed",
        message,
      }],
    });
  }

  const parsed = parseSkillMarkdown(raw);
  const frontmatter = normalizeSkillFrontmatter(parsed.frontmatter);
  const resourceDiscovery = await discoverPackageResources(resolvedSkillDir, frontmatter);
  const validationErrors = [
    ...validateSkillFrontmatter({ packageName, frontmatter }),
    ...validateSkillOptionalFrontmatter(parsed.frontmatter),
    ...resourceDiscovery.issues,
  ];
  const hasErrors = validationErrors.length > 0;
  const name = frontmatter.name ?? packageName;
  const id = safeSkillId(hasErrors ? packageName : frontmatter.id ?? name);
  const description = frontmatter.description ?? firstParagraph(parsed.body) ?? "";
  const loadError = hasErrors ? validationErrors.map((issue) => issue.message).join(" ") : undefined;
  return {
    id,
    name,
    description,
    enabled: hasErrors ? false : frontmatter.enabled,
    sourcePath: resolvedSourcePath,
    triggers: [...frontmatter.triggers],
    lastUsedAt: frontmatter.lastUsedAt,
    summary: frontmatter.summary,
    category: frontmatter.category,
    whenToUse: frontmatter.whenToUse,
    disableModelInvocation: frontmatter.disableModelInvocation,
    userInvocable: frontmatter.userInvocable,
    sourceKind: root.sourceKind,
    sourceRootId: root.sourceRootId,
    sourcePrecedence: root.precedence,
    sourceRootPath: root.rootPath,
    stateKey: skillStateKeyForFacts({ skillId: id, sourceRootId: root.sourceRootId }),
    scripts: resourceDiscovery.scripts.length > 0 ? resourceDiscovery.scripts : undefined,
    references: resourceDiscovery.references.length > 0 ? resourceDiscovery.references : undefined,
    packageName,
    packagePath: resolvedSkillDir,
    loadError,
    validationErrors: hasErrors ? validationErrors : undefined,
    license: frontmatter.license,
    compatibility: frontmatter.compatibility,
    version: frontmatter.version,
    provenance: frontmatter.provenance,
    metadata: frontmatter.metadata,
    allowedTools: frontmatter.allowedTools.length > 0 ? [...frontmatter.allowedTools] : undefined,
    assets: resourceDiscovery.assets.length > 0 ? resourceDiscovery.assets : undefined,
    evals: resourceDiscovery.evals.length > 0 ? resourceDiscovery.evals : undefined,
    resourceIndex: resourceDiscovery.index,
    contentHash: parsed.contentHash,
    bodyHash: parsed.bodyHash,
    metadataHash: parsed.metadataHash,
  };
}

function invalidSkillDefinition(input: {
  readonly packageName: string;
  readonly packagePath: string;
  readonly sourcePath: string;
  readonly root: SkillRootDescriptor;
  readonly loadError: string;
  readonly hashes: Pick<ReturnType<typeof parseSkillMarkdown>, "contentHash" | "bodyHash" | "metadataHash">;
  readonly issues: readonly SkillValidationIssue[];
}): AgentSkillDefinition {
  return {
    id: safeSkillId(input.packageName),
    name: input.packageName,
    description: "",
    enabled: false,
    sourcePath: input.sourcePath,
    triggers: [],
    packageName: input.packageName,
    packagePath: input.packagePath,
    sourceKind: input.root.sourceKind,
    sourceRootId: input.root.sourceRootId,
    sourcePrecedence: input.root.precedence,
    sourceRootPath: input.root.rootPath,
    stateKey: skillStateKeyForFacts({ skillId: safeSkillId(input.packageName), sourceRootId: input.root.sourceRootId }),
    loadError: input.loadError,
    validationErrors: input.issues,
    resourceIndex: [],
    contentHash: input.hashes.contentHash,
    bodyHash: input.hashes.bodyHash,
    metadataHash: input.hashes.metadataHash,
  };
}

async function discoverPackageResources(
  skillDir: string,
  frontmatter: NormalizedSkillFrontmatter
): Promise<ResourceDiscoveryResult> {
  const entries = new Map<string, SkillPackageResourceIndexItem>();
  const scripts: string[] = [];
  const references: string[] = [];
  const assets: string[] = [];
  const evals: string[] = [];
  const issues: SkillValidationIssue[] = [];
  const declaredSpecs: readonly {
    readonly type: SkillPackageResourceType;
    readonly paths: readonly string[];
    readonly absolutePaths: string[];
  }[] = [
    { type: "script", paths: frontmatter.scripts, absolutePaths: scripts },
    { type: "reference", paths: frontmatter.references, absolutePaths: references },
    { type: "asset", paths: frontmatter.assets, absolutePaths: assets },
  ];

  for (const spec of declaredSpecs) {
    for (const candidate of spec.paths) {
      const normalized = normalizeSkillRelativePath(candidate);
      if (normalized === undefined) {
        issues.push({
          code: "unsafe_resource_path",
          path: resourceFrontmatterPath(spec.type),
          message: `Skill resource path "${candidate}" must stay inside the skill package.`,
        });
        continue;
      }
      spec.absolutePaths.push(path.resolve(skillDir, normalized));
      entries.set(resourceKey(spec.type, normalized), {
        relativePath: normalized,
        type: spec.type,
        exists: await pathExists(path.resolve(skillDir, normalized)),
        source: "frontmatter",
      });
    }
  }

  for (const type of ["script", "reference", "asset", "eval"] as const) {
    const folder = resourceFolder(type);
    const discovered = await listFilesUnderDirectory(path.join(skillDir, folder), folder);
    for (const relativePath of discovered) {
      const key = resourceKey(type, relativePath);
      if (!entries.has(key)) {
        entries.set(key, {
          relativePath,
          type,
          exists: true,
          source: "directory",
        });
        if (type === "eval") {
          evals.push(path.resolve(skillDir, relativePath));
        }
      }
    }
  }

  return {
    scripts,
    references,
    assets,
    evals,
    issues,
    index: [...entries.values()].sort((left, right) =>
      left.type.localeCompare(right.type) || left.relativePath.localeCompare(right.relativePath)
    ),
  };
}

async function listFilesUnderDirectory(root: string, relativeRoot: string): Promise<readonly string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (isFileNotFound(error)) {
      return [];
    }
    throw error;
  });
  const results = await Promise.all(entries.map(async (entry) => {
    const relativePath = toPosixPath(path.join(relativeRoot, entry.name));
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listFilesUnderDirectory(absolutePath, relativePath);
    }
    return [relativePath];
  }));
  return results.flat();
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.stat(candidate).then(
    () => true,
    () => false
  );
}

function resourceFolder(type: SkillPackageResourceType): string {
  switch (type) {
    case "script":
      return "scripts";
    case "reference":
      return "references";
    case "asset":
      return "assets";
    case "eval":
      return "evals";
  }
}

function resourceFrontmatterPath(type: SkillPackageResourceType): string {
  switch (type) {
    case "script":
      return "scripts";
    case "reference":
      return "references";
    case "asset":
      return "assets";
    case "eval":
      return "evals";
  }
}

function resourceKey(type: SkillPackageResourceType, relativePath: string): string {
  return `${type}:${relativePath}`;
}

function normalizeSkillRelativePath(value: string): string | undefined {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (
    trimmed.length === 0 ||
    trimmed.includes("\0") ||
    trimmed.startsWith("/") ||
    /^[A-Za-z]:\//.test(trimmed)
  ) {
    return undefined;
  }
  const normalized = path.posix.normalize(trimmed).replace(/^\.\//, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

function firstParagraph(value: string): string | undefined {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/^#+\s*/, "").trim())
    .find((paragraph) => paragraph.length > 0);
}

function safeSkillId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function errorMessage(error: Error): string {
  return error.message.trim() || error.name;
}

export function skillLoadError(skill: SkillDefinition): string | undefined {
  const candidate = skill as SkillDefinition & { readonly loadError?: unknown };
  return typeof candidate.loadError === "string" && candidate.loadError.length > 0 ? candidate.loadError : undefined;
}
