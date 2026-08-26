import type { DocumentCaptionUpdateInput, DocumentPreview, DocumentTextUpdateInput } from "../panel-api/workbench.js";
import type {
  SpaceFeature,
  SpaceReferenceActorRecord,
  SpaceReferenceAnnotationPatch,
  SpaceReferenceItem,
} from "../spaces/index.js";
import type { SpaceAdmission } from "../ownership/admission.js";
import { sameResolvedSource, type ResolvedSource } from "../local-filesystem/resolved-source.js";

/** The resolved source facts that are valid for one filesystem mutation. */
export type SpaceReferenceContentResolution = ResolvedSource<"local_file" | "workspace" | "managed_folder"> & {
  readonly item: SpaceReferenceItem;
};

export type SpaceReferenceContentApplicationErrorCode =
  | "space_reference_not_found"
  | "space_reference_revoked"
  | "space_reference_membership_changed"
  | "space_reference_source_changed"
  | "space_reference_caption_unavailable"
  | "space_reference_image_caption_revision_conflict"
  | "space_reference_content_unavailable"
  | "space_reference_source_missing"
  | "space_reference_source_replaced"
  | "space_reference_entry_exists"
  | "space_reference_entry_mutation_unavailable"
  | "space_reference_mutation_failed"
  | "invalid_space_reference_path"
  | "invalid_space_reference_name"
  | "workspace_not_available";

/**
 * Structured failures owned by the application boundary.
 * Adapters map these facts to HTTP, Agent or another transport protocol.
 */
export class SpaceReferenceContentApplicationError extends Error {
  readonly name = "SpaceReferenceContentApplicationError";

  constructor(
    readonly code: SpaceReferenceContentApplicationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type SpaceReferenceContentApplicationOperations = {
  readonly updateText: (
    item: SpaceReferenceItem,
    input: DocumentTextUpdateInput,
    resolved?: SpaceReferenceContentResolution,
  ) => Promise<DocumentPreview>;
  readonly updateCaption: (
    item: SpaceReferenceItem,
    input: DocumentCaptionUpdateInput,
    actor: SpaceReferenceActorRecord,
    resolved?: SpaceReferenceContentResolution,
  ) => Promise<DocumentPreview>;
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

export type SpaceReferenceContentApplication = {
  updateText(input: {
    readonly itemId: string;
    readonly update: DocumentTextUpdateInput;
  }): Promise<DocumentPreview>;
  updateCaption(input: {
    readonly itemId: string;
    readonly update: DocumentCaptionUpdateInput;
    readonly actor: SpaceReferenceActorRecord;
  }): Promise<DocumentPreview>;
  createEntry(input: {
    readonly itemId: string;
    readonly parentRelativePath: string;
    readonly name: string;
    readonly kind: "file" | "directory";
  }): Promise<{ readonly relativePath: string }>;
  renameEntry(input: {
    readonly itemId: string;
    readonly relativePath: string;
    readonly name: string;
  }): Promise<{ readonly relativePath: string }>;
  deleteEntry(input: {
    readonly itemId: string;
    readonly relativePath: string;
  }): Promise<void>;
  updateAnnotation(input: {
    readonly itemId: string;
    readonly expectedRevision: number;
    readonly patch: SpaceReferenceAnnotationPatch;
    readonly actor: SpaceReferenceActorRecord;
  }): Promise<SpaceReferenceItem>;
};

export type SpaceReferenceContentApplicationDependencies = {
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
  readonly operations: SpaceReferenceContentApplicationOperations;
};

/**
 * Canonical content-facing application for Space references.
 *
 * It owns the shared admission/re-read/source-validation workflow. Concrete
 * filesystem and owner-specific operations are injected so this layer does
 * not depend on Panel HTTP adapters or duplicate their path policy.
 */
export function createSpaceReferenceContentApplication(
  runtime: SpaceReferenceContentApplicationDependencies,
): SpaceReferenceContentApplication {
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

async function runReferenceMutation<T>(
  runtime: SpaceReferenceContentApplicationDependencies,
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

async function runReferenceMetadataMutation<T>(
  runtime: SpaceReferenceContentApplicationDependencies,
  itemId: string,
  operation: (item: SpaceReferenceItem) => Promise<T>,
): Promise<T> {
  const initial = await getReference(runtime, itemId);
  runtime.spaceAdmission.assertAvailable(initial.spaceId);
  return await runtime.spaceAdmission.admit(initial.spaceId, async () =>
    await operation(await getCurrentReference(runtime, initial)));
}

async function getReference(
  runtime: SpaceReferenceContentApplicationDependencies,
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
  runtime: SpaceReferenceContentApplicationDependencies,
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
  return current;
}

async function resolveIfFilesystem(
  runtime: SpaceReferenceContentApplicationDependencies,
  item: SpaceReferenceItem,
): Promise<SpaceReferenceContentResolution | undefined> {
  return item.reference.kind === "local_file"
    || item.reference.kind === "workspace"
    || item.reference.kind === "managed_folder"
    ? await runtime.resolveFilesystemReference(item)
    : undefined;
}
