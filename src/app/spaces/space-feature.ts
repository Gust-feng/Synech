import {
  SPACE_TREE_SCHEMA_VERSION,
  SpaceFeatureError,
  type Space,
  type SpaceEvent,
  type SpaceFeature,
  type SpaceReference,
  type SpaceReferenceActorRecord,
  type SpaceReferenceAnnotation,
  type SpaceReferenceAnnotationInput,
  type SpaceReferenceAnnotationPatch,
  type SpaceReferenceImageCaption,
  type SpaceReferenceItem,
  type SpaceRepository,
  type SpaceOwnedAssetDeletionPort,
  type SpaceTarget,
  type SpaceTreeSnapshot,
} from "./contracts.js";
import { validateSpaceReference, validateSpaceReferenceAnnotation, validateSpaceReferenceImageCaption } from "./space-validation.js";
import {
  createSpaceReferenceDeletionLifecycle,
  type SpaceReferenceDeletionDiagnostic,
  type SpaceReferenceDeletionFilePort,
  type SpaceReferenceDeletionLeasePort,
} from "./space-reference-deletion.js";
import type { SpaceReferenceDeletionJournalStore } from "./file-system-reference-deletion-journal.js";
import type { SpaceExternalSourceInspector } from "./space-external-source.js";

export type CreateSpaceFeatureInput = {
  readonly repository: SpaceRepository;
  readonly now?: () => string;
  readonly idFactory?: () => string;
  readonly workspaceMountIdentity?: (workspacePath: string) => Promise<string>;
  readonly externalSourceInspector?: SpaceExternalSourceInspector;
  readonly ownedAssetDeletion?: SpaceOwnedAssetDeletionPort;
  readonly referenceDeletion?: {
    readonly journal: SpaceReferenceDeletionJournalStore;
    readonly files: SpaceReferenceDeletionFilePort;
    readonly leases: SpaceReferenceDeletionLeasePort;
    readonly createDeletionId?: () => string;
    readonly onDiagnostic?: (diagnostic: SpaceReferenceDeletionDiagnostic) => void;
    readonly deleteOwnedAssets?: (assetIds: readonly string[]) => Promise<void>;
  };
};

