import type {
  SpaceFeature,
  SpaceReferenceActorRecord,
  SpaceReferenceAnnotationPatch,
  SpaceReferenceItem,
} from "../spaces/index.js";
import type { SpaceAdmission } from "../ownership/admission.js";
import { sameResolvedSource, type ResolvedSource } from "../local-filesystem/resolved-source.js";
import {
  SpaceReferenceContentApplicationError,
  type SpaceReferenceContentApplicationErrorCode,
} from "../space-reference-contracts/application-error.js";
import type {
  SpaceReferenceCaptionUpdate,
  SpaceReferenceContentApplicationPort,
  SpaceReferenceTextUpdate,
} from "../space-reference-contracts/application-port.js";

export {
  SpaceReferenceContentApplicationError,
  type SpaceReferenceContentApplicationErrorCode,
} from "../space-reference-contracts/application-error.js";

/** The resolved source facts that are valid for one filesystem mutation. */
export type SpaceReferenceContentResolution = ResolvedSource<"local_file" | "workspace" | "managed_folder"> & {
  readonly item: SpaceReferenceItem;
};

export type SpaceReferenceContentApplicationOperations<TPreview> = {
  readonly updateText: (
    item: SpaceReferenceItem,
    input: SpaceReferenceTextUpdate,
    resolved?: SpaceReferenceContentResolution,
  ) => Promise<TPreview>;
  readonly updateCaption: (
    item: SpaceReferenceItem,
    input: SpaceReferenceCaptionUpdate,
    actor: SpaceReferenceActorRecord,
    resolved?: SpaceReferenceContentResolution,
  ) => Promise<TPreview>;
  readonly createEntry: (
    item: SpaceReferenceItem,
    input: {
      readonly parentRelativePath: string;
      readonly name: string;
      readonly kind: "file" | "directory";
    },
    resolved?: SpaceReferenceContentResolution,
  ) => Promise<{ readonly relativePath: string }>;
  readonly renameEntry: (
    item: SpaceReferenceItem,
    input: { readonly relativePath: string; readonly name: string },
    resolved?: SpaceReferenceContentResolution,
  ) => Promise<{ readonly relativePath: string }>;
  readonly deleteEntry: (
    item: SpaceReferenceItem,
    relativePath: string,
    resolved?: SpaceReferenceContentResolution,
  ) => Promise<void>;
  readonly updateAnnotation: (
    item: SpaceReferenceItem,
    expectedRevision: number,
    patch: SpaceReferenceAnnotationPatch,
    actor: SpaceReferenceActorRecord,
  ) => Promise<SpaceReferenceItem>;
};

export type SpaceReferenceContentApplication<TPreview = unknown> = SpaceReferenceContentApplicationPort<
  TPreview,
  SpaceReferenceItem,
  SpaceReferenceActorRecord,
  SpaceReferenceAnnotationPatch
>;

export type SpaceReferenceContentApplicationDependencies<TPreview> = {
  readonly spaceFeature: {
    readonly commands: Pick<SpaceFeature["commands"], "refreshReferenceSourceIdentity">;
    readonly queries: Pick<SpaceFeature["queries"], "getReference">;
  };
  readonly spaceAdmission: SpaceAdmission;
  readonly fileMutationCoordinator: {
    run<T>(key: string, operation: () => Promise<T>): Promise<T>;
  };
  /** Resolves and validates a current local/workspace/managed-folder source. */
  readonly resolveFilesystemReference: (
    item: SpaceReferenceItem,
  ) => Promise<SpaceReferenceContentResolution>;
  readonly operations: SpaceReferenceContentApplicationOperations<TPreview>;
};

/**
 * Canonical content-facing application for Space references.
 *
 * It owns the shared admission/re-read/source-validation workflow. Concrete
 * filesystem and owner-specific operations are injected so this layer does
 * not depend on Panel HTTP adapters or duplicate their path policy.
 */
