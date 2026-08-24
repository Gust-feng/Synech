import type { SkillDefinition } from "./contracts.js";
import { skillLoadError, type SkillSourceKind } from "./skill-package-reader.js";

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

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeSkillSelectorKey(value: string): string {
  return safeSkillId(value);
}

function safeSkillId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}
