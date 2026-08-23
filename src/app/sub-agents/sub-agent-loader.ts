import { promises as fs } from "node:fs";
import path from "node:path";
import { isFileNotFound } from "../../kernel/values/index.js";
import {
  diagnoseIgnoredSubAgentFrontmatter,
  normalizeSubAgentFrontmatter,
  parseSubAgentMarkdown,
  validateSubAgentFrontmatter,
  type SubAgentValidationIssue,
} from "./sub-agent-validation.js";

export type { SubAgentValidationIssue } from "./sub-agent-validation.js";
export { hashSubAgentText, parseSubAgentMarkdown } from "./sub-agent-validation.js";

export type SubAgentDiscoveryOptions = {
  readonly roots: readonly SubAgentRootInput[];
};

export type SubAgentSourceKind = "builtin" | "project" | "user" | "custom";

export type SubAgentRootDescriptor = {
  readonly rootPath: string;
  readonly sourceKind: SubAgentSourceKind;
  readonly sourceRootId: string;
  readonly precedence: number;
};

export type SubAgentRootInput = string | SubAgentRootDescriptor;

export type SubAgentDefinition = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly sourcePath: string;
  readonly inlineSystemPrompt?: string;
  readonly version?: string;
  readonly category?: string;
  readonly whenToUse: readonly string[];
  readonly whenNotToUse: readonly string[];
  readonly allowedTools: readonly string[];
  readonly sourceKind: SubAgentSourceKind;
  readonly sourceRootId: string;
  readonly sourcePrecedence: number;
  readonly sourceRootPath: string;
  readonly packageName: string;
  readonly packagePath: string;
  readonly loadError?: string;
  readonly validationErrors?: readonly SubAgentValidationIssue[];
  readonly validationWarnings?: readonly SubAgentValidationIssue[];
  readonly contentHash: string;
  readonly bodyHash: string;
  readonly metadataHash: string;
};

export async function discoverSubAgents(
  options: SubAgentDiscoveryOptions
): Promise<readonly SubAgentDefinition[]> {
  const roots = normalizeSubAgentRoots(options.roots);
  const discovered = await Promise.all(roots.map((root) => discoverSubAgentsUnderRoot(root)));
  const subAgents = discovered.flat();
  return [...dedupeSubAgents(subAgents)].sort(compareDiscoveredSubAgents);
}

export async function loadSubAgentBody(subAgent: SubAgentDefinition): Promise<string> {
  return (await loadSubAgentBodyFacts(subAgent)).body;
}

export async function loadSubAgentBodyFacts(subAgent: SubAgentDefinition): Promise<{
  readonly body: string;
  readonly contentHash: string;
  readonly bodyHash: string;
  readonly metadataHash: string;
}> {
  const loadError = subAgent.loadError;
  if (loadError !== undefined) {
    throw new Error(`Cannot load invalid sub-agent "${subAgent.id}": ${loadError}`);
  }
  const raw = await fs.readFile(subAgent.sourcePath, "utf8");
  const parsed = parseSubAgentMarkdown(raw);
  const facts = {
    body: parsed.body.trim(),
    contentHash: parsed.contentHash,
    bodyHash: parsed.bodyHash,
    metadataHash: parsed.metadataHash,
  };
  assertSubAgentDefinitionHashesMatch(subAgent, facts);
  return facts;
}

async function discoverSubAgentsUnderRoot(
  root: SubAgentRootDescriptor
): Promise<readonly SubAgentDefinition[]> {
  const entries = await fs.readdir(root.rootPath, { withFileTypes: true }).catch((error: unknown) => {
    if (isFileNotFound(error)) {
      return [];
    }
    throw error;
  });
  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readSubAgentDefinition(root, path.join(root.rootPath, entry.name), entry.name))
  );
}

