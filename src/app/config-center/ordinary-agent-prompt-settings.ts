import { createHash } from "node:crypto";
import type { AgentSystemPromptSpec } from "../agent-prompts/contracts.js";
import type {
  OrdinaryAgentPromptVariant,
  OrdinaryAgentPromptVariantInfo,
  OrdinaryAgentPromptSettings,
  SanitizedOrdinaryAgentPromptConfig,
  UpdateOrdinaryAgentPromptConfigInput,
} from "../../domain/config/index.js";
import {
  ORDINARY_AGENT_PROMPT,
  ORDINARY_AGENT_PROMPT_ZH,
  isKnownBuiltInOrdinaryAgentPrompt,
} from "../agent-prompts/ordinary-agent-prompt.js";
import { asRecord, optionalString } from "./settings-utils.js";
import { ORDINARY_AGENT_USER_PROMPT_REF } from "../agent-prompts/ordinary-agent-identity.js";

export const DEFAULT_ORDINARY_AGENT_SYSTEM_PROMPT = ORDINARY_AGENT_PROMPT.systemPrompt;
export const ORDINARY_AGENT_SYSTEM_PROMPT_MAX_CHARS = 20_000;
export const DEFAULT_ORDINARY_AGENT_PROMPT_VARIANT: OrdinaryAgentPromptVariant = "en";

// 用户自定义提示词的稳定引用：正文与指纹只进入 sanitized 投影，不进入设置存储。
export const USER_CONFIGURED_ORDINARY_AGENT_PROMPT_REF = ORDINARY_AGENT_USER_PROMPT_REF;

// 内置提示词偏好目录：id 是持久化事实，label/description 是只读展示字段。
export const ORDINARY_AGENT_PROMPT_VARIANTS: readonly OrdinaryAgentPromptVariantInfo[] = [
  {
    id: "en",
    label: "English",
    description: "英文提示词，回答跟随用户使用的语言",
  },
  {
    id: "zh-v1",
    label: "简体中文",
    description: "中文提示词，回答默认使用简体中文",
  },
];

export function isKnownOrdinaryAgentPromptVariant(value: unknown): value is OrdinaryAgentPromptVariant {
  return value === "en" || value === "zh-v1";
}

export function createDefaultOrdinaryAgentPromptSettings(
  now: string,
  variant: OrdinaryAgentPromptVariant = DEFAULT_ORDINARY_AGENT_PROMPT_VARIANT
): OrdinaryAgentPromptSettings {
  return {
    systemPromptMode: "built_in",
    systemPromptVariant: variant,
    updatedAt: now,
  };
}

export function parseOrdinaryAgentPromptSettings(
  raw: unknown,
  fallbackUpdatedAt: string
): OrdinaryAgentPromptSettings | undefined {
  const record = asRecord(raw);
  if (Object.keys(record).length === 0) {
    return undefined;
  }
  const updatedAt = optionalString(record.updatedAt) ?? fallbackUpdatedAt;
  const variant = parseBuiltInPromptVariant(record.systemPromptVariant);
  const systemPrompt = normalizeCustomSystemPrompt(systemPromptFromUnknown(record.systemPrompt));
  if (record.systemPromptMode === "built_in") {
    return createDefaultOrdinaryAgentPromptSettings(updatedAt, variant);
  }
  if (record.systemPromptMode === "custom") {
    return systemPrompt === undefined
      ? createDefaultOrdinaryAgentPromptSettings(updatedAt, variant)
      : createCustomOrdinaryAgentPromptSettings(systemPrompt, variant, updatedAt);
  }
  if (systemPrompt === undefined || isKnownBuiltInOrdinaryAgentPrompt(systemPrompt)) {
    return createDefaultOrdinaryAgentPromptSettings(updatedAt, variant);
  }
  return createCustomOrdinaryAgentPromptSettings(systemPrompt, variant, updatedAt);
}

export function normalizeOrdinaryAgentPromptSettings(
  settings: OrdinaryAgentPromptSettings | undefined,
  now: string
): OrdinaryAgentPromptSettings {
  if (settings === undefined) {
    return createDefaultOrdinaryAgentPromptSettings(now);
  }
  const updatedAt = optionalString(settings.updatedAt) ?? now;
  const variant = parseBuiltInPromptVariant(settings.systemPromptVariant);
  if (settings.systemPromptMode === "built_in") {
    return createDefaultOrdinaryAgentPromptSettings(updatedAt, variant);
  }
  const systemPrompt = normalizeCustomSystemPrompt(settings.systemPrompt);
  return systemPrompt === undefined
    ? createDefaultOrdinaryAgentPromptSettings(updatedAt, variant)
    : createCustomOrdinaryAgentPromptSettings(systemPrompt, variant, updatedAt);
}

