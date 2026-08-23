import type {
  SkillDefinition,
  SkillSelectionDecisionFacts,
  SkillSelectionDecisionReason,
  SkillSelectionMethod,
} from "../skills/contracts.js";
import type { CapabilitySkillCatalogItem } from "../../domain/config/index.js";
import type { IntelligenceChannel, ModelCallRef } from "../../domain/intelligence/index.js";
import { nowIso } from "../../kernel/id.js";
import {
  discoverSkills,
  loadSkillBodyFacts,
  routeSkillsWithModel,
  selectSkillsForGoal,
  skillStateKeyForSkill,
  skillStateTargetForSkill,
  type SkillRootInput,
  type SkillSelectionReason,
  type SkillSelectionResult,
  type SelectedSkillContext,
  type SkillRouterOmittedReason,
  type SkillRouterResult,
  type SkillRouterValidationIssue,
  type SkillStateStore,
} from "../skills/index.js";

export type PanelSkillRuntime = {
  readonly skillRoots: readonly SkillRootInput[];
  readonly skillStateStore?: SkillStateStore;
  readonly now?: () => string;
  readonly capabilityCenter?: {
    listSkills(): Promise<readonly SkillDefinition[]>;
    invalidate(): void;
  };
};

export type PanelSkillSettingsItem = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly lastUsedAt?: string;
  readonly summary?: string;
  readonly category?: string;
  readonly sourceKind?: "project" | "user" | "plugin" | "admin" | "custom";
  readonly sourceRootId?: string;
  readonly stateKey?: string;
  readonly loadError?: string;
};

export type ResolveTriggeredSkillContextsOptions = {
  readonly intelligenceChannel?: IntelligenceChannel;
  readonly historySummary?: string;
  readonly limit?: number;
  readonly routingMode?: "keyword" | "model";
  readonly requestId?: string;
  readonly traceId?: string;
  readonly callerRef?: string;
  readonly abortSignal?: AbortSignal;
};

export async function listPanelSkills(runtime: PanelSkillRuntime): Promise<readonly SkillDefinition[]> {
  if (runtime.capabilityCenter !== undefined) {
    return runtime.capabilityCenter.listSkills();
  }
  return discoverSkills({ roots: runtime.skillRoots, stateStore: runtime.skillStateStore });
}

export async function listPanelSkillSettings(runtime: PanelSkillRuntime): Promise<readonly PanelSkillSettingsItem[]> {
  return (await listPanelSkills(runtime)).map(projectPanelSkillSettingsItem);
}

export async function refreshPanelSkills(runtime: PanelSkillRuntime): Promise<readonly SkillDefinition[]> {
  runtime.capabilityCenter?.invalidate();
  return listPanelSkills(runtime);
}

export async function refreshPanelSkillSettings(runtime: PanelSkillRuntime): Promise<readonly PanelSkillSettingsItem[]> {
  return (await refreshPanelSkills(runtime)).map(projectPanelSkillSettingsItem);
}

export async function setPanelSkillEnabled(
  runtime: PanelSkillRuntime,
  skillId: string,
  enabled: boolean,
  stateKey?: string
): Promise<boolean> {
  if (runtime.skillStateStore === undefined) {
    return false;
  }
  const skill = await resolveSkillForStateUpdate(runtime, skillId, stateKey);
  await runtime.skillStateStore.setEnabled(
    skillStateKeyForSkill(skill),
    enabled,
    skillStateTargetForSkill(skill)
  );
  runtime.capabilityCenter?.invalidate();
  return true;
}

export function projectPanelSkillSettingsItem(skill: SkillDefinition): PanelSkillSettingsItem {
  const optionalFacts = skill as SkillDefinition & { readonly loadError?: unknown };
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    enabled: skill.enabled,
    lastUsedAt: skill.lastUsedAt,
    summary: skill.summary,
    category: skill.category,
    sourceKind: skill.sourceKind,
    sourceRootId: skill.sourceRootId,
    stateKey: skill.stateKey,
    loadError: typeof optionalFacts.loadError === "string" ? optionalFacts.loadError : undefined,
  };
}

