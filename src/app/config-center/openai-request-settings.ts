import { asRecord } from "../../kernel/values/index.js";
import type { OpenAIModelRequestSettings } from "../../domain/config/index.js";

export function normalizeOpenAIModelRequestSettings(
  value: OpenAIModelRequestSettings | undefined
): OpenAIModelRequestSettings | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized: OpenAIModelRequestSettings = {
    temperature: normalizeNumberInRange(value.temperature, 0, 2),
    topP: normalizeNumberInRange(value.topP, 0, 1),
    maxOutputTokens: normalizePositiveInteger(value.maxOutputTokens),
    reasoningEffort: normalizeOpenAIReasoningEffort(value.reasoningEffort),
    reasoningSummary: normalizeOpenAIReasoningSummary(value.reasoningSummary),
    textVerbosity: normalizeOpenAITextVerbosity(value.textVerbosity),
    serviceTier: normalizeOpenAIServiceTier(value.serviceTier),
    truncation: normalizeOpenAITruncation(value.truncation),
    stream: booleanOrUndefined(value.stream),
    parallelToolCalls: booleanOrUndefined(value.parallelToolCalls),
    store: booleanOrUndefined(value.store),
  };
  return compactOpenAIModelRequestSettings(normalized);
}

export function parseOpenAIModelRequestSettings(value: unknown): OpenAIModelRequestSettings | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return undefined;
  }
  return normalizeOpenAIModelRequestSettings({
    temperature: numberFromUnknown(record.temperature),
    topP: numberFromUnknown(record.topP),
    maxOutputTokens: positiveIntegerFromUnknown(record.maxOutputTokens),
    reasoningEffort: parseOpenAIReasoningEffort(record.reasoningEffort),
    reasoningSummary: parseOpenAIReasoningSummary(record.reasoningSummary),
    textVerbosity: parseOpenAITextVerbosity(record.textVerbosity),
    serviceTier: parseOpenAIServiceTier(record.serviceTier),
    truncation: parseOpenAITruncation(record.truncation),
    stream: booleanFromUnknown(record.stream),
    parallelToolCalls: booleanFromUnknown(record.parallelToolCalls),
    store: booleanFromUnknown(record.store),
  });
}

function compactOpenAIModelRequestSettings(
  value: OpenAIModelRequestSettings
): OpenAIModelRequestSettings | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return entries.length === 0 ? undefined : Object.fromEntries(entries) as OpenAIModelRequestSettings;
}

function normalizeOpenAIReasoningEffort(
  value: OpenAIModelRequestSettings["reasoningEffort"] | undefined
): OpenAIModelRequestSettings["reasoningEffort"] | undefined {
  return value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : undefined;
}

function normalizeOpenAIReasoningSummary(
  value: OpenAIModelRequestSettings["reasoningSummary"] | undefined
): OpenAIModelRequestSettings["reasoningSummary"] | undefined {
  return value === "auto" || value === "concise" || value === "detailed" ? value : undefined;
}

function normalizeOpenAITextVerbosity(
  value: OpenAIModelRequestSettings["textVerbosity"] | undefined
): OpenAIModelRequestSettings["textVerbosity"] | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function normalizeOpenAIServiceTier(
  value: OpenAIModelRequestSettings["serviceTier"] | undefined
): OpenAIModelRequestSettings["serviceTier"] | undefined {
  return value === "auto" || value === "default" || value === "flex" || value === "priority" ? value : undefined;
}

function normalizeOpenAITruncation(
  value: OpenAIModelRequestSettings["truncation"] | undefined
): OpenAIModelRequestSettings["truncation"] | undefined {
  return value === "auto" || value === "disabled" ? value : undefined;
}

function parseOpenAIReasoningEffort(value: unknown): OpenAIModelRequestSettings["reasoningEffort"] | undefined {
  return typeof value === "string" ? normalizeOpenAIReasoningEffort(value as OpenAIModelRequestSettings["reasoningEffort"]) : undefined;
}

function parseOpenAIReasoningSummary(value: unknown): OpenAIModelRequestSettings["reasoningSummary"] | undefined {
  return typeof value === "string" ? normalizeOpenAIReasoningSummary(value as OpenAIModelRequestSettings["reasoningSummary"]) : undefined;
}

function parseOpenAITextVerbosity(value: unknown): OpenAIModelRequestSettings["textVerbosity"] | undefined {
  return typeof value === "string" ? normalizeOpenAITextVerbosity(value as OpenAIModelRequestSettings["textVerbosity"]) : undefined;
}

function parseOpenAIServiceTier(value: unknown): OpenAIModelRequestSettings["serviceTier"] | undefined {
  return typeof value === "string" ? normalizeOpenAIServiceTier(value as OpenAIModelRequestSettings["serviceTier"]) : undefined;
}

function parseOpenAITruncation(value: unknown): OpenAIModelRequestSettings["truncation"] | undefined {
  return typeof value === "string" ? normalizeOpenAITruncation(value as OpenAIModelRequestSettings["truncation"]) : undefined;
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeNumberInRange(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(min, Math.min(max, value));
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveIntegerFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function booleanFromUnknown(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function booleanOrUndefined(value: boolean | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