export function normalizeOrdinaryAgentPromptUpdate(
  input: UpdateOrdinaryAgentPromptConfigInput,
  current: OrdinaryAgentPromptSettings | undefined,
  now: string
): OrdinaryAgentPromptSettings {
  const variant = parseBuiltInPromptVariant(current?.systemPromptVariant);
  if (input.resetSystemPrompt === true) {
    return createDefaultOrdinaryAgentPromptSettings(now, variant);
  }
  if (input.systemPrompt !== undefined) {
    const systemPrompt = normalizeCustomSystemPrompt(input.systemPrompt);
    return systemPrompt === undefined
      ? createDefaultOrdinaryAgentPromptSettings(now, variant)
      : createCustomOrdinaryAgentPromptSettings(systemPrompt, variant, now);
  }
  if (isKnownOrdinaryAgentPromptVariant(input.systemPromptVariant)) {
    return createDefaultOrdinaryAgentPromptSettings(now, input.systemPromptVariant);
  }
  return {
    ...normalizeOrdinaryAgentPromptSettings(current, now),
    updatedAt: now,
  };
}

export function toSanitizedOrdinaryAgentPromptConfig(
  settings: OrdinaryAgentPromptSettings | undefined,
  input: { readonly now?: string } = {}
): SanitizedOrdinaryAgentPromptConfig {
  const normalized = normalizeOrdinaryAgentPromptSettings(settings, input.now ?? new Date().toISOString());
  if (normalized.systemPromptMode === "custom") {
    return {
      systemPrompt: normalized.systemPrompt,
      systemPromptVariant: normalized.systemPromptVariant,
      promptRef: USER_CONFIGURED_ORDINARY_AGENT_PROMPT_REF,
      promptVersion: `user-${systemPromptFingerprint(normalized.systemPrompt)}`,
      updatedAt: normalized.updatedAt,
      isDefault: false,
      maxSystemPromptChars: ORDINARY_AGENT_SYSTEM_PROMPT_MAX_CHARS,
      variants: ORDINARY_AGENT_PROMPT_VARIANTS,
    };
  }
  const spec = ordinaryAgentPromptSpecForVariant(normalized.systemPromptVariant);
  return {
    systemPrompt: spec.systemPrompt,
    systemPromptVariant: normalized.systemPromptVariant,
    promptRef: spec.promptRef,
    promptVersion: spec.version,
    updatedAt: normalized.updatedAt,
    isDefault: true,
    maxSystemPromptChars: ORDINARY_AGENT_SYSTEM_PROMPT_MAX_CHARS,
    variants: ORDINARY_AGENT_PROMPT_VARIANTS,
  };
}

export function ordinaryAgentPromptSpecForVariant(
  variant: OrdinaryAgentPromptVariant
): AgentSystemPromptSpec {
  if (variant === "zh-v1") {
    return ORDINARY_AGENT_PROMPT_ZH;
  }
  return ORDINARY_AGENT_PROMPT;
}

function systemPromptFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseBuiltInPromptVariant(value: unknown): OrdinaryAgentPromptVariant {
  return isKnownOrdinaryAgentPromptVariant(value) ? value : DEFAULT_ORDINARY_AGENT_PROMPT_VARIANT;
}

function createCustomOrdinaryAgentPromptSettings(
  systemPrompt: string,
  variant: OrdinaryAgentPromptVariant,
  updatedAt: string
): OrdinaryAgentPromptSettings {
  return {
    systemPromptMode: "custom",
    systemPrompt,
    systemPromptVariant: variant,
    updatedAt,
  };
}

function normalizeCustomSystemPrompt(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > ORDINARY_AGENT_SYSTEM_PROMPT_MAX_CHARS) {
    return trimmed.slice(0, ORDINARY_AGENT_SYSTEM_PROMPT_MAX_CHARS).trimEnd();
  }
  return trimmed;
}

function systemPromptFingerprint(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt).digest("hex").slice(0, 12);
}
