import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import type { DocumentPreview } from "../../panel-api/workbench.js";
import {
  editableManagedAssetText,
  MAX_MANAGED_ASSET_CAPTION_BYTES,
  MAX_MANAGED_ASSET_TEXT_BYTES,
  type UpdateManagedAssetCaptionInput,
  type UpdateManagedAssetCaptionResult,
  type UpdateManagedAssetTextInput,
  type UpdateManagedAssetTextResult,
  type ManagedAsset,
  type ManagedAssetsFeature,
  managedAssetTextFingerprint,
} from "../../managed-assets/index.js";
import { PanelHttpError, readJsonBody, writeJson } from "../http-utils.js";
import { createManagedAssetPreviewFromAsset } from "./managed-asset-preview.js";
import { documentPresentation } from "./document-preview-presentation.js";

type ManagedAssetRouteRuntime = {
  readonly ensureDefaultSpace: () => Promise<void>;
  readonly managedAssets: {
    readonly commands: Pick<ManagedAssetsFeature["commands"], "updateText" | "updateCaption">;
    readonly queries: Pick<ManagedAssetsFeature["queries"], "get">;
  };
};

const updateTextSchema = z.object({
  itemId: z.string().min(1).max(512).optional(),
  relativePath: z.literal("").optional(),
  expectedFingerprint: z.string().min(1).max(512),
  text: z.string(),
}).strict();

const updateCaptionSchema = z.object({
  itemId: z.string().min(1).max(512).optional(),
  relativePath: z.literal("").optional(),
  expectedFingerprint: z.string().min(1).max(512),
  caption: z.string(),
}).strict();

export async function handlePanelManagedAssetRoute(
  runtime: ManagedAssetRouteRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const previewMatch = /^\/api\/managed-assets\/([^/]+)\/preview$/u.exec(url.pathname);
  if (previewMatch !== null && request.method === "GET") {
    await runtime.ensureDefaultSpace();
    const preview = await getManagedAssetPreview(runtime.managedAssets.queries, decode(previewMatch[1]));
    writeJson(response, 200, { ok: true, preview });
    return true;
  }

  const contentMatch = /^\/api\/managed-assets\/([^/]+)\/content$/u.exec(url.pathname);
  if (contentMatch !== null && request.method === "PUT") {
    await runtime.ensureDefaultSpace();
    const assetId = decode(contentMatch[1]);
    const input = parseUpdateInput(await readJsonBody(request, { maxChars: MAX_MANAGED_ASSET_TEXT_BYTES * 6 + 2_048 }));
    if (input.itemId !== undefined && input.itemId !== assetId) {
      throw new PanelHttpError(400, "invalid_managed_asset_input", "请求资产与路径中的资产不一致。");
    }
    writeJson(response, 200, { ok: true, preview: await updateManagedAssetTextPreview(
      runtime.managedAssets.commands,
      { assetId, expectedFingerprint: input.expectedFingerprint, text: input.text },
    ) });
    return true;
  }

  const captionMatch = /^\/api\/managed-assets\/([^/]+)\/caption$/u.exec(url.pathname);
  if (captionMatch !== null && request.method === "PUT") {
    await runtime.ensureDefaultSpace();
    const assetId = decode(captionMatch[1]);
    const input = parseCaptionUpdateInput(await readJsonBody(request, { maxChars: MAX_MANAGED_ASSET_CAPTION_BYTES * 2 + 2_048 }));
    if (input.itemId !== undefined && input.itemId !== assetId) {
      throw new PanelHttpError(400, "invalid_managed_asset_input", "请求资产与路径中的资产不一致。");
    }
    writeJson(response, 200, { ok: true, preview: await updateManagedAssetCaptionPreview(
      runtime.managedAssets.commands,
      { assetId, expectedFingerprint: input.expectedFingerprint, caption: input.caption },
    ) });
    return true;
  }

  return false;
}

