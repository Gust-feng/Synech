export const MODEL_CATALOG_DISPLAY_NAME_PARTS: Readonly<Record<string, string>> = {
  gpt: "GPT",
  codex: "Codex",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  glm: "GLM",
  chat: "Chat",
  reasoner: "Reasoner",
  turbo: "Turbo",
  mini: "Mini",
  nano: "Nano",
  pro: "Pro",
  spark: "Spark",
};

const MODEL_CATALOG_DISPLAY_NAME_PATTERN = /deepseek|reasoner|codex|spark|turbo|mini|nano|kimi|chat|glm|gpt|pro|v\d+(?:\.\d+)?|\d+(?:\.\d+)?/giu;

export function modelCatalogDisplayNameFromId(modelId: string): string {
  const id = modelId.trim();
  if (id.length === 0) {
    return modelId;
  }

  const displayName = modelCatalogDisplayName(id);
  return displayName.matched ? displayName.value : id;
}

export function normalizeModelCatalogDisplayName(displayName: string | undefined, modelId: string): string {
  const id = modelId.trim();
  if (id.length === 0) {
    return displayName ?? modelId;
  }
  const value = displayName?.trim();
  if (
    value === undefined ||
    value.length === 0 ||
    value === id ||
    isCosmeticDisplayNameEquivalent(value, id)
  ) {
    return modelCatalogDisplayNameFromId(id);
  }
  return value;
}

function modelCatalogDisplayName(value: string): { readonly value: string; readonly matched: boolean } {
  const segments: string[] = [];
  let matched = false;
  let cursor = 0;
  let previousMatchEnd: number | undefined;
  MODEL_CATALOG_DISPLAY_NAME_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(MODEL_CATALOG_DISPLAY_NAME_PATTERN)) {
    const index = match.index ?? 0;
    const end = index + match[0].length;
    if (!isDisplayNameMatchAccepted(value, index, end, previousMatchEnd, match[0])) {
      continue;
    }
    if (index > cursor) {
      segments.push(value.slice(cursor, index));
    }
    const display = displayNameMatch(match[0]);
    segments.push(display.value);
    matched ||= display.matched;
    cursor = end;
    previousMatchEnd = cursor;
  }
  if (cursor < value.length) {
    segments.push(value.slice(cursor));
  }
  return { value: segments.join(""), matched };
}

function isDisplayNameMatchAccepted(
  value: string,
  index: number,
  end: number,
  previousMatchEnd: number | undefined,
  match: string,
): boolean {
  if (!hasDisplayNameStartBoundary(value, index, previousMatchEnd)) {
    return false;
  }
  if (hasDisplayNameEndBoundary(value, end)) {
    return true;
  }
  if (isNumericDisplayNamePart(match)) {
    return true;
  }
  return startsDisplayNamePart(value, end);
}

function hasDisplayNameStartBoundary(value: string, index: number, previousMatchEnd: number | undefined): boolean {
  return index === 0 || previousMatchEnd === index || !isAsciiAlphaNumeric(value[index - 1]);
}

function hasDisplayNameEndBoundary(value: string, end: number): boolean {
  return end >= value.length || !isAsciiAlphaNumeric(value[end]);
}

function startsDisplayNamePart(value: string, index: number): boolean {
  return /^(?:deepseek|reasoner|codex|spark|turbo|mini|nano|kimi|chat|glm|gpt|pro|v\d+(?:\.\d+)?|\d+(?:\.\d+)?)/iu.test(
    value.slice(index),
  );
}

function isNumericDisplayNamePart(value: string): boolean {
  return /^(?:v)?\d+(?:\.\d+)?$/iu.test(value);
}

function isAsciiAlphaNumeric(value: string | undefined): boolean {
  return value !== undefined && /^[a-z0-9]$/iu.test(value);
}

function isCosmeticDisplayNameEquivalent(displayName: string, id: string): boolean {
  return modelCatalogDisplayNameComparisonKey(displayName) === modelCatalogDisplayNameComparisonKey(id);
}

function modelCatalogDisplayNameComparisonKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_/-]+/gu, "");
}

function displayNameMatch(value: string): { readonly value: string; readonly matched: boolean } {
  const staticPart = MODEL_CATALOG_DISPLAY_NAME_PARTS[value.toLowerCase()];
  if (staticPart !== undefined) {
    return { value: staticPart, matched: true };
  }
  const version = /^v(\d+(?:\.\d+)?)$/iu.exec(value);
  if (version !== null) {
    return { value: `V${version[1]}`, matched: true };
  }
  return { value, matched: false };
}