export async function resolveTriggeredSkillContexts(
  runtime: PanelSkillRuntime,
  goal: string,
  skillsOverride?: readonly SkillDefinition[] | readonly CapabilitySkillCatalogItem[],
  options: ResolveTriggeredSkillContextsOptions = {}
): Promise<readonly SelectedSkillContext[]> {
  const skills = skillsOverride ?? await listPanelSkills(runtime);
  const selection = await resolveSkillSelection(goal, skills, options);
  const selectedAt = runtime.now?.() ?? nowIso();
  const loadedContexts = await Promise.all(selection.selectedSkills.map((skill) =>
    loadTriggeredSkillContext(
      runtime,
      skill,
      selectedAt,
      triggerReasonForSelection(skill, selection),
      selectionWarningForSkill(skill, selection),
      selection.decisionFacts
    )
  ));
  return Promise.all(loadedContexts.map((context) => markLoadedSkillUsed(runtime, context)));
}

type ResolvedSkillSelection = {
  readonly selectedSkills: readonly SkillDefinition[];
  readonly keywordSelection: SkillSelectionResult;
  readonly routerResult?: SkillRouterResult;
  readonly decisionFacts: SkillSelectionDecisionFacts;
};

async function resolveSkillSelection(
  goal: string,
  skills: readonly SkillDefinition[] | readonly CapabilitySkillCatalogItem[],
  options: ResolveTriggeredSkillContextsOptions
): Promise<ResolvedSkillSelection> {
  const limit = options.limit ?? 4;
  const routingMode = options.routingMode ?? "keyword";
  if (routingMode !== "model" || options.intelligenceChannel === undefined) {
    const keywordSelection = selectSkillsForGoal(goal, skills, { strategy: "keyword", limit });
    return {
      selectedSkills: keywordSelection.selectedSkills,
      keywordSelection,
      decisionFacts: keywordSelectionDecisionFacts(keywordSelection),
    };
  }

  const candidateSelection = selectSkillsForGoal(goal, skills, { strategy: "llm", limit });
  try {
    const routerResult = await routeSkillsWithModel({
      goal,
      historySummary: options.historySummary,
      catalog: skills,
      candidateContexts: candidateSelection.candidateContexts,
      explicitSkillIds: candidateSelection.candidateContexts
        .filter((candidate) => candidate.explicit)
        .map((candidate) => candidate.skillId),
      keywordCandidateSkillIds: candidateSelection.candidateContexts
        .filter((candidate) => candidate.keywordScore > 0)
        .sort((left, right) => right.keywordScore - left.keywordScore)
        .map((candidate) => candidate.skillId),
      limit,
      intelligenceChannel: options.intelligenceChannel,
      requestId: options.requestId,
      traceId: options.traceId,
      callerRef: options.callerRef,
      abortSignal: options.abortSignal,
    });
    return {
      selectedSkills: skillsByRouterResult(skills, routerResult),
      keywordSelection: candidateSelection,
      routerResult,
      decisionFacts: routerSelectionDecisionFacts(candidateSelection, routerResult),
    };
  } catch (error) {
    const fallbackSelection = selectSkillsForGoal(goal, skills, { strategy: "keyword", limit });
    return {
      selectedSkills: fallbackSelection.selectedSkills,
      keywordSelection: fallbackSelection,
      decisionFacts: {
        ...keywordSelectionDecisionFacts(fallbackSelection),
        selectionMethod: "keyword_fallback",
        rejectedReasons: [{
          code: "router_exception",
          summary: error instanceof Error ? error.message : String(error),
        }],
        reasonSummary: "Skill router failed before returning a decision; keyword fallback was used.",
      },
    };
  }
}

