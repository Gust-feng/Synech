/** Durable metadata for the roots visible in one Space. File descendants stay in their owning filesystem. */
export const SPACE_TREE_SCHEMA_VERSION = "space-tree/v1" as const;

export type SpaceReference =
  | { readonly kind: "local_file"; readonly path: string }
  | { readonly kind: "workspace"; readonly workspaceId: string }
  | { readonly kind: "managed_folder"; readonly path: string }
  | { readonly kind: "asset_folder" }
  | { readonly kind: "managed_asset"; readonly assetId: string }
  | { readonly kind: "web_page"; readonly url: string }
  | { readonly kind: "generated_artifact"; readonly artifactRef: string };

/** References that may be created through the ordinary Space reference command. */
export type SpaceAddableReference = SpaceReference;

/** User-owned single-file source. Complete external directories are Workspace objects. */
export type SpaceExternalFileReference = Extract<SpaceReference, { readonly kind: "local_file" }>;

export type Space = {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type SpaceReferenceItem = {
  readonly id: string;
  readonly spaceId: string;
  readonly title: string;
  readonly parentId?: string;
  readonly reference: SpaceReference;
  /** Stable platform identity for a direct local-file source; Workspace identity belongs to WorkspaceFeature. */
  readonly sourceIdentity?: string;
  /** Agent/user-maintained understanding of the source. It is never the source body itself. */
  readonly annotation?: SpaceReferenceAnnotation;
  /** Space-owned image captions keyed by normalized relative path; the empty key addresses a root file. */
  readonly imageCaptions?: Readonly<Record<string, SpaceReferenceImageCaption>>;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/**
 * Agent 或用户对引用来源的整理内容（产品内容）。
 *
 * 与 `reference`（来源事实）严格分离：`annotation` 表达“对这个来源的理解”，
 * 不保存抓取正文、网页快照或文件内容。revision 由 SpaceFeature 管理，
 * 输入侧（工具/HTTP）不提交 revision、时间或 actor。
 */
export type SpaceReferenceAnnotation = {
  /** Agent 或用户维护的 Markdown，不是来源网页原文或文件正文。 */
  readonly markdown: string;
  readonly keyPoints?: readonly string[];
  readonly tags?: readonly string[];
  readonly revision: number;
  readonly updatedAt: string;
  readonly updatedBy: SpaceReferenceActorKind;
  /** 写入审计（对齐 Personal Knowledge actor）。 */
  readonly actor: SpaceReferenceActorRecord;
};

/** 工具/用户提交的 annotation 内容字段；revision、时间与 actor 由 SpaceFeature 生成。 */
export type SpaceReferenceAnnotationInput = {
  readonly markdown: string;
  readonly keyPoints?: readonly string[];
  readonly tags?: readonly string[];
};

/** 更新 annotation 时的部分内容；未提供的字段保持原值，不能无意清空。 */
export type SpaceReferenceAnnotationPatch = {
  readonly markdown?: string;
  readonly keyPoints?: readonly string[];
  readonly tags?: readonly string[];
};

export type SpaceReferenceActorKind = "agent" | "user";

export type SpaceReferenceImageCaption = {
  readonly text: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly updatedBy: SpaceReferenceActorKind;
  readonly actor: SpaceReferenceActorRecord;
};

/** 一次 annotation 写入的完整审计来源；`kind` 是显示语义，其余字段来自执行上下文。 */
export type SpaceReferenceActorRecord = {
  readonly kind: SpaceReferenceActorKind;
  /** Agent 侧为 callerAgentId；用户侧为平台用户身份（当前尚无）。 */
  readonly actorId?: string;
  readonly traceId?: string;
  readonly goalId?: string;
  readonly toolCallId?: string;
};

export type SpaceTreeSnapshot = {
  readonly schemaVersion: typeof SPACE_TREE_SCHEMA_VERSION;
  /** Space order is durable display order; content edits must not reorder Spaces. */
  readonly spaces: readonly Space[];
  /** Display order for top-level references; index 0 is the top of a Space. */
  readonly referenceItems: readonly SpaceReferenceItem[];
};

export type SpaceTreeEntry = { readonly kind: "reference"; readonly item: SpaceReferenceItem };
export type SpaceTree = { readonly space: Space; readonly entries: readonly SpaceTreeEntry[] };
export type SpaceSummary = Pick<Space, "id" | "title" | "createdAt" | "updatedAt"> & {
  readonly folderCount: number;
  readonly referenceItemCount: number;
};

export interface SpaceRepository {
  read(): Promise<SpaceTreeSnapshot>;
  write(snapshot: SpaceTreeSnapshot): Promise<void>;
}

/** Narrow cross-feature port for deleting software-owned Synech assets. */
export interface SpaceOwnedAssetDeletionPort {
  deleteManagedAssets(assetIds: readonly string[]): Promise<void>;
}

export type SpaceTarget = { readonly kind: "space" | "reference"; readonly id: string };
export type SpaceMovableTarget = { readonly kind: "reference"; readonly id: string };

export type SpaceFeatureErrorCode =
  | "space_feature_released"
  | "space_not_found"
  | "space_reference_not_found"
  | "space_invalid_move"
  | "space_workspace_mount_conflict"
  | "space_asset_ownership_conflict"
  | "space_invalid_input"
  | "space_id_collision"
  | "space_snapshot_incompatible"
  | "space_deletion_journal_failure"
  | "space_deletion_recovery_failed"
  | "space_repository_failure"
  | "space_reference_annotation_invalid"
  | "space_reference_annotation_revision_conflict"
  | "space_reference_annotation_too_large"
  | "space_reference_image_caption_invalid"
  | "space_reference_image_caption_revision_conflict"
  | "space_reference_image_caption_too_large";

export class SpaceFeatureError extends Error {
  readonly name = "SpaceFeatureError";
  constructor(readonly code: SpaceFeatureErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export type SpaceEvent =
  | { readonly type: "space.created"; readonly space: Space }
  | { readonly type: "space.deleted"; readonly spaceId: string; readonly removedReferenceIds: readonly string[] }
  | { readonly type: "space.reference_added"; readonly item: SpaceReferenceItem }
  | { readonly type: "space.reference_source_identity_updated"; readonly item: SpaceReferenceItem }
  | { readonly type: "space.reference_annotation_updated"; readonly item: SpaceReferenceItem }
  | { readonly type: "space.reference_image_caption_updated"; readonly item: SpaceReferenceItem; readonly relativePath: string }
  | { readonly type: "space.renamed"; readonly target: SpaceTarget; readonly spaceId: string }
  | { readonly type: "space.moved"; readonly target: SpaceMovableTarget; readonly sourceSpaceId: string; readonly destinationSpaceId: string }
  | { readonly type: "space.reference_removed"; readonly itemId: string; readonly removedItemIds: readonly string[]; readonly spaceId: string };

export type SpaceFeature = {
  /** Startup deletion reconciliation must settle before the Host accepts requests. */
  ready(): Promise<void>;
  readonly commands: {
    createSpace(input: { readonly id?: string; readonly title: string }): Promise<Space>;
    /** Deletes the Space container and Space-owned assets; external sources remain untouched. */
    deleteSpace(spaceId: string): Promise<void>;
    addReference(input: { readonly id?: string; readonly spaceId: string; readonly title: string; readonly parentId?: string; readonly reference: SpaceAddableReference; readonly annotation?: SpaceReferenceAnnotationInput; readonly actor: SpaceReferenceActorRecord }): Promise<SpaceReferenceItem>;
    /** Refreshes the captured platform identity after Synech atomically replaces an external source file. */
    refreshReferenceSourceIdentity(itemId: string): Promise<SpaceReferenceItem>;
    /** Updates the annotation content of one reference with optimistic concurrency; revision advances on success. */
    updateReferenceAnnotation(input: { readonly itemId: string; readonly expectedRevision: number; readonly patch: SpaceReferenceAnnotationPatch; readonly actor: SpaceReferenceActorRecord }): Promise<SpaceReferenceItem>;
    /** Updates one image caption without mutating the referenced image file. */
    updateReferenceImageCaption(input: { readonly itemId: string; readonly relativePath: string; readonly expectedRevision: number; readonly text: string; readonly actor: SpaceReferenceActorRecord }): Promise<SpaceReferenceItem>;
    rename(input: { readonly target: SpaceTarget; readonly title: string }): Promise<SpaceTarget>;
    move(input: { readonly target: SpaceMovableTarget; readonly destinationSpaceId: string }): Promise<SpaceMovableTarget>;
    /** Removes only an external/metadata link and never deletes an external source. Conversation owners use the coordinator command. */
    unlinkReference(itemId: string): Promise<void>;
    /** Removes a Space-owned material and its source content through the durable deletion lifecycle. */
    removeReference(itemId: string): Promise<void>;
  };
  readonly queries: {
    list(): Promise<readonly SpaceSummary[]>;
    getTree(spaceId: string): Promise<SpaceTree | undefined>;
    getReference(itemId: string): Promise<SpaceReferenceItem | undefined>;
    listReferencesByWorkspace(workspaceId: string): Promise<readonly SpaceReferenceItem[]>;
  };
  readonly events: { subscribe(listener: (event: SpaceEvent) => void): () => void };
  /** Stops admission, drains accepted commands, and leaves no formal deletion journal on success. */
  release(): Promise<void>;
};
