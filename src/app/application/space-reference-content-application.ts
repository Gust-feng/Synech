import path from "node:path";

import type { DocumentCaptionUpdateInput, DocumentPreview, DocumentTextUpdateInput } from "../panel-api/workbench.js";
import type { SpaceFeature, SpaceReferenceItem } from "../spaces/index.js";

/** The resolved source facts that are valid for one filesystem mutation. */
export type SpaceReferenceContentResolution = {
  readonly item: SpaceReferenceItem;
  readonly path: string;
  readonly sourceKind: "local_file" | "workspace" | "managed_folder";
  readonly sourceIdentity?: string;
  readonly mountVersion?: string;
};

export type SpaceReferenceContentApplicationErrorCode =
  | "space_reference_not_found"
  | "space_reference_revoked"
  | "space_reference_membership_changed"
  | "space_reference_source_changed";

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
};

export type SpaceReferenceContentApplication = {
  updateText(input: {
    readonly itemId: string;
    readonly update: DocumentTextUpdateInput;
  }): Promise<DocumentPreview>;
  updateCaption(input: {
    readonly itemId: string;
    readonly update: DocumentCaptionUpdateInput;
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
};

export type SpaceReferenceContentApplicationDependencies = {
  readonly spaceFeature: {
    readonly commands: Pick<SpaceFeature["commands"], "refreshReferenceSourceIdentity">;
    readonly queries: Pick<SpaceFeature["queries"], "getReference">;
  };
  readonly spaceAdmission: {
    assertAvailable(spaceId: string): void;
    admit<T>(spaceId: string, operation: () => Promise<T>): Promise<T>;
  };
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
    updateCaption: async ({ itemId, update }) =>
      await runReferenceMutation(runtime, itemId, (item, resolved) =>
        runtime.operations.updateCaption(item, update, resolved)),
    createEntry: async ({ itemId, parentRelativePath, name, kind }) =>
      await runReferenceMutation(runtime, itemId, (item, resolved) =>
        runtime.operations.createEntry(item, { parentRelativePath, name, kind }, resolved)),
    renameEntry: async ({ itemId, relativePath, name }) =>
      await runReferenceMutation(runtime, itemId, (item, resolved) =>
        runtime.operations.renameEntry(item, { relativePath, name }, resolved)),
    deleteEntry: async ({ itemId, relativePath }) =>
      await runReferenceMutation(runtime, itemId, (item, resolved) =>
        runtime.operations.deleteEntry(item, relativePath, resolved)),
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

function sameResolvedSource(
  left: SpaceReferenceContentResolution,
  right: SpaceReferenceContentResolution,
): boolean {
  const leftPath = path.resolve(left.path);
  const rightPath = path.resolve(right.path);
  const samePath = process.platform === "win32"
    ? leftPath.toLocaleLowerCase("en-US") === rightPath.toLocaleLowerCase("en-US")
    : leftPath === rightPath;
  return samePath
    && left.sourceKind === right.sourceKind
    && left.sourceIdentity === right.sourceIdentity
    && left.mountVersion === right.mountVersion;
}
