export type ManagedAssetKind = "markdown" | "pdf" | "web" | "image" | "video" | "audio" | "code";

export type ManagedAsset = {
  readonly id: string;
  readonly kind: ManagedAssetKind;
  readonly title: string;
  readonly origin?: "library" | "space";
  readonly meta?: string;
  readonly thumbnail?: string;
  readonly markdown?: string;
  readonly pdf?: { readonly pages: readonly string[] };
  readonly web?: { readonly url: string; readonly site: string; readonly body: string };
  readonly image?: { readonly src: string; readonly alt: string; readonly caption?: string };
  readonly video?: { readonly src: string; readonly poster?: string; readonly duration?: string };
  readonly audio?: { readonly src: string; readonly duration?: string; readonly transcript?: string };
  readonly code?: { readonly language: string; readonly filename: string; readonly source: string };
};

export type UpdateManagedAssetTextInput = {
  readonly id: string;
  readonly expectedFingerprint: string;
  readonly text: string;
};

export type UpdateManagedAssetCaptionInput = {
  readonly id: string;
  readonly expectedFingerprint: string;
  readonly caption: string;
};

export type UpdateManagedAssetTextResult =
  | { readonly status: "updated"; readonly asset: ManagedAsset; readonly fingerprint: string }
  | { readonly status: "not_found" }
  | { readonly status: "not_editable"; readonly kind: ManagedAssetKind }
  | { readonly status: "conflict"; readonly fingerprint: string }
  | { readonly status: "too_large" };

export type UpdateManagedAssetCaptionResult =
  | { readonly status: "updated"; readonly asset: ManagedAsset; readonly fingerprint: string }
  | { readonly status: "not_found" }
  | { readonly status: "not_editable"; readonly kind: ManagedAssetKind }
  | { readonly status: "conflict"; readonly fingerprint: string }
  | { readonly status: "too_large" };

export interface ManagedAssetRepository {
  get(id: string): Promise<ManagedAsset | undefined>;
  list(): Promise<readonly ManagedAsset[]>;
  upsertMany(assets: readonly ManagedAsset[]): Promise<void>;
  /** Removes software-owned assets by id. Missing ids are ignored for idempotent Space cleanup. */
  removeMany(assetIds: readonly string[]): Promise<void>;
  updateText(input: UpdateManagedAssetTextInput): Promise<UpdateManagedAssetTextResult>;
  updateCaption(input: UpdateManagedAssetCaptionInput): Promise<UpdateManagedAssetCaptionResult>;
}

/** 资产变更事件：资产编辑与删除的单一观察事实。 */
export type ManagedAssetEvent = {
  readonly type: "managed_asset.changed";
  readonly assetId: string;
  readonly operation: "replaced" | "text_updated" | "caption_updated" | "removed";
};

/** 资产 feature 的公开 command/query/event facade。 */
export type ManagedAssetsFeature = {
  readonly commands: {
    replace(asset: ManagedAsset): Promise<void>;
    updateText(input: UpdateManagedAssetTextInput): Promise<UpdateManagedAssetTextResult>;
    updateCaption(input: UpdateManagedAssetCaptionInput): Promise<UpdateManagedAssetCaptionResult>;
    removeMany(assetIds: readonly string[]): Promise<void>;
  };
  readonly queries: {
    get(id: string): Promise<ManagedAsset | undefined>;
    list(): Promise<readonly ManagedAsset[]>;
  };
  readonly events: {
    subscribe(listener: (event: ManagedAssetEvent) => void): () => void;
  };
  release(): Promise<void>;
};