async function loadTriggeredSkillContext(
  runtime: PanelSkillRuntime,
  skill: SkillDefinition,
  selectedAt: string,
  triggerReason: string,
  selectionWarning: string | undefined,
  selection: SkillSelectionDecisionFacts
): Promise<SelectedSkillContext> {
  try {
    const expectedHashes = frozenSkillHashesFor(skill);
    const bodyFacts = await loadSkillBodyFacts(skill);
    const loadedAt = runtime.now?.() ?? nowIso();
    const hashMismatch = skillHashMismatch(expectedHashes, bodyFacts);
    if (hashMismatch !== undefined) {
      const error = skillHashMismatchError(hashMismatch);
      const warning = appendWarning(
        selectionWarning,
        "技能正文与 run 创建时的冻结 hash 不一致，本轮不会注入该技能正文。"
      );
      return {
        skill,
        body: "",
        triggerReason,
        selectedAt,
        loadStatus: "failed",
        loadedAt,
        bodyHash: bodyFacts.bodyHash,
        contentHash: bodyFacts.contentHash,
        bodyCharCount: 0,
        truncated: false,
        omitted: true,
        error,
        warning,
        selection,
        summary: skillSummary({
          skill,
          triggerReason,
          loadedAt,
          contentHash: bodyFacts.contentHash,
          bodyCharCount: 0,
          error,
          warning,
        }),
      };
    }
    const missingFrozenHashWarning = skillFrozenHashWarning(expectedHashes);
    const warning = appendWarning(selectionWarning, missingFrozenHashWarning);
    return {
      skill,
      body: bodyFacts.body,
      triggerReason,
      selectedAt,
      loadStatus: "loaded",
      loadedAt,
      bodyHash: bodyFacts.bodyHash,
      contentHash: bodyFacts.contentHash,
      bodyCharCount: bodyFacts.body.length,
      truncated: false,
      omitted: false,
      warning,
      selection,
      summary: skillSummary({
        skill,
        triggerReason,
        loadedAt,
        contentHash: bodyFacts.contentHash,
        bodyCharCount: bodyFacts.body.length,
        warning,
      }),
    };
  } catch (error) {
    const safeError = safeSkillLoadError(error);
    return {
      skill,
      body: "",
      triggerReason,
      selectedAt,
      loadStatus: "failed",
      bodyCharCount: 0,
      truncated: false,
      omitted: true,
      error: safeError,
      warning: appendWarning(selectionWarning, "技能正文加载失败，本轮不会注入该技能正文。"),
      selection,
      summary: skillSummary({
        skill,
        triggerReason,
        error: safeError,
        warning: selectionWarning,
      }),
    };
  }
}

async function markLoadedSkillUsed(
  runtime: PanelSkillRuntime,
  context: SelectedSkillContext
): Promise<SelectedSkillContext> {
  if (context.loadStatus !== "loaded") {
    return context;
  }
  if (runtime.skillStateStore === undefined) {
    return {
      ...context,
      markUsedStatus: "skipped",
    };
  }
  try {
    await runtime.skillStateStore.markUsed(
      skillStateKeyForSkill(context.skill),
      undefined,
      skillStateTargetForSkill(context.skill)
    );
    return {
      ...context,
      markUsedStatus: "succeeded",
    };
  } catch {
    return {
      ...context,
      markUsedStatus: "failed",
      warning: appendWarning(context.warning, "技能使用记录更新失败，但正文已注入本轮模型上下文。"),
    };
  }
}

async function resolveSkillForStateUpdate(
  runtime: PanelSkillRuntime,
  skillId: string,
  stateKey: string | undefined
): Promise<SkillDefinition> {
  const skills = await listPanelSkills(runtime);
  if (stateKey !== undefined && stateKey.trim().length > 0) {
    const match = skills.find((skill) => skillStateKeyForSkill(skill) === stateKey.trim());
    if (match !== undefined) {
      return match;
    }
  }
  const matches = skills.filter((skill) => skill.id === skillId);
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new Error(`Skill id "${skillId}" is ambiguous across sources; provide stateKey.`);
  }
  return {
    id: skillId,
    name: skillId,
    description: "",
    enabled: true,
    sourcePath: "",
    triggers: [],
  };
}