export function createSpaceFeature(input: CreateSpaceFeatureInput): SpaceFeature {
  const now = input.now ?? (() => new Date().toISOString());
  const createId = input.idFactory ?? (() => crypto.randomUUID());
  const listeners = new Set<(event: SpaceEvent) => void>();
  let released = false;
  let runtimeFailure: unknown;
  let releasePromise: Promise<void> | undefined;
  let startupSucceeded = false;
  let tail = Promise.resolve();
  let startup: Promise<void> | undefined;
  const serialize = <T>(operation: () => Promise<T>, waitForStartup = true): Promise<T> => {
    const guarded = async () => {
      if (waitForStartup) {
        await startup;
        if (runtimeFailure !== undefined) throw runtimeFailure;
      }
      return operation();
    };
    const result = tail.then(guarded, guarded);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const assertUsable = (action: string) => {
    if (released) throw new SpaceFeatureError("space_feature_released", `Space feature is released and cannot ${action}`);
  };
  const publish = (event: SpaceEvent) => {
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* Observers cannot roll back an already committed Space command. */ }
    }
  };
  const deletionLifecycle = input.referenceDeletion === undefined
    ? undefined
    : createSpaceReferenceDeletionLifecycle({
        repository: input.repository,
        ...input.referenceDeletion,
        deleteOwnedAssets: input.referenceDeletion.deleteOwnedAssets ?? input.ownedAssetDeletion?.deleteManagedAssets,
      });
  const ready = deletionLifecycle === undefined
    ? Promise.resolve()
    : serialize(() => deletionLifecycle.recover(), false);
  void ready.then(() => { startupSucceeded = true; }, () => undefined);
  startup = ready;
  const waitUntilUsable = async (): Promise<void> => {
    await ready;
    if (runtimeFailure !== undefined) throw runtimeFailure;
  };
  const removeReferenceWithPolicy = (
    itemId: string,
    runOwnershipLifecycle: boolean,
  ): Promise<void> => {
    assertUsable(runOwnershipLifecycle ? "remove a reference" : "unlink a reference");
    return serialize(async () => {
      const snapshot = await input.repository.read();
      const item = requireReference(snapshot, itemId);
      if (runOwnershipLifecycle && !isSpaceOwnedMaterial(item.reference)) {
        throw new SpaceFeatureError(
          "space_invalid_input",
          "External references are links only; unlink them instead of deleting their source.",
        );
      }
      if (!runOwnershipLifecycle && !isExternalReference(item.reference)) {
        throw new SpaceFeatureError(
          "space_invalid_input",
          "Space-owned materials must be removed through their deletion workflow.",
        );
      }
      const at = now();
      const subtree = referenceSubtreeIds(snapshot, itemId);
      const removedItems = snapshot.referenceItems.filter((entry) => subtree.has(entry.id));
      const ownedAssetIds = runOwnershipLifecycle ? managedAssetIds(removedItems) : [];
      if (ownedAssetIds.length > 0 && input.ownedAssetDeletion === undefined) {
        throw new SpaceFeatureError(
          "space_deletion_journal_failure",
          `Reference ${itemId} owns Synech assets but no asset deletion port is configured.`,
        );
      }
      const nextSnapshot = {
        ...snapshot,
        referenceItems: snapshot.referenceItems.filter((entry) => !subtree.has(entry.id)),
        spaces: touchSpaces(snapshot.spaces, [item.spaceId], at),
      };
      if (runOwnershipLifecycle && deletionLifecycle !== undefined) {
        try {
          await deletionLifecycle.remove({
            rootReferenceId: itemId,
            removedReferences: removedItems,
            ownedAssetIds,
            nextSnapshot,
            createdAt: at,
          });
        } catch (error) {
          if (error instanceof SpaceFeatureError && error.code === "space_deletion_recovery_failed") {
            runtimeFailure ??= error;
          }
          throw error;
        }
      } else {
        await input.repository.write(nextSnapshot);
      }
      if (ownedAssetIds.length > 0 && deletionLifecycle === undefined) {
        try {
          await input.ownedAssetDeletion!.deleteManagedAssets(ownedAssetIds);
        } catch (error) {
          const failure = new SpaceFeatureError(
            "space_deletion_journal_failure",
            `Reference ${itemId} metadata was removed but Synech asset deletion did not complete.`,
            { cause: error },
          );
          runtimeFailure ??= failure;
          throw failure;
        }
      }
      publish({
        type: "space.reference_removed",
        itemId,
        removedItemIds: removedItems.map((entry) => entry.id),
        spaceId: item.spaceId,
      });
    });
  };
  const newId = (snapshot: SpaceTreeSnapshot): string => {
    const id = createId().trim();
    if (id.length === 0) throw new SpaceFeatureError("space_invalid_input", "Space ids must not be empty");
    const taken = new Set([...snapshot.spaces.map((entry) => entry.id), ...snapshot.referenceItems.map((entry) => entry.id)]);
    if (taken.has(id)) throw new SpaceFeatureError("space_id_collision", `Space id ${id} already exists`);
    return id;
  };

  return {
    ready: waitUntilUsable,
    commands: {
      createSpace({ id, title }) {
        assertUsable("create a Space");
        return serialize(async () => {
          const snapshot = await input.repository.read();
          const at = now();
          const space: Space = {
            id: id === undefined ? newId(snapshot) : idFor(id, snapshot),
            title: titleFor(title),
            createdAt: at,
            updatedAt: at,
          };
          await input.repository.write({ ...snapshot, spaces: [...snapshot.spaces, space] });
          publish({ type: "space.created", space });
          return space;
        });
      },
      deleteSpace(spaceId) {
        assertUsable("delete a Space");
        return serialize(async () => {
          const snapshot = await input.repository.read();
          requireSpace(snapshot, spaceId);
          const removedReferenceIds = snapshot.referenceItems
            .filter((item) => item.spaceId === spaceId)
            .map((item) => item.id);
          const nextSnapshot = {
            ...snapshot,
            spaces: snapshot.spaces.filter((space) => space.id !== spaceId),
            referenceItems: snapshot.referenceItems.filter((item) => item.spaceId !== spaceId),
          };
          const ownedAssetIds = managedAssetIds(removedReferenceItems(snapshot, spaceId));
          if (ownedAssetIds.length > 0 && input.ownedAssetDeletion === undefined) {
            throw new SpaceFeatureError(
              "space_deletion_journal_failure",
              `Space ${spaceId} owns Synech assets but no asset deletion port is configured.`,
            );
          }
          // Space-owned managed folders are physical assets. External files and
          // workspace folders are links only and are intentionally excluded.
          const ownedReferences = snapshot.referenceItems.filter((item) =>
            item.spaceId === spaceId && item.reference.kind === "managed_folder",
          );
          if (deletionLifecycle !== undefined && (ownedReferences.length > 0 || ownedAssetIds.length > 0)) {
            try {
              const journalRoot = snapshot.referenceItems.find((item) => item.spaceId === spaceId);
              if (journalRoot === undefined) throw new SpaceFeatureError("space_deletion_journal_failure", `Space ${spaceId} has no reference root for deletion journal.`);
              await deletionLifecycle.remove({
                rootReferenceId: journalRoot.id,
                removedReferences: snapshot.referenceItems.filter((item) => item.spaceId === spaceId),
                ownedAssetIds,
                nextSnapshot,
                createdAt: now(),
              });
            } catch (error) {
              if (error instanceof SpaceFeatureError && error.code === "space_deletion_recovery_failed") {
                runtimeFailure ??= error;
              }
              throw error;
            }
          } else {
            await input.repository.write(nextSnapshot);
          }
          if (ownedAssetIds.length > 0 && deletionLifecycle === undefined) {
            try {
              await input.ownedAssetDeletion!.deleteManagedAssets(ownedAssetIds);
            } catch (error) {
              const failure = new SpaceFeatureError(
                "space_deletion_journal_failure",
                `Space ${spaceId} metadata was removed but Synech asset deletion did not complete.`,
                { cause: error },
              );
              runtimeFailure ??= failure;
              throw failure;
            }
          }
          publish({ type: "space.deleted", spaceId, removedReferenceIds });
        });
      },
      addReference({ id, spaceId, title, parentId, reference, annotation, actor }) {
        assertUsable("add a reference");
        return serialize(async () => {
          const snapshot = await input.repository.read();
          requireSpace(snapshot, spaceId);
          if (parentId !== undefined) requireParent(snapshot, spaceId, parentId);
          assertManagedAssetUnique(snapshot, reference);
          await assertExternalPathUnique(snapshot, spaceId, reference, input.workspaceMountIdentity);
          const validatedReference = validateSpaceReference(reference);
          const sourceIdentity = await captureExternalSourceIdentity(validatedReference, input.externalSourceInspector);
          const at = now();
          const item: SpaceReferenceItem = {
            id: id === undefined ? newId(snapshot) : idFor(id, snapshot),
            spaceId,
            title: titleFor(title),
            ...(parentId === undefined ? {} : { parentId }),
            reference: validatedReference,
            ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
            ...(annotation === undefined ? {} : { annotation: initialAnnotation(annotation, at, actor) }),
            createdAt: at,
            updatedAt: at,
          };
          await input.repository.write({
            ...snapshot,
            referenceItems: [item, ...snapshot.referenceItems],
            spaces: touchSpaces(snapshot.spaces, [spaceId], at),
          });
          publish({ type: "space.reference_added", item });
          return item;
        });
      },
      updateReferenceAnnotation({ itemId, expectedRevision, patch, actor }) {
        assertUsable("update a reference annotation");
        return serialize(async () => {
          const snapshot = await input.repository.read();
          const current = requireReference(snapshot, itemId);
          const revision = current.annotation?.revision ?? 0;
          if (revision !== expectedRevision) {
            throw new SpaceFeatureError(
              "space_reference_annotation_revision_conflict",
              `Space reference ${itemId} annotation revision is ${revision}, expected ${expectedRevision}`,
            );
          }
          const at = now();
          const annotation = updatedAnnotation(current.annotation, patch, at, actor);
          const item: SpaceReferenceItem = { ...current, annotation, updatedAt: at };
          await input.repository.write({
            ...snapshot,
            referenceItems: snapshot.referenceItems.map((entry) => entry.id === itemId ? item : entry),
            spaces: touchSpaces(snapshot.spaces, [current.spaceId], at),
          });
          publish({ type: "space.reference_annotation_updated", item });
          return item;
        });
      },
      updateReferenceImageCaption({ itemId, relativePath, expectedRevision, text, actor }) {
        assertUsable("update a reference image caption");
        return serialize(async () => {
          if (relativePath.length > 4_096) {
            throw new SpaceFeatureError("space_reference_image_caption_invalid", "Space reference image caption path is too long.");
          }
          const snapshot = await input.repository.read();
          const current = requireReference(snapshot, itemId);
          if (current.reference.kind !== "local_file"
            && current.reference.kind !== "workspace_folder"
            && current.reference.kind !== "managed_folder") {
            throw new SpaceFeatureError("space_reference_image_caption_invalid", `Space reference ${itemId} cannot own image captions.`);
          }
          if (current.reference.kind === "local_file" && relativePath.length > 0) {
            throw new SpaceFeatureError("space_reference_image_caption_invalid", "A local file image caption must use the root path.");
          }
          const currentCaption = current.imageCaptions?.[relativePath];
          const revision = currentCaption?.revision ?? 0;
          if (revision !== expectedRevision) {
            throw new SpaceFeatureError(
              "space_reference_image_caption_revision_conflict",
              `Space reference ${itemId} image caption revision is ${revision}, expected ${expectedRevision}`,
            );
          }
          const at = now();
          const caption = updatedImageCaption(currentCaption, text, at, actor);
          const item: SpaceReferenceItem = {
            ...current,
            imageCaptions: { ...current.imageCaptions, [relativePath]: caption },
            updatedAt: at,
          };
          await input.repository.write({
            ...snapshot,
            referenceItems: snapshot.referenceItems.map((entry) => entry.id === itemId ? item : entry),
            spaces: touchSpaces(snapshot.spaces, [current.spaceId], at),
          });
          publish({ type: "space.reference_image_caption_updated", item, relativePath });
          return item;
        });
      },
      rename({ target, title }) {
        assertUsable("rename a Space entry");
        return serialize(async () => {
          const snapshot = await input.repository.read();
          const at = now();
          const updated = renameSnapshot(snapshot, target, titleFor(title), at);
          await input.repository.write(updated);
          const spaceId = target.kind === "space" ? target.id : requireReference(snapshot, target.id).spaceId;
          publish({ type: "space.renamed", target, spaceId });
          return target;
        });
      },
      move({ target, destinationSpaceId }) {
        assertUsable("move a Space reference");
        return serialize(async () => {
          const snapshot = await input.repository.read();
          requireSpace(snapshot, destinationSpaceId);
          const item = requireReference(snapshot, target.id);
          assertMovableReference(item.reference);
          const at = now();
          const subtree = referenceSubtreeIds(snapshot, item.id);
          const moved = snapshot.referenceItems.filter((entry) => subtree.has(entry.id)).map((entry) => ({
            ...entry,
            spaceId: destinationSpaceId,
            ...(entry.id === item.id ? { parentId: undefined } : {}),
            updatedAt: at,
          }));
          for (const entry of moved) assertMovableReference(entry.reference);
          const retained = snapshot.referenceItems.filter((entry) => !subtree.has(entry.id));
          let mountValidationItems = retained;
          for (const entry of moved) {
            assertManagedAssetUnique({ ...snapshot, referenceItems: mountValidationItems }, entry.reference);
            await assertExternalPathUnique(
              { ...snapshot, referenceItems: mountValidationItems },
              destinationSpaceId,
              entry.reference,
              input.workspaceMountIdentity,
            );
            mountValidationItems = [...mountValidationItems, entry];
          }
          await input.repository.write({
            ...snapshot,
            referenceItems: [...moved, ...retained],
            spaces: touchSpaces(snapshot.spaces, [item.spaceId, destinationSpaceId], at),
          });
          publish({ type: "space.moved", target, sourceSpaceId: item.spaceId, destinationSpaceId });
          return target;
        });
      },
      unlinkReference: (itemId) => removeReferenceWithPolicy(itemId, false),
      removeReference: (itemId) => removeReferenceWithPolicy(itemId, true),
    },
    queries: {
      async list() {
        assertUsable("list Spaces");
        await waitUntilUsable();
        const snapshot = await input.repository.read();
        return snapshot.spaces.map((space) => ({
          ...space,
          folderCount: snapshot.referenceItems.filter((item) => item.spaceId === space.id && (item.reference.kind === "workspace_folder" || item.reference.kind === "managed_folder" || item.reference.kind === "asset_folder")).length,
          referenceItemCount: snapshot.referenceItems.filter((item) => item.spaceId === space.id).length,
        }));
      },
      async getTree(spaceId) {
        assertUsable("read a Space");
        await waitUntilUsable();
        const snapshot = await input.repository.read();
        const space = snapshot.spaces.find((entry) => entry.id === spaceId);
        if (space === undefined) return undefined;
        const entries = snapshot.referenceItems.filter((item) => item.spaceId === spaceId)
          .map((item) => ({ kind: "reference" as const, item }));
        return { space, entries };
      },
      async getReference(itemId) {
        assertUsable("read a reference");
        await waitUntilUsable();
        return (await input.repository.read()).referenceItems.find((entry) => entry.id === itemId);
      },
    },
    events: {
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    },
    async release() {
      if (releasePromise !== undefined) return await releasePromise;
      released = true;
      const attempt = (async () => {
        await ready.catch(() => undefined);
        await tail;
        listeners.clear();
        if (startupSucceeded) await deletionLifecycle?.recover();
      })();
      releasePromise = attempt;
      try {
        await attempt;
      } catch (error) {
        releasePromise = undefined;
        throw error;
      }
    },
  };
}