async function readSubAgentDefinition(
  root: SubAgentRootDescriptor,
  subAgentDir: string,
  packageName: string
): Promise<SubAgentDefinition> {
  const sourcePath = path.join(subAgentDir, "SUB_AGENT.md");
  const resolvedSourcePath = path.resolve(sourcePath);
  const resolvedSubAgentDir = path.resolve(subAgentDir);
  const missingSourceHashes = parseSubAgentMarkdown("");
  const raw: string | Error | undefined = await fs
    .readFile(sourcePath, "utf8")
    .catch((error: unknown) => {
      if (isFileNotFound(error)) {
        return undefined;
      }
      return error instanceof Error ? error : new Error(String(error));
    });
  if (raw === undefined || raw instanceof Error) {
    const message =
      raw === undefined
        ? "Sub-agent package must contain SUB_AGENT.md."
        : `Failed to read SUB_AGENT.md: ${errorMessage(raw)}`;
    return invalidSubAgentDefinition({
      packageName,
      packagePath: resolvedSubAgentDir,
      sourcePath: resolvedSourcePath,
      root,
      loadError: message,
      hashes: missingSourceHashes,
      issues: [
        {
          code: raw === undefined ? "missing_sub_agent_md" : "sub_agent_read_failed",
          message,
        },
      ],
    });
  }

  const parsed = parseSubAgentMarkdown(raw);
  const frontmatter = normalizeSubAgentFrontmatter(parsed.frontmatter);
  const validationErrors = validateSubAgentFrontmatter(frontmatter);
  const validationWarnings = diagnoseIgnoredSubAgentFrontmatter(parsed.frontmatter);
  const hasErrors = validationErrors.length > 0;
  const name = frontmatter.name ?? packageName;
  const id = safeSubAgentId(hasErrors ? packageName : name);
  const description = frontmatter.description ?? firstParagraph(parsed.body) ?? "";
  const loadError = hasErrors ? validationErrors.map((issue) => issue.message).join(" ") : undefined;
  return {
    id,
    name,
    description,
    enabled: hasErrors ? false : frontmatter.enabled,
    sourcePath: resolvedSourcePath,
    version: frontmatter.version,
    category: frontmatter.category,
    whenToUse: [...frontmatter.whenToUse],
    whenNotToUse: [...frontmatter.whenNotToUse],
    allowedTools: [...frontmatter.allowedTools],
    sourceKind: root.sourceKind,
    sourceRootId: root.sourceRootId,
    sourcePrecedence: root.precedence,
    sourceRootPath: root.rootPath,
    packageName,
    packagePath: resolvedSubAgentDir,
    loadError,
    validationErrors: hasErrors ? validationErrors : undefined,
    validationWarnings: validationWarnings.length > 0 ? validationWarnings : undefined,
    contentHash: parsed.contentHash,
    bodyHash: parsed.bodyHash,
    metadataHash: parsed.metadataHash,
  };
}

function invalidSubAgentDefinition(input: {
  readonly packageName: string;
  readonly packagePath: string;
  readonly sourcePath: string;
  readonly root: SubAgentRootDescriptor;
  readonly loadError: string;
  readonly hashes: Pick<ReturnType<typeof parseSubAgentMarkdown>, "contentHash" | "bodyHash" | "metadataHash">;
  readonly issues: readonly SubAgentValidationIssue[];
}): SubAgentDefinition {
  return {
    id: safeSubAgentId(input.packageName),
    name: input.packageName,
    description: "",
    enabled: false,
    sourcePath: input.sourcePath,
    whenToUse: [],
    whenNotToUse: [],
    allowedTools: [],
    packageName: input.packageName,
    packagePath: input.packagePath,
    sourceKind: input.root.sourceKind,
    sourceRootId: input.root.sourceRootId,
    sourcePrecedence: input.root.precedence,
    sourceRootPath: input.root.rootPath,
    loadError: input.loadError,
    validationErrors: input.issues,
    contentHash: input.hashes.contentHash,
    bodyHash: input.hashes.bodyHash,
    metadataHash: input.hashes.metadataHash,
  };
}

