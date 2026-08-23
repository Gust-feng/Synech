import { createHash } from "node:crypto";

import type { ManagedAsset } from "./contracts.js";

export const MAX_MANAGED_ASSET_TEXT_BYTES = 512 * 1024;

export type EditableManagedAssetText = {
  readonly text: string;
  readonly language: string;
};

export function editableManagedAssetText(asset: ManagedAsset): EditableManagedAssetText | undefined {
  if (asset.kind === "markdown") return { text: asset.markdown ?? "", language: "md" };
  if (asset.kind === "code" && asset.code !== undefined) {
    return { text: asset.code.source, language: asset.code.language };
  }
  return undefined;
}

export function managedAssetTextFingerprint(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function replaceManagedAssetText(asset: ManagedAsset, text: string): ManagedAsset {
  if (asset.kind === "markdown") return { ...asset, markdown: text };
  if (asset.kind === "code" && asset.code !== undefined) {
    return { ...asset, code: { ...asset.code, source: text } };
  }
  return asset;
}