function titleFor(value: string): string {
  const title = value.trim();
  if (title.length === 0 || title.length > 160) throw new SpaceFeatureError("space_invalid_input", "Space titles must contain 1 to 160 characters");
  return title;
}
function idFor(value: string, snapshot: SpaceTreeSnapshot): string {
  const id = value.trim();
  if (id.length === 0) throw new SpaceFeatureError("space_invalid_input", "Space ids must not be empty");
  const taken = new Set([...snapshot.spaces.map((entry) => entry.id), ...snapshot.referenceItems.map((entry) => entry.id)]);
  if (taken.has(id)) throw new SpaceFeatureError("space_id_collision", `Space id ${id} already exists`);
  return id;
}
function requireSpace(snapshot: SpaceTreeSnapshot, id: string): Space {
  const space = snapshot.spaces.find((entry) => entry.id === id);
  if (space === undefined) throw new SpaceFeatureError("space_not_found", `Space ${id} was not found`);
  return space;
}
function requireReference(snapshot: SpaceTreeSnapshot, id: string): SpaceReferenceItem {
  const item = snapshot.referenceItems.find((entry) => entry.id === id);
  if (item === undefined) throw new SpaceFeatureError("space_reference_not_found", `Space reference ${id} was not found`);
  return item;
}
function requireParent(snapshot: SpaceTreeSnapshot, spaceId: string, id: string): SpaceReferenceItem {
  const parent = requireReference(snapshot, id);
  if (parent.spaceId !== spaceId) throw new SpaceFeatureError("space_invalid_input", "Space reference parent must belong to the same Space");
  if (parent.reference.kind !== "asset_folder") {
    throw new SpaceFeatureError("space_invalid_input", "Only an internal asset folder can contain Space entries");
  }
  return parent;
}
function referenceSubtreeIds(snapshot: SpaceTreeSnapshot, rootId: string): Set<string> {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of snapshot.referenceItems) {
      if (item.parentId !== undefined && ids.has(item.parentId) && !ids.has(item.id)) {
        ids.add(item.id);
        changed = true;
      }
    }
  }
  return ids;
}
function renameSnapshot(snapshot: SpaceTreeSnapshot, target: SpaceTarget, title: string, at: string): SpaceTreeSnapshot {
  if (target.kind === "space") {
    requireSpace(snapshot, target.id);
    return { ...snapshot, spaces: snapshot.spaces.map((space) => space.id === target.id ? { ...space, title, updatedAt: at } : space) };
  }
  const item = requireReference(snapshot, target.id);
  return {
    ...snapshot,
    referenceItems: snapshot.referenceItems.map((entry) => entry.id === item.id ? { ...entry, title, updatedAt: at } : entry),
    spaces: touchSpaces(snapshot.spaces, [item.spaceId], at),
  };
}
function touchSpaces(spaces: readonly Space[], ids: readonly string[], at: string): readonly Space[] {
  const targets = new Set(ids);
  return spaces.map((space) => targets.has(space.id) ? { ...space, updatedAt: at } : space);
}

