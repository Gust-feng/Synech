import type {
  SpaceReferenceContentApplicationDependencies,
  SpaceReferenceContentApplicationOperations,
} from "../../application/space-reference-content-application.js";
import { SpaceReferenceContentApplicationError } from "../../application/space-reference-content-application.js";
import type { ManagedAssetsFeature } from "../../managed-assets/index.js";
import type { DocumentPreview } from "../../panel-api/workbench.js";
import { isSpaceReferenceContentApplicationErrorCode } from "../../space-reference-contracts/application-error.js";
import type { SpaceFeature } from "../../spaces/index.js";
import type { WorkspaceFeature } from "../../workspaces/index.js";
import { PanelHttpError } from "../http-utils.js";
import {
  updateManagedAssetCaptionPreview,
  updateManagedAssetTextPreview,
} from "../storage/managed-asset-routes.js";
import {
  createPanelSpaceReferenceEntry,
  deletePanelSpaceReferenceEntry,
  renamePanelSpaceReferenceEntry,
  updatePanelSpaceReferenceText,
} from "./space-reference-mutations.js";
import { createPanelDocumentPreview } from "./space-reference-preview.js";
import { resolveSpaceFilesystemReference } from "./space-workspace-reference.js";

export type PanelSpaceReferenceContentAdapter = Pick<
  SpaceReferenceContentApplicationDependencies<DocumentPreview>,
  "resolveFilesystemReference" | "operations"
>;

/** Panel-specific filesystem, preview and managed-asset operations for the neutral Application. */
export function createPanelSpaceReferenceContentAdapter(input: {
  readonly spaces: SpaceFeature;
  readonly workspaces: WorkspaceFeature;
  readonly managedAssets: ManagedAssetsFeature;
}): PanelSpaceReferenceContentAdapter {
  const operations: SpaceReferenceContentApplicationOperations<DocumentPreview> = {
    updateText: (item, update, resolved) => asSpaceReferenceContentOperation(async () => {
      if (item.reference.kind === "managed_asset") {
        if ((update.relativePath ?? "").length > 0) {
          throw new PanelHttpError(400, "invalid_managed_asset_input", "托管资产文本不接受子路径。");
        }
        return await updateManagedAssetTextPreview(
          input.managedAssets.commands,
          { assetId: item.reference.assetId, expectedFingerprint: update.expectedFingerprint, text: update.text },
          item.id,
        );
      }
      return await updatePanelSpaceReferenceText(item, update, undefined, resolved);
    }),
    updateCaption: (item, update, actor, resolved) => asSpaceReferenceContentOperation(async () => {
      const relativePath = update.relativePath ?? "";
      if (item.reference.kind === "managed_asset") {
        if (relativePath.length > 0) {
          throw new PanelHttpError(400, "invalid_managed_asset_input", "托管资产图片说明不接受子路径。");
        }
        return await updateManagedAssetCaptionPreview(
          input.managedAssets.commands,
          { assetId: item.reference.assetId, expectedFingerprint: update.expectedFingerprint, caption: update.caption },
          item.id,
        );
      }
      const current = await createPanelDocumentPreview(item, relativePath, undefined, undefined, resolved);
      if (current.content.kind !== "media" || current.content.mediaKind !== "image" || current.content.captionEditable !== true) {
        throw new SpaceReferenceContentApplicationError(
          "space_reference_caption_unavailable",
          "Only image references support editable captions.",
        );
      }
      const match = /^space-image-caption:(\d+)$/u.exec(update.expectedFingerprint);
      if (match === null) {
        throw new SpaceReferenceContentApplicationError(
          "space_reference_image_caption_revision_conflict",
          "The image caption revision changed while the mutation was waiting.",
        );
      }
      const updated = await input.spaces.commands.updateReferenceImageCaption({
        itemId: item.id,
        relativePath,
        expectedRevision: Number(match[1]),
        text: update.caption,
        actor,
      });
      return await createPanelDocumentPreview(updated, relativePath, undefined, undefined, resolved);
    }),
    createEntry: (item, entry, resolved) => asSpaceReferenceContentOperation(() =>
      createPanelSpaceReferenceEntry(item, entry, resolved)),
    renameEntry: (item, entry, resolved) => asSpaceReferenceContentOperation(() =>
      renamePanelSpaceReferenceEntry(item, entry, resolved)),
    deleteEntry: (item, relativePath, resolved) => asSpaceReferenceContentOperation(() =>
      deletePanelSpaceReferenceEntry(item, relativePath, resolved)),
    updateAnnotation: (item, expectedRevision, patch, actor) => input.spaces.commands.updateReferenceAnnotation({
      itemId: item.id,
      expectedRevision,
      patch,
      actor,
    }),
  };

  return {
    resolveFilesystemReference: (item) => asSpaceReferenceContentOperation(() =>
      resolveSpaceFilesystemReference({ workspaceFeature: input.workspaces }, item)),
    operations,
  };
}

async function asSpaceReferenceContentOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw panelSpaceReferenceContentOperationError(error);
  }
}

/** Converts only the Panel failures declared by the canonical Application contract. */
export function panelSpaceReferenceContentOperationError(error: unknown): unknown {
  return error instanceof PanelHttpError && isSpaceReferenceContentApplicationErrorCode(error.code)
    ? new SpaceReferenceContentApplicationError(error.code, error.message, { cause: error })
    : error;
}
