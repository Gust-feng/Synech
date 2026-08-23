import { isPlainRecord } from "../../kernel/values/index.js";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";

export type SkillJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly SkillJsonValue[]
  | { readonly [key: string]: SkillJsonValue };

export type SkillCompatibility =
  | string
  | readonly string[]
  | { readonly [key: string]: SkillJsonValue };

export type SkillValidationIssue = {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
};

export type ParsedSkillMarkdown = {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly normalizedContent: string;
  readonly contentHash: string;
  readonly bodyHash: string;
  readonly metadataHash: string;
};

export type NormalizedSkillFrontmatter = {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly triggers: readonly string[];
  readonly lastUsedAt?: string;
  readonly summary?: string;
  readonly category?: string;
  readonly version?: string;
  readonly provenance?: Readonly<Record<string, SkillJsonValue>>;
  readonly whenToUse?: string;
  readonly disableModelInvocation: boolean;
  readonly userInvocable: boolean;
  readonly scripts: readonly string[];
  readonly references: readonly string[];
  readonly assets: readonly string[];
  readonly license?: string;
  readonly compatibility?: SkillCompatibility;
  readonly metadata?: Readonly<Record<string, SkillJsonValue>>;
  readonly allowedTools: readonly string[];
};

export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
  const normalizedContent = raw.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalizedContent);
  const frontmatter = match === null ? {} : parseYamlFrontmatter(match[1]!.trim());
  const body = match === null ? normalizedContent : normalizedContent.slice(match[0].length);
  return {
    frontmatter,
    body,
    normalizedContent,
    contentHash: hashSkillText(normalizedContent),
    bodyHash: hashSkillText(body.trim()),
    metadataHash: hashSkillText(stableStringify(frontmatter)),
  };
}

export function normalizeSkillFrontmatter(
  frontmatter: Readonly<Record<string, unknown>>
): NormalizedSkillFrontmatter {
  return {
    id: firstString(frontmatter.id),
    name: firstString(frontmatter.name),
    description: firstString(frontmatter.description),
    enabled: booleanOrDefault(frontmatter.enabled, true),
    triggers: stringArray(frontmatter.triggers),
    lastUsedAt: firstString(frontmatter.lastUsedAt),
    summary: firstString(frontmatter.summary),
    category: firstString(frontmatter.category),
    version: firstString(frontmatter.version),
    provenance: normalizeMetadata(frontmatter.provenance),
    whenToUse: firstString(frontmatter.when_to_use ?? frontmatter.whenToUse),
    disableModelInvocation: booleanOrDefault(frontmatter["disable-model-invocation"] ?? frontmatter.disableModelInvocation, false),
    userInvocable: booleanOrDefault(frontmatter["user-invocable"] ?? frontmatter.userInvocable, true),
    scripts: stringArray(frontmatter.scripts),
    references: stringArray(frontmatter.references),
    assets: stringArray(frontmatter.assets),
    license: firstString(frontmatter.license),
    compatibility: normalizeCompatibility(frontmatter.compatibility),
    metadata: normalizeMetadata(frontmatter.metadata),
    allowedTools: stringArray(frontmatter["allowed-tools"] ?? frontmatter.allowedTools),
  };
}

export function validateSkillFrontmatter(input: {
  readonly packageName: string;
  readonly frontmatter: NormalizedSkillFrontmatter;
}): readonly SkillValidationIssue[] {
  const issues: SkillValidationIssue[] = [];
  const name = input.frontmatter.name;
  if (name === undefined) {
    issues.push({
      code: "missing_name",
      path: "name",
      message: "SKILL.md frontmatter must include name.",
    });
  } else {
    if (!isOfficialSkillName(name)) {
      issues.push({
        code: "invalid_name",
        path: "name",
        message: "Skill name must be 1-64 lowercase letters, numbers, or hyphens without leading, trailing, or repeated hyphens.",
      });
    }
    if (name !== input.packageName) {
      issues.push({
        code: "name_directory_mismatch",
        path: "name",
        message: `Skill name must match package directory "${input.packageName}".`,
      });
    }
  }

  const description = input.frontmatter.description;
  if (description === undefined) {
    issues.push({
      code: "missing_description",
      path: "description",
      message: "SKILL.md frontmatter must include description.",
    });
  } else if (description.length > 1024) {
    issues.push({
      code: "invalid_description",
      path: "description",
      message: "Skill description must be 1-1024 characters.",
    });
  }

  if (input.frontmatter.license !== undefined && input.frontmatter.license.length > 256) {
    issues.push({
      code: "invalid_license",
      path: "license",
      message: "Skill license must be a concise string.",
    });
  }

  return issues;
}