function dedupeSubAgents(subAgents: readonly SubAgentDefinition[]): readonly SubAgentDefinition[] {
  const sorted = [...subAgents].sort(compareSubAgentPrecedence);
  const byId = new Map<string, SubAgentDefinition>();
  const byName = new Map<string, SubAgentDefinition>();
  const unique: SubAgentDefinition[] = [];
  for (const subAgent of sorted) {
    const idKey = normalizeSubAgentKey(subAgent.id);
    const nameKey = normalizeSubAgentKey(subAgent.name);
    if (byId.has(idKey)) {
      continue;
    }
    if (byName.has(nameKey)) {
      continue;
    }
    byId.set(idKey, subAgent);
    byName.set(nameKey, subAgent);
    unique.push(subAgent);
  }
  return unique;
}

function compareSubAgentPrecedence(left: SubAgentDefinition, right: SubAgentDefinition): number {
  return right.sourcePrecedence - left.sourcePrecedence || left.name.localeCompare(right.name);
}

function compareDiscoveredSubAgents(left: SubAgentDefinition, right: SubAgentDefinition): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

export function normalizeSubAgentRoots(
  roots: readonly SubAgentRootInput[]
): readonly SubAgentRootDescriptor[] {
  return roots.map((root, index) => normalizeSubAgentRoot(root, index));
}

function normalizeSubAgentRoot(root: SubAgentRootInput, index: number): SubAgentRootDescriptor {
  if (typeof root === "string") {
    const rootPath = path.resolve(root);
    return {
      rootPath,
      sourceKind: "custom",
      sourceRootId: `custom:${index + 1}`,
      precedence: index,
    };
  }
  return {
    rootPath: path.resolve(root.rootPath),
    sourceKind: root.sourceKind,
    sourceRootId: safeSourceRootId(root.sourceRootId, root.sourceKind, index),
    precedence: Number.isFinite(root.precedence) ? Math.trunc(root.precedence) : index,
  };
}

function safeSourceRootId(value: string, sourceKind: SubAgentSourceKind, index: number): string {
  const safe = value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : `${sourceKind}:${index + 1}`;
}

function safeSubAgentId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "sub-agent";
}

function normalizeSubAgentKey(value: string): string {
  return safeSubAgentId(value);
}

function firstParagraph(value: string): string | undefined {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/^#+\s*/, "").trim())
    .find((paragraph) => paragraph.length > 0);
}

function errorMessage(error: Error): string {
  return error.message.trim() || error.name;
}


function assertSubAgentDefinitionHashesMatch(
  subAgent: SubAgentDefinition,
  facts: {
    readonly contentHash: string;
    readonly bodyHash: string;
    readonly metadataHash: string;
  }
): void {
  const mismatch = firstHashMismatch(subAgent, facts);
  if (mismatch === undefined) {
    return;
  }
  throw new Error(
    [
      `Sub-agent definition hash does not match the discovered catalog for "${subAgent.id}".`,
      `${mismatch.kind} expected=${mismatch.expected} actual=${mismatch.actual}`,
      "Refusing to execute changed SUB_AGENT.md content.",
    ].join(" ")
  );
}

function firstHashMismatch(
  expected: SubAgentDefinition,
  actual: {
    readonly contentHash: string;
    readonly bodyHash: string;
    readonly metadataHash: string;
  }
): { readonly kind: "contentHash" | "bodyHash" | "metadataHash"; readonly expected: string; readonly actual: string } | undefined {
  for (const kind of ["contentHash", "bodyHash", "metadataHash"] as const) {
    const expectedHash = safeExpectedHash(expected[kind]);
    if (expectedHash !== undefined && actual[kind] !== expectedHash) {
      return {
        kind,
        expected: expectedHash,
        actual: actual[kind],
      };
    }
  }
  return undefined;
}

function safeExpectedHash(value: string): string | undefined {
  return value.trim().length > 0 ? value.trim() : undefined;
}
