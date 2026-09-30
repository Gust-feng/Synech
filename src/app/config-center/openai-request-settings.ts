import { asRecord } from "../../kernel/values/index.js";
import type { OpenAIModelRequestSettings } from "../../domain/config/index.js";

export function normalizeOpenAIModelRequestSettings(
  value: OpenAIModelRequestSettings | undefined,
): OpenAIModelRequestSettings | undefined {
  if (value === undefined) return undefined;
  const normalized: OpenAIModelRequestSettings = {
    temperature: numberInRange(value.temperature, 0, 2),
    topP: numberInRange(value.topP, 0, 1),
    maxOutputTokens: positiveInteger(value.maxOutputTokens),
    reasoningEffort: value.reasoningEffort,
    reasoningSummary: value.reasoningSummary,
    textVerbosity: value.textVerbosity,
    serviceTier: value.serviceTier,
    truncation: value.truncation,
    parallelToolCalls: typeof value.parallelToolCalls === "boolean" ? value.parallelToolCalls : undefined,
    store: typeof value.store === "boolean" ? value.store : undefined,
  };
  const entries = Object.entries(normalized).filter(([, item]) => item !== undefined);
  return entries.length === 0 ? undefined : Object.fromEntries(entries) as OpenAIModelRequestSettings;
}

export function parseOpenAIModelRequestSettings(value: unknown): OpenAIModelRequestSettings | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return undefined;
  return normalizeOpenAIModelRequestSettings({
    temperature: finiteNumber(record.temperature),
    topP: finiteNumber(record.topP),
    maxOutputTokens: positiveIntegerFromUnknown(record.maxOutputTokens),
    reasoningEffort: typeof record.reasoningEffort === "string" ? record.reasoningEffort as OpenAIModelRequestSettings["reasoningEffort"] : undefined,
    reasoningSummary: typeof record.reasoningSummary === "string" ? record.reasoningSummary as OpenAIModelRequestSettings["reasoningSummary"] : undefined,
    textVerbosity: typeof record.textVerbosity === "string" ? record.textVerbosity as OpenAIModelRequestSettings["textVerbosity"] : undefined,
    serviceTier: typeof record.serviceTier === "string" ? record.serviceTier as OpenAIModelRequestSettings["serviceTier"] : undefined,
    truncation: typeof record.truncation === "string" ? record.truncation as OpenAIModelRequestSettings["truncation"] : undefined,
    parallelToolCalls: typeof record.parallelToolCalls === "boolean" ? record.parallelToolCalls : undefined,
    store: typeof record.store === "boolean" ? record.store : undefined,
  });
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : Math.max(1, Math.floor(value));
}

function positiveIntegerFromUnknown(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number === undefined || number <= 0 ? undefined : Math.floor(number);
}

function numberInRange(value: number | undefined, min: number, max: number): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : Math.max(min, Math.min(max, value));
}
