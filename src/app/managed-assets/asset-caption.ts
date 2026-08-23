import { createHash } from "node:crypto";

import type { ManagedAsset } from "./contracts.js";

export const MAX_MANAGED_ASSET_CAPTION_BYTES = 16 * 1024;

export function managedAssetCaptionFingerprint(caption: string | undefined): string {
  return `sha256:${createHash("sha256").update(caption ?? "", "utf8").digest("hex")}`;
}

export function replaceManagedAssetCaption(asset: ManagedAsset, caption: string): ManagedAsset {
  if (asset.kind !== "image" || asset.image === undefined) return asset;
  return {
    ...asset,
    image: {
      ...asset.image,
      ...(caption.length === 0 ? { caption: undefined } : { caption }),
    },
  };
}
