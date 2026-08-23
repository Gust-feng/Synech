import { isPlainRecord } from "../../kernel/values/index.js";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";

export type SubAgentValidationIssue = {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
};

export type ParsedSubAgentMarkdown = {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly normalizedContent: string;
  readonly contentHash: string;
  readonly bodyHash: string;
  readonly metadataHash: string;
};

export type NormalizedSubAgentFrontmatter = {
  readonly name?: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly version?: string;
  readonly category?: string;
  readonly whenToUse: readonly string[];
  readonly whenNotToUse: readonly string[];
  readonly allowedTools: readonly string[];
};

export function parseSubAgentMarkdown(raw: string): ParsedSubAgentMarkdown {
  const normalizedContent = raw.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalizedContent);
  const frontmatter = match === null ? {} : parseYamlFrontmatter(match[1]!.trim());
  const body = match === null ? normalizedContent : normalizedContent.slice(match[0].length);
  return {
    frontmatter,
    body,
    normalizedContent,
    contentHash: hashSubAgentText(normalizedContent),
    bodyHash: hashSubAgentText(body.trim()),
    metadataHash: hashSubAgentText(stableStringify(frontmatter)),
  };
}

export function normalizeSubAgentFrontmatter(
  frontmatter: Readonly<Record<string, unknown>>
): NormalizedSubAgentFrontmatter {
  return {
    name: firstString(frontmatter.name),
    description: firstString(frontmatter.description),
    enabled: booleanOrDefault(frontmatter.enabled, true),
    version: firstString(frontmatter.version),
    category: firstString(frontmatter.category),
    whenToUse: stringArray(frontmatter["when-to-use"] ?? frontmatter.whenToUse),
    whenNotToUse: stringArray(frontmatter["when-not-to-use"] ?? frontmatter.whenNotToUse),
    allowedTools: stringArray(frontmatter["allowed-tools"] ?? frontmatter.allowedTools),
  };
}

export function validateSubAgentFrontmatter(
  frontmatter: NormalizedSubAgentFrontmatter,
): readonly SubAgentValidationIssue[] {
  const issues: SubAgentValidationIssue[] = [];

  const name = frontmatter.name;
  if (name === undefined) {
    issues.push({
      code: "missing_name",
      path: "name",
      message: "SUB_AGENT.md frontmatter must include name.",
    });
  } else if (name.length > 64) {
    issues.push({
      code: "invalid_name",
      path: "name",
      message: "Sub-agent name must be 1-64 characters.",
    });
  }

  const description = frontmatter.description;
  if (description === undefined) {
    issues.push({
      code: "missing_description",
      path: "description",
      message: "SUB_AGENT.md frontmatter must include description.",
    });
  } else if (description.length > 160) {
    issues.push({
      code: "invalid_description",
      path: "description",
      message: "Sub-agent description must be 1-160 characters.",
    });
  }

  return issues;
}

export function diagnoseIgnoredSubAgentFrontmatter(
  rawFrontmatter: Readonly<Record<string, unknown>>,
): readonly SubAgentValidationIssue[] {
  const warnings: SubAgentValidationIssue[] = [];
  if (hasOwnFrontmatterKey(rawFrontmatter, "model")) {
    warnings.push({
      code: "ignored_model_override",
      path: "model",
      message: "Sub-agent model override is ignored; nested agents use the parent run's frozen model.",
    });
  }

  const maxStepsKey = hasOwnFrontmatterKey(rawFrontmatter, "max-steps")
    ? "max-steps"
    : hasOwnFrontmatterKey(rawFrontmatter, "maxSteps")
      ? "maxSteps"
      : undefined;
  if (maxStepsKey !== undefined) {
    warnings.push({
      code: "ignored_step_limit",
      path: maxStepsKey,
      message: "Sub-agent step limit is ignored because the nested loop has no defined step unit.",
    });
  }
  return warnings;
}

export function hashSubAgentText(value: string): string {
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

function hasOwnFrontmatterKey(frontmatter: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(frontmatter, key);
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