export function normalizeOpenAICompatibleSdkBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/^https:\/\/api\.openai\.com$/i.test(trimmed)) {
    return `${trimmed}/v1`;
  }
  return trimmed;
}

export function isOfficialOpenAIBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.replace(/\/+$/, "").toLowerCase();
  return trimmed === "https://api.openai.com" || trimmed === "https://api.openai.com/v1";
}
