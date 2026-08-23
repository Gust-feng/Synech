import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type PanelStaticAsset = {
  readonly contentType: string;
  readonly body: Buffer;
};

export const PANEL_BRAND_LOGO_PATHNAME = "/favicon.svg";

export function createPanelHtml(): string {
  return readPanelTextAsset("index.html");
}

export function readPanelBrandLogoAsset(): PanelStaticAsset {
  return {
    contentType: "image/svg+xml",
    body: readFileSync(resolvePanelBrandLogoPath()),
  };
}

export function resolvePanelBrandLogoPath(): string {
  const candidates = panelAssetRoots().flatMap((root) => [
    path.join(root, "favicon.svg"),
    path.join(root, "public", "favicon.svg"),
  ]);
  return resolveFirstExistingFile(candidates, "Panel brand logo asset not found: favicon.svg");
}

export function resolvePanelDesktopIconPath(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDirectory, "..", "desktop-assets", "favicon.png"),
    path.join(process.cwd(), "dist", "app", "desktop-assets", "favicon.png"),
  ];
  return resolveFirstExistingFile(candidates, "Generated desktop icon asset not found. Run pnpm generate:icons.");
}

export function readPanelStaticAsset(pathname: string): PanelStaticAsset | undefined {
  const assetRelativePath = safeViteAssetPath(pathname);
  if (assetRelativePath === undefined) {
    return undefined;
  }
  for (const root of viteAssetRoots()) {
    const assetPath = path.resolve(root, assetRelativePath);
    if (!isInsideDirectory(root, assetPath)) {
      return undefined;
    }
    try {
      return {
        contentType: contentTypeForAsset(assetPath),
        body: readFileSync(assetPath),
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      throw error;
    }
  }
  return undefined;
}

export function createPanelClientScript(): string {
  return readFirstBuiltAsset(".js");
}

export function createPanelStylesheet(): string {
  return readFirstBuiltAsset(".css");
}

function readPanelTextAsset(assetName: string): string {
  const assetPath = resolvePanelAssetPath(assetName);
  return readFileSync(assetPath, "utf8");
}

function resolvePanelAssetPath(assetName: string): string {
  const candidates = panelAssetRoots().map((root) => path.join(root, assetName));
  return resolveFirstExistingFile(candidates, `Panel static asset not found: ${assetName}`);
}

function resolveFirstExistingFile(candidates: readonly string[], missingMessage: string): string {
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(missingMessage);
}

function panelAssetRoots(): readonly string[] {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return [
    // Production and tests serve the Vite build output from dist/app/panel-ui.
    path.join(moduleDirectory, "..", "panel-ui"),
    // Source fallback keeps static HTML smoke checks readable before Vite has built.
    path.join(process.cwd(), "src", "app", "panel-ui"),
  ];
}

function viteAssetRoots(): readonly string[] {
  return panelAssetRoots().map((root) => path.join(root, "assets"));
}

function safeViteAssetPath(pathname: string): string | undefined {
  const prefix = "/assets/";
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const raw = pathname.slice(prefix.length);
  if (raw.length === 0) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  const normalized = path.normalize(decoded);
  if (normalized.startsWith("..") || path.isAbsolute(normalized) || normalized.includes(`..${path.sep}`)) {
    return undefined;
  }
  return normalized;
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function contentTypeForAsset(assetPath: string): string {
  const extension = path.extname(assetPath).toLowerCase();
  if (extension === ".js" || extension === ".mjs") {
    return "text/javascript; charset=utf-8";
  }
  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }
  if (extension === ".json" || extension === ".map") {
    return "application/json; charset=utf-8";
  }
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".ico") {
    return "image/x-icon";
  }
  return "application/octet-stream";
}

function readFirstBuiltAsset(extension: ".css" | ".js"): string {
  for (const root of viteAssetRoots()) {
    let entries: readonly string[];
    try {
      entries = readdirSync(root);
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      throw error;
    }
    const assetName = entries.find((entry) => entry.endsWith(extension));
    if (assetName !== undefined) {
      return readFileSync(path.join(root, assetName), "utf8");
    }
  }
  throw new Error(`Panel Vite ${extension} asset not found. Run pnpm build:panel first.`);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT";
}