export function createSpaceReferenceContentApplication<TPreview>(
  runtime: SpaceReferenceContentApplicationDependencies<TPreview>,
): SpaceReferenceContentApplication<TPreview> {
  return {
    updateText: async ({ itemId, update }) =>
      await runReferenceMutation(runtime, itemId, async (item, resolved) => {
        const result = await runtime.operations.updateText(item, update, resolved);
        if (item.reference.kind === "local_file") {
          await runtime.spaceFeature.commands.refreshReferenceSourceIdentity(itemId);
        }
        return result;
      }),
    updateCaption: async ({ itemId, update, actor }) =>
      await runReferenceMutation(runtime, itemId, (item, resolved) =>
        runtime.operations.updateCaption(item, update, actor, resolved)),
    createEntry: async ({ itemId, parentRelativePath, name, kind }) =>
      await runReferenceMutation(runtime, itemId, (item, resolved) =>
        runtime.operations.createEntry(item, { parentRelativePath, name, kind }, resolved)),
    renameEntry: async ({ itemId, relativePath, name }) =>
      await runReferenceMutation(runtime, itemId, (item, resolved) =>
        runtime.operations.renameEntry(item, { relativePath, name }, resolved)),
    deleteEntry: async ({ itemId, relativePath }) =>
      await runReferenceMutation(runtime, itemId, (item, resolved) =>
        runtime.operations.deleteEntry(item, relativePath, resolved)),
    updateAnnotation: async ({ itemId, expectedRevision, patch, actor }) =>
      await runReferenceMetadataMutation(runtime, itemId, (item) =>
        runtime.operations.updateAnnotation(item, expectedRevision, patch, actor)),
  };
}

async function runReferenceMutation<TPreview, T>(
  runtime: SpaceReferenceContentApplicationDependencies<TPreview>,
  itemId: string,
  operation: (item: SpaceReferenceItem, resolved?: SpaceReferenceContentResolution) => Promise<T>,
): Promise<T> {
  const initial = await getReference(runtime, itemId);
  runtime.spaceAdmission.assertAvailable(initial.spaceId);

  return await runtime.spaceAdmission.admit(initial.spaceId, async () => {
    const initialResolution = await resolveIfFilesystem(runtime, initial);
    if (initialResolution === undefined) {
      const current = await getCurrentReference(runtime, initial);
      return await operation(current);
    }

    return await runtime.fileMutationCoordinator.run(initialResolution.path, async () => {
      const current = await getCurrentReference(runtime, initial);
      const currentResolution = await resolveIfFilesystem(runtime, current);
      if (currentResolution === undefined || !sameResolvedSource(initialResolution, currentResolution)) {
        throw new SpaceReferenceContentApplicationError(
          "space_reference_source_changed",
          `Space reference ${itemId} source changed while waiting for its mutation lease.`,
        );
      }
      return await operation(current, currentResolution);
    });
  });
}

async function runReferenceMetadataMutation<TPreview, T>(
  runtime: SpaceReferenceContentApplicationDependencies<TPreview>,
  itemId: string,
  operation: (item: SpaceReferenceItem) => Promise<T>,
): Promise<T> {
  const initial = await getReference(runtime, itemId);
  runtime.spaceAdmission.assertAvailable(initial.spaceId);
  return await runtime.spaceAdmission.admit(initial.spaceId, async () =>
    await operation(await getCurrentReference(runtime, initial)));
}

async function getReference(
  runtime: SpaceReferenceContentApplicationDependencies<unknown>,
  itemId: string,
): Promise<SpaceReferenceItem> {
  const item = await runtime.spaceFeature.queries.getReference(itemId);
  if (item === undefined) {
    throw new SpaceReferenceContentApplicationError(
      "space_reference_not_found",
      `Space reference ${itemId} was not found.`,
    );
  }
  return item;
}

async function getCurrentReference(
  runtime: SpaceReferenceContentApplicationDependencies<unknown>,
  initial: SpaceReferenceItem,
): Promise<SpaceReferenceItem> {
  const current = await runtime.spaceFeature.queries.getReference(initial.id);
  if (current === undefined) {
    throw new SpaceReferenceContentApplicationError(
      "space_reference_revoked",
      `Space reference ${initial.id} was removed while waiting for its mutation lease.`,
    );
  }
  if (current.spaceId !== initial.spaceId) {
    throw new SpaceReferenceContentApplicationError(
      "space_reference_membership_changed",
      `Space reference ${initial.id} changed Space membership while waiting for its mutation lease.`,
    );
  }
  if (initial.reference.kind === "managed_asset" && (
    current.reference.kind !== "managed_asset" ||
    current.reference.assetId !== initial.reference.assetId
  )) {
    throw new SpaceReferenceContentApplicationError(
      "space_reference_source_changed",
      `Managed asset reference ${initial.id} changed source while waiting for its owner admission.`,
    );
  }
  return current;
}

async function resolveIfFilesystem(
  runtime: SpaceReferenceContentApplicationDependencies<unknown>,
  item: SpaceReferenceItem,
): Promise<SpaceReferenceContentResolution | undefined> {
  return item.reference.kind === "local_file"
    || item.reference.kind === "workspace"
    || item.reference.kind === "managed_folder"
    ? await runtime.resolveFilesystemReference(item)
    : undefined;
}
