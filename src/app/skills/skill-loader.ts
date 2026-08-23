import { promises as fs } from "node:fs";
import path from "node:path";
import { isFileNotFound } from "../../kernel/values/index.js";
import type { SkillDefinition } from "./contracts.js";
import {
  skillStateKeyForFacts,
  type SkillStateStore,
} from "./skill-state-store.js";
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

export type { SkillCompatibility, SkillJsonValue, SkillValidationIssue } from "./skill-validation.js";
export { hashSkillText, parseSkillMarkdown } from "./skill-validation.js";

export type SkillDiscoveryOptions = {
  readonly roots: readonly SkillRootInput[];
  readonly stateStore?: SkillStateStore;
};

export type SkillSourceKind = "project" | "user" | "plugin" | "admin" | "custom";

export type SkillRootDescriptor = {
  readonly rootPath: string;
  readonly sourceKind: SkillSourceKind;
  readonly sourceRootId: string;
  readonly precedence: number;
};

export type SkillRootInput = string | SkillRootDescriptor;

export type SkillDisclosureLevel = "header" | "summary" | "full";

export type SkillRelevanceStrategy = "keyword" | "llm";

export type SkillSelectionReasonCode =
  | "explicit_invocation"
  | "keyword_match"
  | "llm_candidate"
  | "llm_routing_required"
  | "selection_limit"
  | "no_match"
  | "model_invocation_disabled"
  | "not_user_invocable"
  | "disabled"
  | "load_error"
  | "duplicate_id"
  | "duplicate_name"
  | "metadata_budget_omitted";

export type SkillSelectionReason = {
  readonly code: SkillSelectionReasonCode;
  readonly message: string;
  readonly skillId?: string;
  readonly skillName?: string;
  readonly token?: string;
  readonly score?: number;
};

export type SkillCandidateContext = {
  readonly skillId: string;
  readonly skillName: string;
  readonly sourceKind?: SkillSourceKind;
  readonly sourceRootId?: string;
  readonly sourcePrecedence?: number;
  readonly text: string;
  readonly charCount: number;
  readonly descriptionTruncated: boolean;
  readonly explicit: boolean;
  readonly keywordScore: number;
};

export type SkillSelectionOptions = {
  readonly strategy?: SkillRelevanceStrategy;
  readonly limit?: number;
  readonly maxChars?: number;
};

export type SkillSelectionResult = {
  readonly strategy: SkillRelevanceStrategy;
  readonly selectedSkills: readonly SkillDefinition[];
  readonly candidateContexts: readonly SkillCandidateContext[];
  readonly candidateReasons: readonly SkillSelectionReason[];
  readonly omittedReasons: readonly SkillSelectionReason[];
  readonly warnings: readonly string[];
  readonly usedChars: number;
  readonly maxChars?: number;
  readonly needsModelRouting: boolean;
  readonly modelRoutingUnavailableReason?: string;
};

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

type ExplicitSkillRef = {
  readonly token: string;
  readonly key: string;
};

type SkillSelectionRecord = {
  readonly skill: SkillDefinition;
  readonly originalIndex: number;
  readonly idKey: string;
  readonly nameKey: string;
  readonly explicitTokens: readonly string[];
  readonly explicit: boolean;
  readonly keywordScore: number;
};

type SkillCandidateContextBuildResult = {
  readonly contexts: readonly SkillCandidateContext[];
  readonly usedChars: number;
  readonly maxChars?: number;
};

export async function discoverSkills(options: SkillDiscoveryOptions): Promise<readonly AgentSkillDefinition[]> {
  const roots = normalizeSkillRoots(options.roots);
  const discovered = await Promise.all(roots.map((root) => discoverSkillsUnderRoot(root)));
  const states = await options.stateStore?.readStates();
  const skills = discovered.flat();
  return skills
    .map((skill) => applyPersistedSkillState(
      skill,
      states?.get(skill.stateKey)
    ))
    .sort(compareDiscoveredSkills);
}

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

export function selectTriggeredSkills(
  goal: string,
  skills: readonly SkillDefinition[],
  limit = 4
): readonly SkillDefinition[] {
  return selectSkillsForGoal(goal, skills, { strategy: "keyword", limit }).selectedSkills;
}