function removedReferenceItems(snapshot: SpaceTreeSnapshot, spaceId: string): readonly SpaceReferenceItem[] {
  return snapshot.referenceItems.filter((item) => item.spaceId === spaceId);
}

function managedAssetIds(items: readonly SpaceReferenceItem[]): readonly string[] {
  return [...new Set(items.flatMap((item) =>
    item.reference.kind === "managed_asset" ? [item.reference.assetId] : [],
  ))];
}

function assertMovableReference(reference: SpaceReferenceItem["reference"]): void {
  if (reference.kind === "local_file" || reference.kind === "workspace_folder") {
    throw new SpaceFeatureError(
      "space_invalid_move",
      `${reference.kind} is an external link and cannot be moved between Spaces.`,
    );
  }
}

function isExternalReference(reference: SpaceReferenceItem["reference"]): boolean {
  return reference.kind === "local_file"
    || reference.kind === "workspace_folder"
    || reference.kind === "web_page"
    || reference.kind === "generated_artifact";
}

function isSpaceOwnedMaterial(reference: SpaceReferenceItem["reference"]): boolean {
  return reference.kind === "managed_folder"
    || reference.kind === "asset_folder"
    || reference.kind === "managed_asset";
}

function assertManagedAssetUnique(
  snapshot: SpaceTreeSnapshot,
  reference: SpaceReferenceItem["reference"],
): void {
  if (reference.kind !== "managed_asset") return;
  const existing = snapshot.referenceItems.find((item) =>
    item.reference.kind === "managed_asset" && item.reference.assetId === reference.assetId,
  );
  if (existing !== undefined) {
    throw new SpaceFeatureError(
      "space_asset_ownership_conflict",
      `Synech asset ${reference.assetId} is already owned by Space ${existing.spaceId}.`,
    );
  }
}