function triggerReasonFor(skill: SkillDefinition): string {
  return skill.triggers.length === 0
    ? "技能名称或描述匹配当前任务。"
    : `触发词：${skill.triggers.join(" / ")}`;
}

function triggerReasonForSelection(
  skill: SkillDefinition,
  selection: ResolvedSkillSelection
): string {
  const routerReason = selection.routerResult?.selectionReasons.find((reason) => reason.skillId === skill.id);
  if (routerReason !== undefined) {
    if (routerReason.code === "explicit_invocation") {
      return routerReason.token === undefined
        ? "显式调用当前技能。"
        : `显式调用：$${routerReason.token}`;
    }
    if (routerReason.code === "model_selected") {
      return `模型选择：${safeText(routerReason.message, 200)}`;
    }
    return `关键词 fallback：${safeText(routerReason.message, 200)}`;
  }
  const reason = reasonForSkill(skill, selection.keywordSelection);
  if (reason?.code === "explicit_invocation") {
    return reason.token === undefined
      ? "显式调用当前技能。"
      : `显式调用：$${reason.token}`;
  }
  return triggerReasonFor(skill);
}

function selectionWarningForSkill(
  skill: SkillDefinition,
  selection: ResolvedSkillSelection
): string | undefined {
  const warningParts: string[] = [];
  const candidateContext = selection.keywordSelection.candidateContexts.find((candidate) => sameSkillRef(skill, candidate));
  if (candidateContext?.descriptionTruncated === true) {
    warningParts.push("技能选择候选 metadata 因预算限制被截断。");
  }
  for (const reason of selection.keywordSelection.omittedReasons) {
    if (reason.code === "metadata_budget_omitted" && sameSkillReason(skill, reason)) {
      warningParts.push("技能选择候选 metadata 因预算限制被省略。");
    }
  }
  for (const warning of selection.keywordSelection.warnings) {
    if (warning.includes(skill.id) || warning.includes(skill.name)) {
      warningParts.push(warning);
    }
  }
  if (selection.routerResult?.fallback === true) {
    warningParts.push("技能模型路由失败，本轮已降级为显式调用与关键词候选选择。");
  }
  return compactWarnings(warningParts);
}

function skillsByRouterResult(
  skills: readonly SkillDefinition[] | readonly CapabilitySkillCatalogItem[],
  routerResult: SkillRouterResult
): readonly SkillDefinition[] {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  return routerResult.selectedSkillIds
    .map((skillId) => byId.get(skillId))
    .filter((skill): skill is SkillDefinition => skill !== undefined);
}

function keywordSelectionDecisionFacts(selection: SkillSelectionResult): SkillSelectionDecisionFacts {
  const selectedReasons = selection.selectedSkills
    .map((skill) => reasonForSkill(skill, selection))
    .filter((reason): reason is SkillSelectionReason => reason !== undefined);
  return {
    selectionMethod: keywordSelectionMethod(selectedReasons),
    candidateSkillIds: uniqueStrings(selection.candidateContexts.map((candidate) => candidate.skillId)),
    selectedSkillIds: selection.selectedSkills.map((skill) => skill.id),
    omittedReasons: selection.omittedReasons.map(decisionReasonFromKeywordReason),
    confidence: selectedReasons.length === 0 ? 0 : undefined,
    reasonSummary: selectedReasons.length === 0
      ? "Keyword skill selection did not select any skills."
      : "Keyword skill selection selected skills from explicit references or trigger matches.",
  };
}