export function selectTriggeredSkillsWithStrategy(
  goal: string,
  skills: readonly SkillDefinition[],
  strategy: SkillRelevanceStrategy,
  limit = 4
): readonly SkillDefinition[] {
  return selectSkillsForGoal(goal, skills, { strategy, limit }).selectedSkills;
}

export function selectSkillsForGoal(
  goal: string,
  skills: readonly SkillDefinition[],
  options: SkillSelectionOptions = {}
): SkillSelectionResult {
  const strategy = options.strategy ?? "keyword";
  const limit = normalizedSelectionLimit(options.limit ?? 4);
  const explicitRefs = extractExplicitSkillRefs(goal);
  const normalizedGoal = normalizeForMatch(goal);
  const warnings: string[] = [];
  const omittedReasons: SkillSelectionReason[] = [];
  const candidateReasons: SkillSelectionReason[] = [];
  const records = skills.map((skill, index): SkillSelectionRecord => {
    const explicitTokens = explicitTokensForSkill(skill, explicitRefs);
    return {
      skill,
      originalIndex: index,
      idKey: normalizeSkillSelectorKey(skill.id),
      nameKey: normalizeSkillSelectorKey(skill.name),
      explicitTokens,
      explicit: explicitTokens.length > 0,
      keywordScore: normalizedGoal.length === 0 ? 0 : scoreSkillMatch(normalizedGoal, skill),
    };
  });
  const availableRecords: SkillSelectionRecord[] = [];
  for (const record of records) {
    const loadError = skillLoadError(record.skill);
    if (loadError !== undefined) {
      omittedReasons.push(reasonForRecord(
        record,
        "load_error",
        `Skill "${record.skill.name}" is invalid or failed to load: ${loadError}`
      ));
      continue;
    }
    if (!record.skill.enabled) {
      omittedReasons.push(reasonForRecord(
        record,
        "disabled",
        `Skill "${record.skill.name}" is disabled and was not selected.`
      ));
      continue;
    }
    availableRecords.push(record);
  }
  const uniqueRecords = dedupeSkillRecords(availableRecords, omittedReasons);
  const candidateRecords = uniqueRecords.filter((record) => {
    if (record.explicit) {
      return record.skill.userInvocable !== false;
    }
    if (record.skill.disableModelInvocation === true) {
      return false;
    }
    if (strategy === "llm") {
      return true;
    }
    return record.keywordScore > 0;
  });
  const candidateRecordSet = new Set(candidateRecords);
  for (const record of uniqueRecords) {
    if (!candidateRecordSet.has(record)) {
      if (record.explicit && record.skill.userInvocable === false) {
        omittedReasons.push(reasonForRecord(
          record,
          "not_user_invocable",
          `Skill "${record.skill.name}" is not user-invocable and ignored explicit selector.`,
          { score: record.keywordScore }
        ));
        continue;
      }
      if (!record.explicit && record.skill.disableModelInvocation === true) {
        omittedReasons.push(reasonForRecord(
          record,
          "model_invocation_disabled",
          `Skill "${record.skill.name}" disables model invocation and was not auto-selected.`,
          { score: record.keywordScore }
        ));
        continue;
      }
      omittedReasons.push(reasonForRecord(
        record,
        "no_match",
        `Skill "${record.skill.name}" did not match explicit references or keyword triggers.`,
        { score: record.keywordScore }
      ));
    }
  }
  for (const record of candidateRecords) {
    candidateReasons.push(candidateReasonForRecord(record, strategy));
  }
  const selectableRecords = strategy === "llm"
    ? candidateRecords.filter((record) => record.explicit)
    : candidateRecords;
  const selectedRecords = selectableRecords.slice(0, limit);
  const selectedRecordSet = new Set(selectedRecords);
  for (const record of selectableRecords.slice(limit)) {
    omittedReasons.push(reasonForRecord(
      record,
      "selection_limit",
      `Skill "${record.skill.name}" matched but was omitted by the selection limit.`,
      { score: record.keywordScore }
    ));
  }
  const needsModelRouting = strategy === "llm" && candidateRecords.some((record) => !record.explicit);
  const modelRoutingUnavailableReason = needsModelRouting
    ? "LLM skill routing was requested, but no model router is injected; only explicit $skill references were selected."
    : undefined;
  if (modelRoutingUnavailableReason !== undefined) {
    warnings.push(modelRoutingUnavailableReason);
    for (const record of candidateRecords) {
      if (!record.explicit && !selectedRecordSet.has(record)) {
        omittedReasons.push(reasonForRecord(
          record,
          "llm_routing_required",
          `Skill "${record.skill.name}" is prepared as an LLM routing candidate but was not selected without a model router.`,
          { score: record.keywordScore }
        ));
      }
    }
  }
  const budgetResult = buildCandidateContexts(candidateRecords, options.maxChars, omittedReasons, warnings);
  return {
    strategy,
    selectedSkills: selectedRecords.map((record) => record.skill),
    candidateContexts: budgetResult.contexts,
    candidateReasons,
    omittedReasons,
    warnings,
    usedChars: budgetResult.usedChars,
    maxChars: budgetResult.maxChars,
    needsModelRouting,
    modelRoutingUnavailableReason,
  };
}