/**
 * External filesystem links are mutually exclusive within a Space: duplicate
 * paths and parent/child paths would otherwise produce ambiguous grants.
 * Separate Spaces intentionally do not enter this comparison.
 */
async function assertExternalPathUnique(
  snapshot: SpaceTreeSnapshot,
  spaceId: string,
  reference: SpaceReferenceItem["reference"],
  identify: CreateSpaceFeatureInput["workspaceMountIdentity"],
): Promise<void> {
  if (reference.kind !== "workspace_folder" && reference.kind !== "local_file") return;
  const identity = await workspaceMountIdentity(reference.path, identify);
  for (const item of snapshot.referenceItems) {
    if (item.spaceId !== spaceId) continue;
    if (item.reference.kind !== "workspace_folder" && item.reference.kind !== "local_file") continue;
    const existing = await workspaceMountIdentity(item.reference.path, identify);
    if (existing === identity) {
      throw new SpaceFeatureError("space_workspace_mount_conflict", "This filesystem path is already linked to this Space");
    }
    if (item.reference.kind === "workspace_folder" && isMountAncestor(existing, identity)) {
      throw new SpaceFeatureError("space_workspace_mount_conflict", "This filesystem path is inside another linked workspace folder in this Space");
    }
    if (reference.kind === "workspace_folder" && isMountAncestor(identity, existing)) {
      throw new SpaceFeatureError("space_workspace_mount_conflict", "Another linked filesystem path is inside this workspace folder in this Space");
    }
  }
}

