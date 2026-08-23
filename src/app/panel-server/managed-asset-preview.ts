import type { DocumentPreview } from "../panel-api-contracts.js";
import type { ManagedAsset } from "../managed-assets/index.js";
import { managedAssetCaptionFingerprint } from "../managed-assets/asset-caption.js";
import { documentPresentation } from "./document-preview-presentation.js";

export function createManagedAssetPreviewFromAsset(asset: ManagedAsset, itemId = asset.id): DocumentPreview {
  const content = contentOf(asset);
  return {
    itemId,
    title: asset.title,
    sourceKind: "managed_asset",
    source: `managed-asset:${asset.id}`,
    status: "ready",
    fingerprint: `asset:${asset.id}`,
    presentation: documentPresentation(content),
    content,
  };
}

function contentOf(asset: ManagedAsset): DocumentPreview["content"] {
  switch (asset.kind) {
    case "markdown": return { kind: "text", text: asset.markdown ?? "", truncated: false, editable: false, language: "md", encoding: "UTF-8" };
    case "code": return { kind: "text", text: asset.code?.source ?? "", truncated: false, editable: false, language: asset.code?.language, encoding: "UTF-8" };
    case "pdf": return { kind: "pages", pages: asset.pdf?.pages ?? [] };
    case "web": return { kind: "web", url: asset.web?.url ?? "", site: asset.web?.site, body: asset.web?.body };
    case "image": return { kind: "media", mediaKind: "image", mimeType: imageMimeType(asset.image?.src), url: asset.image?.src ?? "", alt: asset.image?.alt, caption: asset.image?.caption, captionEditable: true, captionFingerprint: managedAssetCaptionFingerprint(asset.image?.caption) };
    case "video": return { kind: "media", mediaKind: "video", mimeType: "video/mp4", url: asset.video?.src ?? "", poster: asset.video?.poster, duration: asset.video?.duration };
    case "audio": return { kind: "media", mediaKind: "audio", mimeType: "audio/mpeg", url: asset.audio?.src ?? "", duration: asset.audio?.duration, transcript: asset.audio?.transcript };
  }
}

function imageMimeType(value: string | undefined): string {
  if (value?.toLowerCase().includes(".png")) return "image/png";
  if (value?.toLowerCase().includes(".webp")) return "image/webp";
  return "image/jpeg";
}