function routerSelectionDecisionFacts(
  candidateSelection: SkillSelectionResult,
  routerResult: SkillRouterResult
): SkillSelectionDecisionFacts {
  const rejectedReasons = [
    ...routerResult.omittedReasons
      .filter(isRouterRejectedReason)
      .map(decisionReasonFromRouterOmittedReason),
    ...routerResult.validationIssues.map(decisionReasonFromRouterValidationIssue),
  ];
  return {
    selectionMethod: routerSelectionMethod(routerResult),
    modelCallRef: modelCallRefId(routerResult.modelCallRef),
    candidateSkillIds: uniqueStrings(candidateSelection.candidateContexts.map((candidate) => candidate.skillId)),
    selectedSkillIds: routerResult.selectedSkillIds,
    omittedReasons: routerResult.omittedReasons
      .filter((reason) => !isRouterRejectedReason(reason))
      .map(decisionReasonFromRouterOmittedReason),
    rejectedReasons,
    confidence: routerResult.confidence,
    reasonSummary: routerReasonSummary(routerResult),
  };
}

function keywordSelectionMethod(reasons: readonly SkillSelectionReason[]): SkillSelectionMethod {
  const hasExplicit = reasons.some((reason) => reason.code === "explicit_invocation");
  const hasKeyword = reasons.some((reason) => reason.code === "keyword_match");
  if (hasExplicit && hasKeyword) return "mixed";
  if (hasExplicit) return "explicit";
  return "keyword";
}

function routerSelectionMethod(result: SkillRouterResult): SkillSelectionMethod {
  if (result.fallback) {
    return "keyword_fallback";
  }
  const hasExplicit = result.selectionReasons.some((reason) => reason.code === "explicit_invocation");
  const hasModel = result.selectionReasons.some((reason) => reason.code === "model_selected");
  const hasFallback = result.selectionReasons.some((reason) => reason.code === "fallback_keyword_candidate");
  if (hasExplicit && (hasModel || hasFallback)) return "mixed";
  if (hasModel) return "model";
  if (hasExplicit) return "explicit";
  if (result.source === "model") return "model";
  if (result.source === "explicit_only") return "explicit";
  return "unknown";
}

function routerReasonSummary(result: SkillRouterResult): string {
  if (result.fallback) {
    return `Skill router fell back to explicit and keyword candidates: ${result.fallbackReason ?? "unknown"}.`;
  }
  if (result.selectedSkillIds.length === 0) {
    return "Skill router did not select any skills.";
  }
  return `Skill router selected ${result.selectedSkillIds.length} skill(s).`;
}

function decisionReasonFromKeywordReason(reason: SkillSelectionReason): SkillSelectionDecisionReason {
  return {
    code: reason.code,
    summary: reason.message,
    skillId: reason.skillId,
    skillName: reason.skillName,
    confidence: reason.score === undefined ? undefined : Math.max(0, Math.min(1, reason.score / 10)),
  };
}

function decisionReasonFromRouterOmittedReason(reason: SkillRouterOmittedReason): SkillSelectionDecisionReason {
  return {
    code: reason.code,
    summary: reason.message,
    skillId: reason.skillId,
  };
}

function decisionReasonFromRouterValidationIssue(issue: SkillRouterValidationIssue): SkillSelectionDecisionReason {
  return {
    code: issue.code,
    summary: issue.path === undefined ? issue.message : `${issue.path}: ${issue.message}`,
  };
}

function isRouterRejectedReason(reason: SkillRouterOmittedReason): boolean {
  return reason.code === "disabled" ||
    reason.code === "invalid" ||
    reason.code === "missing_from_catalog" ||
    reason.code === "duplicate_catalog_id" ||
    reason.code === "duplicate_model_selection" ||
    reason.code === "missing_candidate_context";
}