function normalizedSelectionLimit(value: number): number {
  if (value === Number.POSITIVE_INFINITY) {
    return value;
  }
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function extractExplicitSkillRefs(goal: string): readonly ExplicitSkillRef[] {
  const refs: ExplicitSkillRef[] = [];
  for (const match of goal.matchAll(/\$([A-Za-z0-9][A-Za-z0-9_-]*)/g)) {
    const token = match[1]!.trim();
    const key = normalizeSkillSelectorKey(token);
    if (key.length > 0) {
      refs.push({ token, key });
    }
  }
  return refs;
}

function explicitTokensForSkill(
  skill: SkillDefinition,
  refs: readonly ExplicitSkillRef[]
): readonly string[] {
  const idKey = normalizeSkillSelectorKey(skill.id);
  const nameKey = normalizeSkillSelectorKey(skill.name);
  const tokens = refs
    .filter((ref) => ref.key === idKey || ref.key === nameKey)
    .map((ref) => ref.token);
  return [...new Set(tokens)];
}

function dedupeSkillRecords(
  records: readonly SkillSelectionRecord[],
  omittedReasons: SkillSelectionReason[]
): readonly SkillSelectionRecord[] {
  const sorted = [...records].sort(compareSkillSelectionRecords);
  const byId = new Map<string, SkillSelectionRecord>();
  const byName = new Map<string, SkillSelectionRecord>();
  const unique: SkillSelectionRecord[] = [];
  for (const record of sorted) {
    const idDuplicate = byId.get(record.idKey);
    if (idDuplicate !== undefined) {
      omittedReasons.push(reasonForRecord(
        record,
        "duplicate_id",
        `Skill "${record.skill.name}" duplicates skill id "${idDuplicate.skill.id}" and was omitted.`,
        { score: record.keywordScore }
      ));
      continue;
    }
    const nameDuplicate = byName.get(record.nameKey);
    if (nameDuplicate !== undefined) {
      omittedReasons.push(reasonForRecord(
        record,
        "duplicate_name",
        `Skill "${record.skill.name}" duplicates skill name "${nameDuplicate.skill.name}" and was omitted.`,
        { score: record.keywordScore }
      ));
      continue;
    }
    byId.set(record.idKey, record);
    byName.set(record.nameKey, record);
    unique.push(record);
  }
  return unique;
}

function compareSkillSelectionRecords(left: SkillSelectionRecord, right: SkillSelectionRecord): number {
  return Number(right.explicit) - Number(left.explicit) ||
    right.keywordScore - left.keywordScore ||
    skillSourcePrecedence(right.skill) - skillSourcePrecedence(left.skill) ||
    left.skill.name.localeCompare(right.skill.name) ||
    left.skill.id.localeCompare(right.skill.id) ||
    left.skill.sourcePath.localeCompare(right.skill.sourcePath) ||
    left.originalIndex - right.originalIndex;
}

function compareDiscoveredSkills(left: AgentSkillDefinition, right: AgentSkillDefinition): number {
  return left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id) ||
    right.sourcePrecedence - left.sourcePrecedence ||
    left.sourceRootId.localeCompare(right.sourceRootId) ||
    left.sourcePath.localeCompare(right.sourcePath);
}

