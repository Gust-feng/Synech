export type {
  UpdateManagedAssetTextInput,
  UpdateManagedAssetTextResult,
  UpdateManagedAssetCaptionInput,
  UpdateManagedAssetCaptionResult,
  ManagedAsset,
  ManagedAssetKind,
  ManagedAssetRepository,
  ManagedAssetEvent,
  ManagedAssetsFeature,
} from "./contracts.js";
export {
  editableManagedAssetText,
  MAX_MANAGED_ASSET_TEXT_BYTES,
  replaceManagedAssetText,
  managedAssetTextFingerprint,
} from "./asset-text.js";
export {
  MAX_MANAGED_ASSET_CAPTION_BYTES,
  replaceManagedAssetCaption,
  managedAssetCaptionFingerprint,
} from "./asset-caption.js";
export { createSqliteManagedAssetRepository } from "./sqlite-repository.js";

export { createManagedAssetsFeature } from "./managed-assets-feature.js";