/** 判断 `ancestor` 是否为 `candidate` 的严格祖先目录，按已规范化的挂载身份做段边界比较。 */
function isMountAncestor(ancestor: string, candidate: string): boolean {
  const prefix = ancestor.endsWith("/") ? ancestor : `${ancestor}/`;
  return candidate.length > prefix.length && candidate.startsWith(prefix);
}

async function workspaceMountIdentity(value: string, identify: CreateSpaceFeatureInput["workspaceMountIdentity"]): Promise<string> {
  if (identify !== undefined) return await identify(value);
  return value.trim().replaceAll("\\", "/").replace(/\/+$/u, "").toLocaleLowerCase("en-US");
}

async function captureExternalSourceIdentity(
  reference: SpaceReference,
  inspect: SpaceExternalSourceInspector | undefined,
): Promise<string | undefined> {
  if (inspect === undefined || (reference.kind !== "local_file" && reference.kind !== "workspace_folder")) {
    return undefined;
  }
  const source = await inspect(reference.path);
  const expectedKind = reference.kind === "local_file" ? "file" : "folder";
  if (source === undefined || source.kind !== expectedKind) {
    throw new SpaceFeatureError(
      "space_invalid_input",
      `The ${reference.kind === "local_file" ? "file" : "workspace folder"} source does not exist at ${reference.path}.`,
    );
  }
  return source.identity;
}