function candidateReasonForRecord(
  record: SkillSelectionRecord,
  strategy: SkillRelevanceStrategy
): SkillSelectionReason {
  if (record.explicit) {
    return reasonForRecord(
      record,
      "explicit_invocation",
      `Skill "${record.skill.name}" was explicitly requested with $${record.explicitTokens[0]}.`,
      { score: record.keywordScore, token: record.explicitTokens[0] }
    );
  }
  if (strategy === "llm") {
    return reasonForRecord(
      record,
      "llm_candidate",
      `Skill "${record.skill.name}" was prepared as a candidate for model routing.`,
      { score: record.keywordScore }
    );
  }
  return reasonForRecord(
    record,
    "keyword_match",
    `Skill "${record.skill.name}" matched keyword metadata with score ${record.keywordScore}.`,
    { score: record.keywordScore }
  );
}

function reasonForRecord(
  record: SkillSelectionRecord,
  code: SkillSelectionReasonCode,
  message: string,
  extra: { readonly score?: number; readonly token?: string } = {}
): SkillSelectionReason {
  return {
    code,
    message,
    skillId: record.skill.id,
    skillName: record.skill.name,
    token: extra.token ?? record.explicitTokens[0],
    score: extra.score,
  };
}

function buildCandidateContexts(
  records: readonly SkillSelectionRecord[],
  maxChars: number | undefined,
  omittedReasons: SkillSelectionReason[],
  warnings: string[]
): SkillCandidateContextBuildResult {
  const normalizedMaxChars = normalizeMaxChars(maxChars);
  const contexts: SkillCandidateContext[] = [];
  let usedChars = 0;
  for (const record of records) {
    const remaining = normalizedMaxChars === undefined ? undefined : normalizedMaxChars - usedChars;
    if (remaining !== undefined && remaining <= 0) {
      omittedReasons.push(metadataBudgetOmittedReason(record));
      warnings.push(`Skill candidate metadata omitted because maxChars was exhausted: ${record.skill.name}.`);
      continue;
    }
    const context = buildCandidateContext(record, remaining);
    if (context === undefined) {
      omittedReasons.push(metadataBudgetOmittedReason(record));
      warnings.push(`Skill candidate metadata omitted because it does not fit maxChars: ${record.skill.name}.`);
      continue;
    }
    if (context.descriptionTruncated) {
      warnings.push(`Skill description truncated for metadata budget: ${record.skill.name}.`);
    }
    usedChars += context.charCount;
    contexts.push(context);
  }
  return {
    contexts,
    usedChars,
    maxChars: normalizedMaxChars,
  };
}

function buildCandidateContext(
  record: SkillSelectionRecord,
  remainingChars: number | undefined
): SkillCandidateContext | undefined {
  const description = normalizeContextLine(
    [record.skill.description, record.skill.whenToUse].filter((value): value is string => value !== undefined).join("\nwhen_to_use: ")
  );
  const fullText = candidateContextPrefix(record) + description;
  if (remainingChars === undefined || fullText.length <= remainingChars) {
    return {
      skillId: record.skill.id,
      skillName: record.skill.name,
      sourceKind: skillSourceKind(record.skill),
      sourceRootId: skillSourceRootId(record.skill),
      sourcePrecedence: skillSourcePrecedence(record.skill),
      text: fullText,
      charCount: fullText.length,
      descriptionTruncated: false,
      explicit: record.explicit,
      keywordScore: record.keywordScore,
    };
  }
  const prefix = candidateContextPrefix(record);
  if (prefix.length > remainingChars) {
    return undefined;
  }
  const truncatedDescription = truncateText(description, remainingChars - prefix.length);
  const text = prefix + truncatedDescription;
  return {
    skillId: record.skill.id,
    skillName: record.skill.name,
    sourceKind: skillSourceKind(record.skill),
    sourceRootId: skillSourceRootId(record.skill),
    sourcePrecedence: skillSourcePrecedence(record.skill),
    text,
    charCount: text.length,
    descriptionTruncated: truncatedDescription.length < description.length,
    explicit: record.explicit,
    keywordScore: record.keywordScore,
  };
}

