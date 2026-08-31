import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { SpaceFeature, SpaceReferenceItem, SpaceWebReferenceMetadata } from "../../spaces/index.js";

const HTML_TIMEOUT_MS = 5_000;
const ICON_TIMEOUT_MS = 3_000;
const MAX_HTML_CHARS = 512 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
const ACCEPTED_ICON_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/x-icon", "image/vnd.microsoft.icon"]);

type WebFetch = typeof fetch;

export type WebReferenceMetadataWorker = {
  ready(): Promise<void>;
  release(): Promise<void>;
  readFavicon(referenceId: string): Promise<Uint8Array | undefined>;
};

export function createWebReferenceMetadataWorker(input: {
  readonly spaces: Pick<SpaceFeature, "commands" | "queries" | "events">;
  readonly faviconRoot: string;
  readonly fetch?: WebFetch;
  readonly onDiagnostic?: (input: {
    readonly referenceId: string;
    readonly phase: "startup" | "fetch" | "cleanup" | "worker";
    readonly code: string;
    readonly url?: string;
  }) => void | Promise<void>;
}): WebReferenceMetadataWorker {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const queued = new Set<string>();
  let released = false;
  let active: Promise<void> | undefined;
  const unsubscribe = input.spaces.events.subscribe((event) => {
    if (event.type === "space.reference_added" && event.item.reference.kind === "web_page") enqueue(event.item);
    if (event.type === "space.reference_removed") {
      for (const referenceId of event.removedItemIds) {
        void removeFavicon(input.faviconRoot, referenceId).catch((error: unknown) => void reportDiagnostic({ referenceId, phase: "cleanup", code: failureCode(error) }));
      }
    }
    if (event.type === "space.deleted") {
      for (const referenceId of event.removedReferenceIds) {
        void removeFavicon(input.faviconRoot, referenceId).catch((error: unknown) => void reportDiagnostic({ referenceId, phase: "cleanup", code: failureCode(error) }));
      }
    }
  });

  const start = (async () => {
    await fs.mkdir(input.faviconRoot, { recursive: true });
    const [pending, ready] = await Promise.all([
      input.spaces.queries.listWebReferencesByMetadataStatus("pending"),
      input.spaces.queries.listWebReferencesByMetadataStatus("ready"),
    ]);
    await reconcileFaviconCache(input.faviconRoot, new Set(ready
      .filter((item) => item.webMetadata?.favicon !== undefined)
      .map((item) => item.id)));
    for (const item of pending) enqueue(item);
  })();

  function enqueue(item: SpaceReferenceItem): void {
    if (released || item.reference.kind !== "web_page" || item.webMetadata?.status !== "pending" || queued.has(item.id)) return;
    queued.add(item.id);
    active ??= Promise.resolve().then(drain);
  }

  async function drain(): Promise<void> {
    while (!released && queued.size > 0) {
      const referenceId = queued.values().next().value as string;
      queued.delete(referenceId);
      try {
        await enrich(referenceId);
      } catch (error) {
        await reportDiagnostic({ referenceId, phase: "worker", code: failureCode(error) });
      }
    }
    active = undefined;
    if (!released && queued.size > 0) active = Promise.resolve().then(drain);
  }

  async function enrich(referenceId: string): Promise<void> {
    const item = await input.spaces.queries.getReference(referenceId);
    if (item?.reference.kind !== "web_page" || item.webMetadata?.status !== "pending") return;
    const expectedUrl = item.reference.url;
    try {
      const result = await fetchPageMetadata(fetchImpl, expectedUrl);
      const favicon = result.faviconUrl === undefined
        ? undefined
        : await fetchFavicon(fetchImpl, result.faviconUrl).catch(() => undefined);
      if (favicon !== undefined) await writeFavicon(input.faviconRoot, referenceId, favicon.bytes);
      const metadata: SpaceWebReferenceMetadata = {
        status: "ready",
        finalUrl: result.finalUrl,
        ...(result.canonicalUrl === undefined ? {} : { canonicalUrl: result.canonicalUrl }),
        ...(result.pageTitle === undefined ? {} : { pageTitle: result.pageTitle }),
        ...(result.siteName === undefined ? {} : { siteName: result.siteName }),
        ...(favicon === undefined ? {} : { favicon: { mediaType: favicon.mediaType } }),
        fetchedAt: new Date().toISOString(),
      };
      const updated = await input.spaces.commands.updateWebReferenceMetadata({ itemId: referenceId, expectedUrl, metadata });
      if (updated === undefined && favicon !== undefined) await removeFavicon(input.faviconRoot, referenceId);
    } catch (error) {
      await reportDiagnostic({ referenceId, phase: "fetch", code: failureCode(error), url: expectedUrl });
      await input.spaces.commands.updateWebReferenceMetadata({
        itemId: referenceId,
        expectedUrl,
        metadata: { status: "failed", failureCode: failureCode(error) },
      });
    }
  }

  async function reportDiagnostic(diagnostic: {
    readonly referenceId: string;
    readonly phase: "startup" | "fetch" | "cleanup" | "worker";
    readonly code: string;
    readonly url?: string;
  }): Promise<void> {
    try {
      await input.onDiagnostic?.(diagnostic);
    } catch (error) {
      console.error("[panel-server] Could not persist web metadata diagnostic", error);
    }
  }

  return {
    ready: async () => {
      try {
        await start;
      } catch (error) {
        await reportDiagnostic({ referenceId: "startup", phase: "startup", code: failureCode(error) });
        throw error;
      }
    },
    async release() {
      if (released) return;
      released = true;
      unsubscribe();
      await start.catch(() => undefined);
      await active;
    },
    async readFavicon(referenceId) {
      return await fs.readFile(faviconPath(input.faviconRoot, referenceId)).catch((error: unknown) => {
        if (isNotFound(error)) return undefined;
        throw error;
      });
    },
  };
}

