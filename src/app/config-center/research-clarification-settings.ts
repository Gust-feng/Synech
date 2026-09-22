import type {
  ResearchClarificationSettings,
  SanitizedResearchClarificationConfig,
  UpdateResearchClarificationConfigInput,
} from "../../domain/config/settings-store.js";
import {
  RESEARCH_CLARIFICATION_MAX_SNIPPET_SEARCHES,
  RESEARCH_CLARIFICATION_SEARCH_DEFAULT_ENABLED,
} from "../../domain/config/settings-store.js";
import { ConfigSchemaValidationError, asRecord, optionalString } from "./settings-utils.js";

/**
 * 澄清期联网检索设置（ADR 0001 §2.2）。
 *
 * 默认关闭：澄清期默认不联网，范围由用户与主会话共同澄清；开启后也只是摘要级
 * 检索，次数不得超出设置契约声明的硬界（`RESEARCH_CLARIFICATION_MAX_SNIPPET_SEARCHES`），
 * 结果不进入证据账本、不可被报告引用，范围卡必须披露次数。
 *
 * 这里不引用研究策略：配置层反向依赖研究会形成模块环；取值范围由设置契约声明。
 */

/** 与 RESEARCH_CLARIFICATION_SEARCH_DEFAULT_ENABLED 同源：开关默认值归设置契约。 */
export const DEFAULT_RESEARCH_SCOPE_SEARCH_ENABLED = RESEARCH_CLARIFICATION_SEARCH_DEFAULT_ENABLED;

export const DEFAULT_RESEARCH_MAX_SNIPPET_SEARCHES = RESEARCH_CLARIFICATION_MAX_SNIPPET_SEARCHES;

export function parseResearchClarificationSettings(
  raw: unknown,
  fallbackUpdatedAt: string,
): ResearchClarificationSettings | undefined {
  const record = asRecord(raw);
  if (Object.keys(record).length === 0) return undefined;
  return normalizeResearchClarificationSettings({
    scopeSearchEnabled: typeof record.scopeSearchEnabled === "boolean" ? record.scopeSearchEnabled : undefined,
    maxSnippetSearches: typeof record.maxSnippetSearches === "number" ? record.maxSnippetSearches : undefined,
    updatedAt: optionalString(record.updatedAt),
  }, fallbackUpdatedAt);
}

export function normalizeResearchClarificationSettings(
  settings: Partial<ResearchClarificationSettings> | undefined,
  now: string,
): ResearchClarificationSettings {
  return {
    scopeSearchEnabled: settings?.scopeSearchEnabled ?? DEFAULT_RESEARCH_SCOPE_SEARCH_ENABLED,
    maxSnippetSearches: clampSnippetSearches(settings?.maxSnippetSearches),
    updatedAt: optionalString(settings?.updatedAt) ?? now,
  };
}

export function normalizeResearchClarificationUpdate(
  input: UpdateResearchClarificationConfigInput,
  now: string,
): ResearchClarificationSettings {
  if (input.scopeSearchEnabled !== undefined && typeof input.scopeSearchEnabled !== "boolean") {
    throw new ConfigSchemaValidationError("researchClarification.scopeSearchEnabled must be a boolean.");
  }
  return normalizeResearchClarificationSettings(
    {
      scopeSearchEnabled: input.scopeSearchEnabled,
      maxSnippetSearches: input.maxSnippetSearches,
    },
    now,
  );
}

export function toSanitizedResearchClarificationConfig(
  settings: ResearchClarificationSettings | undefined,
  input: { readonly now?: string } = {},
): SanitizedResearchClarificationConfig {
  const normalized = normalizeResearchClarificationSettings(settings, input.now ?? new Date().toISOString());
  return {
    scopeSearchEnabled: normalized.scopeSearchEnabled,
    maxSnippetSearches: normalized.maxSnippetSearches,
    label: normalized.scopeSearchEnabled ? "已开启（仅摘要级）" : "已关闭",
    summary: normalized.scopeSearchEnabled
      ? `澄清期最多执行 ${normalized.maxSnippetSearches} 次摘要级检索；结果不进入证据账本，范围卡会披露次数。`
      : "澄清期不联网检索；范围完全由对话澄清确定。",
    updatedAt: normalized.updatedAt,
  };
}

/** 摘要级检索次数上限：用户配置不得超出设置契约声明的硬界。 */
function clampSnippetSearches(value: number | undefined): number {
  const limit = RESEARCH_CLARIFICATION_MAX_SNIPPET_SEARCHES;
  if (value === undefined || !Number.isInteger(value) || value < 0) return limit;
  return Math.min(value, limit);
}
