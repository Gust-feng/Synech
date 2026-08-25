const MAX_PROVIDER_LOGO_BYTES = 3 * 1024 * 1024;
const PROVIDER_LOGO_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);
const PROVIDER_LOGO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export function supportedLogoMimeType(file: File): string | undefined {
  if (file.size > MAX_PROVIDER_LOGO_BYTES) return undefined;
  if (PROVIDER_LOGO_MIME_TYPES.has(file.type)) return file.type;
  const normalizedName = file.name.toLowerCase();
  const extension = Object.keys(PROVIDER_LOGO_MIME_BY_EXTENSION).find((item) => normalizedName.endsWith(item));
  return extension === undefined ? undefined : PROVIDER_LOGO_MIME_BY_EXTENSION[extension];
}

export function logoDataUrlFromFileReaderResult(
  result: FileReader["result"],
  mimeType: string,
): string | undefined {
  if (typeof result !== "string") return undefined;
  const separator = result.indexOf(",");
  if (!result.startsWith("data:") || separator < 0) return undefined;
  return `data:${mimeType};base64,${result.slice(separator + 1)}`;
}