export function emptySpaceTreeSnapshot(): SpaceTreeSnapshot {
  return { schemaVersion: SPACE_TREE_SCHEMA_VERSION, spaces: [], referenceItems: [] };
}

/** 首次写入 annotation：revision 固定为 1，revision/时间/actor 由 SpaceFeature 生成。 */
function initialAnnotation(
  input: SpaceReferenceAnnotationInput,
  at: string,
  actor: SpaceReferenceActorRecord,
): SpaceReferenceAnnotation {
  return validateSpaceReferenceAnnotation({ ...input, revision: 1, updatedAt: at, updatedBy: actor.kind, actor });
}

/**
 * 基于当前事实应用内容 patch：
 * - 至少提供一个真正要更新的内容字段；
 * - 未提供的字段保持原值，不能无意清空；
 * - 更新成功后 revision 加一。
 */
function updatedAnnotation(
  current: SpaceReferenceAnnotation | undefined,
  patch: SpaceReferenceAnnotationPatch,
  at: string,
  actor: SpaceReferenceActorRecord,
): SpaceReferenceAnnotation {
  const hasMarkdown = patch.markdown !== undefined;
  const hasKeyPoints = patch.keyPoints !== undefined;
  const hasTags = patch.tags !== undefined;
  if (!hasMarkdown && !hasKeyPoints && !hasTags) {
    throw new SpaceFeatureError(
      "space_reference_annotation_invalid",
      "Space reference annotation update requires at least one content field.",
    );
  }
  const next: SpaceReferenceAnnotation = {
    markdown: hasMarkdown ? patch.markdown! : current?.markdown ?? "",
    ...(hasKeyPoints
      ? { keyPoints: patch.keyPoints! }
      : current?.keyPoints === undefined ? {} : { keyPoints: current.keyPoints }),
    ...(hasTags
      ? { tags: patch.tags! }
      : current?.tags === undefined ? {} : { tags: current.tags }),
    revision: (current?.revision ?? 0) + 1,
    updatedAt: at,
    updatedBy: actor.kind,
    actor,
  };
  return validateSpaceReferenceAnnotation(next);
}

function updatedImageCaption(
  current: SpaceReferenceImageCaption | undefined,
  text: string,
  at: string,
  actor: SpaceReferenceActorRecord,
): SpaceReferenceImageCaption {
  return validateSpaceReferenceImageCaption({
    text,
    revision: (current?.revision ?? 0) + 1,
    updatedAt: at,
    updatedBy: actor.kind,
    actor,
  });
}