export async function updateManagedAssetTextPreview(
  repository: { updateText(input: UpdateManagedAssetTextInput): Promise<UpdateManagedAssetTextResult> },
  input: { readonly assetId: string; readonly expectedFingerprint: string; readonly text: string },
  itemId = input.assetId,
): Promise<DocumentPreview> {
  if (Buffer.byteLength(input.text, "utf8") > MAX_MANAGED_ASSET_TEXT_BYTES) {
    throw new PanelHttpError(413, "managed_asset_text_too_large", "托管文本资产超过可编辑大小上限。");
  }
  const result = await repository.updateText({
    id: input.assetId,
    expectedFingerprint: input.expectedFingerprint,
    text: input.text,
  });
  switch (result.status) {
    case "updated": return createManagedAssetTextPreview(result.asset, itemId);
    case "not_found": throw new PanelHttpError(404, "managed_asset_not_found", "托管资产已不存在。");
    case "not_editable": throw new PanelHttpError(409, "managed_asset_not_editable", "只有 Markdown 和代码文本资产可以编辑。");
    case "conflict": throw new PanelHttpError(409, "managed_asset_revision_conflict", "托管资产已发生变化，请先比较更改。");
    case "too_large": throw new PanelHttpError(413, "managed_asset_text_too_large", "托管文本资产超过可编辑大小上限。");
  }
}

export async function updateManagedAssetCaptionPreview(
  repository: { updateCaption(input: UpdateManagedAssetCaptionInput): Promise<UpdateManagedAssetCaptionResult> },
  input: { readonly assetId: string; readonly expectedFingerprint: string; readonly caption: string },
  itemId = input.assetId,
): Promise<DocumentPreview> {
  if (Buffer.byteLength(input.caption, "utf8") > MAX_MANAGED_ASSET_CAPTION_BYTES) {
    throw new PanelHttpError(413, "managed_asset_caption_too_large", "图片说明超过可编辑大小上限。");
  }
  const result = await repository.updateCaption({
    id: input.assetId,
    expectedFingerprint: input.expectedFingerprint,
    caption: input.caption,
  });
  switch (result.status) {
    case "updated": return createManagedAssetPreviewFromAsset(result.asset, itemId);
    case "not_found": throw new PanelHttpError(404, "managed_asset_not_found", "托管资产已不存在。");
    case "not_editable": throw new PanelHttpError(409, "managed_asset_caption_not_editable", "只有图片资产可以编辑说明。");
    case "conflict": throw new PanelHttpError(409, "managed_asset_revision_conflict", "图片说明已发生变化，请重新加载后再编辑。");
    case "too_large": throw new PanelHttpError(413, "managed_asset_caption_too_large", "图片说明超过可编辑大小上限。");
  }
}

export async function getManagedAssetPreview(
  repository: { get(id: string): Promise<ManagedAsset | undefined> },
  assetId: string,
  itemId = assetId,
): Promise<DocumentPreview> {
  const asset = await repository.get(assetId);
  if (asset === undefined) throw new PanelHttpError(404, "managed_asset_not_found", "托管资产已不存在。");
  return createManagedAssetTextPreview(asset, itemId);
}

export function createManagedAssetTextPreview(
  asset: ManagedAsset,
  itemId = asset.id,
): DocumentPreview {
  const preview = createManagedAssetPreviewFromAsset(asset, itemId);
  const editable = editableManagedAssetText(asset);
  if (editable === undefined || preview.content.kind !== "text") return preview;
  const content: Extract<DocumentPreview["content"], { readonly kind: "text" }> = {
    ...preview.content,
    text: editable.text,
    truncated: false,
    editable: true,
    language: editable.language,
    encoding: "UTF-8",
  };
  return {
    ...preview,
    fingerprint: managedAssetTextFingerprint(editable.text),
    byteLength: Buffer.byteLength(editable.text, "utf8"),
    presentation: documentPresentation(content),
    content,
  };
}

function parseUpdateInput(raw: unknown): z.infer<typeof updateTextSchema> {
  const result = updateTextSchema.safeParse(raw);
  if (!result.success) {
    throw new PanelHttpError(400, "invalid_managed_asset_input", "托管资产编辑请求无效。");
  }
  return result.data;
}

function parseCaptionUpdateInput(raw: unknown): z.infer<typeof updateCaptionSchema> {
  const result = updateCaptionSchema.safeParse(raw);
  if (!result.success) {
    throw new PanelHttpError(400, "invalid_managed_asset_input", "图片说明编辑请求无效。");
  }
  return result.data;
}

function decode(value: string | undefined): string {
  return decodeURIComponent(value ?? "");
}
