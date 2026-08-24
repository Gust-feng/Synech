import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  CapabilitySkillCatalogItem,
  CapabilitySkillCompatibility,
  CapabilitySkillMetadataValue,
  CapabilitySkillProvenance,
  CapabilitySkillProvenanceValue,
  CapabilitySkillResourceIndexItem,
} from "../../domain/config/index.js";
import type { SkillDefinition } from "../skills/contracts.js";
import { normalizeSkillRoots, parseSkillMarkdown, type SkillRootInput } from "../skills/skill-loader.js";

export function skillRootCacheKey(roots: readonly SkillRootInput[]): string {
  return JSON.stringify(normalizeSkillRoots(roots));
}

export async function projectSkillCatalogItem(skill: SkillDefinition): Promise<CapabilitySkillCatalogItem> {
  const base = {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    enabled: skill.enabled,
    sourcePath: skill.sourcePath,
    triggers: [...skill.triggers],
    lastUsedAt: skill.lastUsedAt,
    summary: skill.summary,
    category: skill.category,
    sourceKind: skill.sourceKind,
    sourceRootId: skill.sourceRootId,
    sourcePrecedence: skill.sourcePrecedence,
    stateKey: skill.stateKey,
    version: skill.version,
    provenance: safeSkillProvenance(skill.provenance),
    whenToUse: skill.whenToUse,
    disableModelInvocation: skill.disableModelInvocation,
    userInvocable: skill.userInvocable,
  };
  const resources = await skillResourceIndex(skill);
  let raw: string;
  try {
    raw = await fs.readFile(skill.sourcePath, "utf8");
  } catch {
    return {
      ...base,
      resources,
      validationStatus: "load_error",
      loadError: "无法读取 SKILL.md 元数据。",
      validationErrors: ["skill file could not be read"],
    };
  }

  const parsed = parseSkillMarkdown(raw);
  const frontmatter = parsed.frontmatter;
  const allowedTools = safeStringArray(frontmatter.allowedTools ?? frontmatter["allowed-tools"])
    .filter(isSafeToolName);
  const metadata = safeSkillMetadata(frontmatter.metadata);
  const compatibility = safeSkillCompatibility(frontmatter.compatibility);
  const provenance = safeSkillProvenance(frontmatter.provenance);
  const validationErrors = validateSkillCatalogItem({
    id: base.id,
    name: base.name,
    description: base.description,
    contentHash: parsed.contentHash,
  });

  return {
    ...base,
    summary: skill.summary ?? firstString(frontmatter.summary),
    category: skill.category ?? firstString(frontmatter.category),
    version: skill.version ?? firstString(frontmatter.version),
    provenance: safeSkillProvenance(skill.provenance) ?? provenance,
    whenToUse: skill.whenToUse ?? firstString(frontmatter.when_to_use ?? frontmatter.whenToUse),
    disableModelInvocation: skill.disableModelInvocation ?? booleanOrUndefined(
      frontmatter["disable-model-invocation"] ?? frontmatter.disableModelInvocation,
    ),
    userInvocable: skill.userInvocable ?? booleanOrUndefined(
      frontmatter["user-invocable"] ?? frontmatter.userInvocable,
    ),
    license: firstString(frontmatter.license),
    compatibility,
    metadata,
    allowedTools,
    resources,
    contentHash: parsed.contentHash,
    bodyHash: hashBuffer(Buffer.from(parsed.body, "utf8")),
    validationStatus: validationErrors.length === 0 ? "valid" : "invalid",
    validationErrors,
  };
}

async function skillResourceIndex(skill: SkillDefinition): Promise<readonly CapabilitySkillResourceIndexItem[]> {
  const agentSkill = skill as SkillDefinition & {
    readonly scripts?: readonly string[];
    readonly references?: readonly string[];
    readonly assets?: readonly string[];
  };
  const resources = [
    ...(agentSkill.scripts ?? []).map((sourcePath) => ({ kind: "script" as const, sourcePath })),
    ...(agentSkill.references ?? []).map((sourcePath) => ({ kind: "reference" as const, sourcePath })),
    ...(agentSkill.assets ?? []).map((sourcePath) => ({ kind: "asset" as const, sourcePath })),
  ];
  return Promise.all(resources.map(async (resource): Promise<CapabilitySkillResourceIndexItem> => {
    try {
      const content = await fs.readFile(resource.sourcePath);
      return {
        kind: resource.kind,
        name: path.basename(resource.sourcePath),
        relativePath: toSkillRelativeResourcePath(skill, resource.sourcePath),
        sourcePath: resource.sourcePath,
        contentHash: hashBuffer(content),
        byteLength: content.byteLength,
      };
    } catch {
      return {
        kind: resource.kind,
        name: path.basename(resource.sourcePath),
        relativePath: toSkillRelativeResourcePath(skill, resource.sourcePath),
        sourcePath: resource.sourcePath,
        loadError: "无法读取资源。",
      };
    }
  }));
}

function toSkillRelativeResourcePath(skill: SkillDefinition, sourcePath: string): string | undefined {
  const candidate = skill as SkillDefinition & { readonly packagePath?: unknown };
  const packagePath = typeof candidate.packagePath === "string" && candidate.packagePath.trim().length > 0
    ? candidate.packagePath
    : path.dirname(skill.sourcePath);
  const relativePath = path.relative(packagePath, sourcePath);
  if (relativePath.length === 0 || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return undefined;
  return relativePath.replace(/\\/g, "/");
}

function safeSkillMetadata(value: unknown): Readonly<Record<string, CapabilitySkillMetadataValue>> | undefined {
  if (!isPlainObject(value)) return undefined;
  const safe: Record<string, CapabilitySkillMetadataValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isSafeMetadataKey(key)) continue;
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      safe[key] = item;
    } else if (Array.isArray(item) && item.every((entry): entry is string => typeof entry === "string")) {
      safe[key] = item;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function safeSkillProvenance(value: unknown): CapabilitySkillProvenance | undefined {
  if (!isPlainObject(value)) return undefined;
  const safe: Record<string, CapabilitySkillProvenanceValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isSafeMetadataKey(key)) continue;
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      safe[key] = item;
    } else if (Array.isArray(item) && item.every(isProvenanceArrayValue)) {
      safe[key] = item;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function safeSkillCompatibility(value: unknown): CapabilitySkillCompatibility | undefined {
  if (typeof value === "string") return { requirement: value };
  if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")) {
    return { requirements: value };
  }
  if (!isPlainObject(value)) return undefined;
  const safe: Record<string, string | readonly string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") safe[key] = item;
    else if (Array.isArray(item) && item.every((entry): entry is string => typeof entry === "string")) {
      safe[key] = item;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function validateSkillCatalogItem(skill: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly contentHash?: string;
}): readonly string[] {
  const errors: string[] = [];
  if (skill.id.trim().length === 0) errors.push("id is required");
  if (skill.name.trim().length === 0) errors.push("name is required");
  if (skill.description.trim().length === 0) errors.push("description is required");
  if (skill.contentHash === undefined) errors.push("content hash is required");
  return errors;
}

function safeStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
  }
  const single = firstString(value);
  return single === undefined ? [] : [single];
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeToolName(value: string): boolean {
  return /^[A-Za-z0-9_.:-]+$/.test(value);
}

function isSafeMetadataKey(value: string): boolean {
  return /^[A-Za-z0-9_.:-]+$/.test(value) && !/(?:body|content|path|source|resource|secret|token|key)/i.test(value);
}

function isProvenanceArrayValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function hashBuffer(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