function candidateContextPrefix(record: SkillSelectionRecord): string {
  return [
    `id: ${record.skill.id}`,
    `name: ${record.skill.name}`,
    `sourceKind: ${skillSourceKind(record.skill) ?? "custom"}`,
    `sourceRootId: ${skillSourceRootId(record.skill) ?? "unscoped"}`,
    `sourcePrecedence: ${skillSourcePrecedence(record.skill)}`,
    `triggers: ${record.skill.triggers.length === 0 ? "(none)" : record.skill.triggers.join(", ")}`,
    `disableModelInvocation: ${record.skill.disableModelInvocation === true ? "true" : "false"}`,
    `userInvocable: ${record.skill.userInvocable === false ? "false" : "true"}`,
    "description: ",
  ].join("\n");
}

function metadataBudgetOmittedReason(record: SkillSelectionRecord): SkillSelectionReason {
  return reasonForRecord(
    record,
    "metadata_budget_omitted",
    `Skill "${record.skill.name}" candidate metadata was omitted by maxChars.`,
    { score: record.keywordScore }
  );
}

function normalizeMaxChars(value: number | undefined): number | undefined {
  if (value === undefined || value === Number.POSITIVE_INFINITY) {
    return undefined;
  }
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeContextLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 3)}...`;
}

async function discoverSkillsUnderRoot(root: SkillRootDescriptor): Promise<readonly AgentSkillDefinition[]> {
  const entries = await fs.readdir(root.rootPath, { withFileTypes: true }).catch((error: unknown) => {
    if (isFileNotFound(error)) {
      return [];
    }
    throw error;
  });
  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readSkillDefinition(root, path.join(root.rootPath, entry.name), entry.name))
  );
}

async function readSkillDefinition(
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

function applyPersistedSkillState(
  skill: AgentSkillDefinition,
  state: { readonly enabled?: boolean; readonly lastUsedAt?: string } | undefined
): AgentSkillDefinition {
  if (state === undefined) {
    return skill;
  }
  return {
    ...skill,
    enabled: skill.loadError === undefined ? state.enabled ?? skill.enabled : false,
    lastUsedAt: state.lastUsedAt ?? skill.lastUsedAt,
  };
}

export function normalizeSkillRoots(roots: readonly SkillRootInput[]): readonly SkillRootDescriptor[] {
  return roots.map((root, index) => normalizeSkillRoot(root, index));
}

function normalizeSkillRoot(root: SkillRootInput, index: number): SkillRootDescriptor {
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

function safeSourceRootId(value: string, sourceKind: SkillSourceKind, index: number): string {
  const safe = value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : `${sourceKind}:${index + 1}`;
}

function skillSourceKind(skill: SkillDefinition): SkillSourceKind | undefined {
  const value = (skill as SkillDefinition & { readonly sourceKind?: unknown }).sourceKind;
  return isSkillSourceKind(value) ? value : undefined;
}

function skillSourceRootId(skill: SkillDefinition): string | undefined {
  const value = (skill as SkillDefinition & { readonly sourceRootId?: unknown }).sourceRootId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function skillSourcePrecedence(skill: SkillDefinition): number {
  const value = (skill as SkillDefinition & { readonly sourcePrecedence?: unknown }).sourcePrecedence;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isSkillSourceKind(value: unknown): value is SkillSourceKind {
  return value === "project" || value === "user" || value === "plugin" || value === "admin" || value === "custom";
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

function scoreSkillMatch(normalizedGoal: string, skill: SkillDefinition): number {
  const terms = [
    skill.id,
    skill.name,
    skill.description,
    ...skill.triggers,
  ].map(normalizeForMatch).filter((term) => term.length > 0);
  return terms.reduce((score, term) => {
    if (normalizedGoal.includes(term)) {
      return score + Math.min(10, Math.max(1, term.length));
    }
    return score;
  }, 0);
}

function firstParagraph(value: string): string | undefined {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/^#+\s*/, "").trim())
    .find((paragraph) => paragraph.length > 0);
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeSkillSelectorKey(value: string): string {
  return safeSkillId(value);
}

function safeSkillId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function skillLoadError(skill: SkillDefinition): string | undefined {
  const candidate = skill as SkillDefinition & { readonly loadError?: unknown };
  return typeof candidate.loadError === "string" && candidate.loadError.length > 0 ? candidate.loadError : undefined;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function errorMessage(error: Error): string {
  return error.message.trim() || error.name;
}