async function fetchPageMetadata(fetchImpl: WebFetch, url: string): Promise<{
  readonly finalUrl: string;
  readonly canonicalUrl?: string;
  readonly pageTitle?: string;
  readonly siteName?: string;
  readonly faviconUrl?: string;
}> {
  const response = await fetchImpl(requireHttpUrl(url), {
    redirect: "follow",
    headers: { "user-agent": "Synech/1.0 web metadata" },
    signal: AbortSignal.timeout(HTML_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`web_metadata_http_${response.status}`);
  const finalUrl = requireHttpUrl(response.url);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    return { finalUrl };
  }
  const html = (await response.text()).slice(0, MAX_HTML_CHARS);
  const canonicalUrl = absoluteUrl(firstLink(html, "canonical"), finalUrl);
  const faviconUrl = absoluteUrl(firstIconHref(html), finalUrl) ?? new URL("/favicon.ico", finalUrl).toString();
  const siteName = metaContent(html, "property", "og:site_name") ?? metaContent(html, "name", "application-name");
  const pageTitle = pageTitleFrom(html);
  return {
    finalUrl,
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
    ...(pageTitle === undefined ? {} : { pageTitle }),
    ...(siteName === undefined ? {} : { siteName }),
    faviconUrl,
  };
}

async function fetchFavicon(fetchImpl: WebFetch, url: string): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
  const response = await fetchImpl(requireHttpUrl(url), { redirect: "follow", signal: AbortSignal.timeout(ICON_TIMEOUT_MS) });
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!response.ok || !ACCEPTED_ICON_TYPES.has(mediaType)) throw new Error("web_metadata_favicon_unavailable");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) throw new Error("web_metadata_favicon_size_invalid");
  return { bytes, mediaType };
}

function metaContent(html: string, attribute: "name" | "property", value: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
    if (attributeValue(tag, attribute)?.toLowerCase() === value && attributeValue(tag, "content") !== undefined) {
      return decodeHtml(attributeValue(tag, "content")!).slice(0, 256) || undefined;
    }
  }
  return undefined;
}

function firstLink(html: string, relation: string): string | undefined {
  for (const tag of html.match(/<link\b[^>]*>/giu) ?? []) {
    if (attributeValue(tag, "rel")?.split(/\s+/u).some((value) => value.toLowerCase() === relation) === true) return attributeValue(tag, "href");
  }
  return undefined;
}

function firstIconHref(html: string): string | undefined {
  for (const tag of html.match(/<link\b[^>]*>/giu) ?? []) {
    if (attributeValue(tag, "rel")?.toLowerCase().includes("icon") === true) return attributeValue(tag, "href");
  }
  return undefined;
}

function pageTitleFrom(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  return match === null ? undefined : decodeHtml(match[1] ?? "").replace(/\s+/gu, " ").trim().slice(0, 512) || undefined;
}

function attributeValue(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu").exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function absoluteUrl(value: string | undefined, base: string): string | undefined {
  if (value === undefined) return undefined;
  try { return requireHttpUrl(new URL(value, base).toString()); } catch { return undefined; }
}

function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|quot|#39|lt|gt);/giu, (entity) => ({ "&amp;": "&", "&quot;": "\"", "&#39;": "'", "&lt;": "<", "&gt;": ">" })[entity.toLowerCase()] ?? entity);
}

function requireHttpUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("web_metadata_invalid_url");
  return parsed.toString();
}

function faviconPath(root: string, referenceId: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(referenceId)) throw new Error("web_metadata_invalid_reference_id");
  return path.join(root, referenceId, "favicon");
}

async function writeFavicon(root: string, referenceId: string, bytes: Uint8Array): Promise<void> {
  const target = faviconPath(root, referenceId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, bytes);
  await fs.rename(temporary, target).catch(async (error) => {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  });
}

async function removeFavicon(root: string, referenceId: string): Promise<void> {
  await fs.rm(path.dirname(faviconPath(root, referenceId)), { recursive: true, force: true });
}

async function reconcileFaviconCache(root: string, retainedReferenceIds: ReadonlySet<string>): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !retainedReferenceIds.has(entry.name))
    .map(async (entry) => await fs.rm(path.join(root, entry.name), { recursive: true, force: true })));
}

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "web_metadata_failed";
  return /^[a-z0-9_]{1,128}$/u.test(message) ? message : "web_metadata_failed";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT";
}
