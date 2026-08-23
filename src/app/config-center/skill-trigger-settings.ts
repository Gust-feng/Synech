import type {
  SanitizedSkillTriggerConfig,
  SkillTriggerMode,
  SkillTriggerSettings,
  UpdateSkillTriggerConfigInput,
} from "../../domain/config/index.js";
import { ConfigSchemaValidationError, asRecord, optionalString } from "./settings-utils.js";

const DEFAULT_SKILL_TRIGGER_MODE: SkillTriggerMode = "keyword";

export function normalizeSkillTriggerMode(value: unknown): SkillTriggerMode | undefined {
  return value === "keyword" || value === "model" ? value : undefined;
}

export function parseSkillTriggerSettings(
  raw: unknown,
  fallbackUpdatedAt: string
): SkillTriggerSettings | undefined {
  if (typeof raw === "string") {
    const mode = normalizeSkillTriggerMode(raw);
    return mode === undefined ? undefined : { mode, updatedAt: fallbackUpdatedAt };
  }
  const record = asRecord(raw);
  if (Object.keys(record).length === 0) {
    return undefined;
  }
  return normalizeSkillTriggerSettings({
    mode: normalizeSkillTriggerMode(record.mode) ?? DEFAULT_SKILL_TRIGGER_MODE,
    updatedAt: optionalString(record.updatedAt) ?? fallbackUpdatedAt,
  }, fallbackUpdatedAt);
}

export function normalizeSkillTriggerSettings(
  settings: SkillTriggerSettings | undefined,
  now: string
): SkillTriggerSettings {
  return {
    mode: normalizeSkillTriggerMode(settings?.mode) ?? DEFAULT_SKILL_TRIGGER_MODE,
    updatedAt: optionalString(settings?.updatedAt) ?? now,
  };
}

export function normalizeSkillTriggerUpdate(
  input: UpdateSkillTriggerConfigInput,
  now: string
): SkillTriggerSettings {
  const mode = normalizeSkillTriggerMode(input.mode);
  if (mode === undefined) {
    throw new ConfigSchemaValidationError("skillTrigger.mode must be keyword or model.");
  }
  return {
    mode,
    updatedAt: now,
  };
}

export function toSanitizedSkillTriggerConfig(
  settings: SkillTriggerSettings | undefined,
  input: { readonly now?: string } = {}
): SanitizedSkillTriggerConfig {
  const normalized = normalizeSkillTriggerSettings(settings, input.now ?? new Date().toISOString());
  if (normalized.mode === "model") {
    return {
      mode: normalized.mode,
      label: "语义路由",
      modelRouterEnabled: true,
      summary: "普通 Agent 会在主请求前用 skill_routing 选择候选 Skills。",
      updatedAt: normalized.updatedAt,
    };
  }
  return {
    mode: normalized.mode,
    label: "显式/关键词触发",
    modelRouterEnabled: false,
    summary: "普通 Agent 只按显式 $skill 与本地触发词加载 Skills。",
    updatedAt: normalized.updatedAt,
  };
}