export function validateSkillOptionalFrontmatter(
  frontmatter: Readonly<Record<string, unknown>>
): readonly SkillValidationIssue[] {
  const issues: SkillValidationIssue[] = [];
  if (frontmatter.compatibility !== undefined && normalizeCompatibility(frontmatter.compatibility) === undefined) {
    issues.push({
      code: "invalid_compatibility",
      path: "compatibility",
      message: "Skill compatibility must be a string, string array, or metadata object.",
    });
  }
  if (frontmatter.metadata !== undefined && normalizeMetadata(frontmatter.metadata) === undefined) {
    issues.push({
      code: "invalid_metadata",
      path: "metadata",
      message: "Skill metadata must be a YAML object containing JSON-safe values.",
    });
  }
  if (frontmatter.provenance !== undefined && normalizeMetadata(frontmatter.provenance) === undefined) {
    issues.push({
      code: "invalid_provenance",
      path: "provenance",
      message: "Skill provenance must be a YAML object containing JSON-safe values.",
    });
  }
  if (
    (frontmatter["allowed-tools"] !== undefined || frontmatter.allowedTools !== undefined) &&
    stringArray(frontmatter["allowed-tools"] ?? frontmatter.allowedTools).length === 0
  ) {
    issues.push({
      code: "invalid_allowed_tools",
      path: "allowed-tools",
      message: "Skill allowed-tools must be a non-empty string or list of strings when present.",
    });
  }
  return issues;
}

export function hashSkillText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function stringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
  }
  const single = firstString(value);
  return single === undefined ? [] : [single];
}

export function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isOfficialSkillName(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value) && !value.includes("--");
}

function normalizeCompatibility(value: unknown): SkillCompatibility | undefined {
  const single = firstString(value);
  if (single !== undefined) {
    return single;
  }
  const values = stringArray(value);
  if (values.length > 0) {
    return values;
  }
  if (isPlainRecord(value)) {
    return normalizeJsonRecord(value);
  }
  return undefined;
}

function normalizeMetadata(value: unknown): Readonly<Record<string, SkillJsonValue>> | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  return normalizeJsonRecord(value);
}

function normalizeJsonRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, SkillJsonValue>> | undefined {
  const normalized: Record<string, SkillJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const jsonValue = normalizeJsonValue(item);
    if (jsonValue === undefined) {
      return undefined;
    }
    normalized[key] = jsonValue;
  }
  return normalized;
}

function normalizeJsonValue(value: unknown): SkillJsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const values: SkillJsonValue[] = [];
    for (const item of value) {
      const normalized = normalizeJsonValue(item);
      if (normalized === undefined) {
        return undefined;
      }
      values.push(normalized);
    }
    return values;
  }
  if (isPlainRecord(value)) {
    return normalizeJsonRecord(value);
  }
  return undefined;
}


function parseYamlFrontmatter(value: string): Readonly<Record<string, unknown>> {
  if (value.trim().length === 0) {
    return {};
  }
  try {
    const document = parseDocument(value, {
      schema: "core",
      merge: true,
      prettyErrors: false,
    });
    if (document.errors.length > 0) {
      return {};
    }
    const parsed = document.toJS({
      mapAsMap: false,
      maxAliasCount: 32,
    });
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