function modelCallRefId(ref: ModelCallRef | undefined): string | undefined {
  return ref?.responseId ?? ref?.requestId;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function reasonForSkill(
  skill: SkillDefinition,
  selection: SkillSelectionResult
): SkillSelectionReason | undefined {
  return selection.candidateReasons.find((reason) => sameSkillReason(skill, reason));
}

function sameSkillReason(skill: SkillDefinition, reason: SkillSelectionReason): boolean {
  return reason.skillId === skill.id || reason.skillName === skill.name;
}

function sameSkillRef(
  skill: SkillDefinition,
  candidate: { readonly skillId: string; readonly skillName: string }
): boolean {
  return candidate.skillId === skill.id || candidate.skillName === skill.name;
}

function compactWarnings(warnings: readonly string[]): string | undefined {
  const compacted = [...new Set(warnings.map((warning) => warning.trim()).filter((warning) => warning.length > 0))];
  return compacted.length === 0 ? undefined : compacted.join("\n");
}

function skillSummary(input: {
  readonly skill: SkillDefinition;
  readonly triggerReason: string;
  readonly loadedAt?: string;
  readonly contentHash?: string;
  readonly bodyCharCount?: number;
  readonly error?: string;
  readonly warning?: string;
}): string {
  const parts = [
    `技能：${safeText(input.skill.name, 120)}`,
    `触发原因：${safeText(input.triggerReason, 240)}`,
    input.error === undefined ? "加载状态：已加载" : `加载状态：失败（${safeText(input.error, 160)}）`,
    input.loadedAt === undefined ? undefined : `加载时间：${input.loadedAt}`,
    input.contentHash,
    input.bodyCharCount === undefined ? undefined : `正文字符数：${input.bodyCharCount}`,
    input.warning === undefined ? undefined : `警告：${safeText(input.warning, 240)}`,
  ].filter((part): part is string => part !== undefined && part.length > 0);
  return parts.join("\n");
}

function safeSkillLoadError(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
  if (code === "ENOENT") {
    return "技能正文文件不存在。";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "技能正文文件不可读取。";
  }
  return "技能正文加载失败。";
}

function safeText(value: string, maxLength: number): string {
  const text = value.trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

type SkillFrozenHashes = {
  readonly contentHash?: string;
  readonly bodyHash?: string;
};

type SkillHashMismatch = {
  readonly kind: "contentHash" | "bodyHash";
  readonly expected: string;
  readonly actual: string;
};

function frozenSkillHashesFor(skill: SkillDefinition): SkillFrozenHashes {
  const candidate = skill as SkillDefinition & {
    readonly contentHash?: unknown;
    readonly bodyHash?: unknown;
  };
  return {
    contentHash: safeHash(candidate.contentHash),
    bodyHash: safeHash(candidate.bodyHash),
  };
}

function skillHashMismatch(
  expected: SkillFrozenHashes,
  actual: SkillFrozenHashes
): SkillHashMismatch | undefined {
  if (expected.contentHash !== undefined && actual.contentHash !== expected.contentHash) {
    return {
      kind: "contentHash",
      expected: expected.contentHash,
      actual: actual.contentHash ?? "missing",
    };
  }
  if (expected.bodyHash !== undefined && actual.bodyHash !== expected.bodyHash) {
    return {
      kind: "bodyHash",
      expected: expected.bodyHash,
      actual: actual.bodyHash ?? "missing",
    };
  }
  return undefined;
}

function skillFrozenHashWarning(expected: SkillFrozenHashes): string | undefined {
  if (expected.contentHash !== undefined || expected.bodyHash !== undefined) {
    return undefined;
  }
  return "run 创建时的 skill catalog 缺少冻结 hash，本轮按兼容路径注入当前技能正文。";
}

function skillHashMismatchError(mismatch: SkillHashMismatch): string {
  return [
    "技能正文 hash 与 run 创建时冻结的 skill catalog 不一致。",
    `${mismatch.kind} expected=${mismatch.expected} actual=${mismatch.actual}`,
  ].join(" ");
}

function appendWarning(previous: string | undefined, next: string | undefined): string | undefined {
  if (next === undefined || next.trim().length === 0) {
    return previous;
  }
  if (previous === undefined || previous.trim().length === 0) {
    return next;
  }
  return `${previous}\n${next}`;
}

function safeHash(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
