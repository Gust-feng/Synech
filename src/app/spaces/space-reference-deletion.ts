import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { isWithinRoot } from "../local-filesystem/index.js";
import {
  SpaceFeatureError,
  type SpaceReferenceItem,
  type SpaceRepository,
  type SpaceTreeSnapshot,
} from "./contracts.js";
import type {
  SpaceReferenceDeletionJournalRecord,
  SpaceReferenceDeletionJournalStore,
  SpaceReferenceDeletionTarget,
} from "./file-system-reference-deletion-journal.js";

export type SpaceReferenceDeletionTargetState = {
  readonly sourceExists: boolean;
  readonly stagedExists: boolean;
};

export interface SpaceReferenceDeletionFilePort {
  prepare(input: {
    readonly item: SpaceReferenceItem;
    readonly deletionId: string;
    readonly targetIndex: number;
  }): Promise<SpaceReferenceDeletionTarget | undefined>;
  inspect(target: SpaceReferenceDeletionTarget): Promise<SpaceReferenceDeletionTargetState>;
  stage(target: SpaceReferenceDeletionTarget): Promise<void>;
  restore(target: SpaceReferenceDeletionTarget): Promise<void>;
  removeStaged(target: SpaceReferenceDeletionTarget): Promise<void>;
}

export interface SpaceReferenceDeletionLeasePort {
  run<T>(absolutePath: string, operation: () => Promise<T>): Promise<T>;
  runExclusive<T>(absolutePath: string, operation: () => Promise<T>): Promise<T>;
}

export type SpaceReferenceDeletionDiagnostic = {
  readonly kind: "committed_cleanup_failed";
  readonly deletionId: string;
  readonly error: unknown;
};

export type SpaceReferenceDeletionLifecycle = {
  recover(): Promise<void>;
  remove(input: {
    readonly rootReferenceId: string;
    readonly removedReferences: readonly SpaceReferenceItem[];
    readonly ownedAssetIds?: readonly string[];
    readonly nextSnapshot: SpaceTreeSnapshot;
    readonly createdAt: string;
  }): Promise<void>;
};

export function createSpaceReferenceDeletionLifecycle(input: {
  readonly repository: SpaceRepository;
  readonly journal: SpaceReferenceDeletionJournalStore;
  readonly files: SpaceReferenceDeletionFilePort;
  readonly leases: SpaceReferenceDeletionLeasePort;
  readonly createDeletionId?: () => string;
  readonly onDiagnostic?: (diagnostic: SpaceReferenceDeletionDiagnostic) => void;
  readonly deleteOwnedAssets?: (assetIds: readonly string[]) => Promise<void>;
}): SpaceReferenceDeletionLifecycle {
  const createDeletionId = input.createDeletionId ?? (() => crypto.randomUUID());

  return {
    async recover() {
      for (const record of await input.journal.list()) {
        await withDeletionLeases(input.leases, input.journal.mutationKey, record.targets, async () => {
          await recoverDeletion(input, record);
        });
      }
    },

    async remove(command) {
      const deletionId = createDeletionId();
      const ownedItems = ownedDeletionItems(command.removedReferences);
      await withSourceLeases(
        input.leases,
        input.journal.mutationKey,
        ownedItems.map((item) => sourcePath(item)),
        async () => {
          const targets: SpaceReferenceDeletionTarget[] = [];
          for (const item of ownedItems) {
            const target = await input.files.prepare({ item, deletionId, targetIndex: targets.length });
            if (target !== undefined) targets.push(target);
          }
          const prepared: SpaceReferenceDeletionJournalRecord = {
            schemaVersion: "space-reference-deletion/v1",
            deletionId,
            phase: "prepared",
            rootReferenceId: command.rootReferenceId,
            removedReferences: command.removedReferences,
            ...(command.ownedAssetIds === undefined ? {} : { ownedAssetIds: command.ownedAssetIds }),
            targets,
            createdAt: command.createdAt,
          };
          await input.journal.save(prepared);
          try {
            for (const target of targets) {
              await input.files.stage(target);
            }
            await input.journal.save({ ...prepared, phase: "files_staged" });
          } catch (error) {
            await rollbackUncommittedDeletion(input, prepared, error);
          }

          try {
            await input.repository.write(command.nextSnapshot);
          } catch (error) {
            await rollbackUncommittedDeletion(input, prepared, error);
          }

          const committed = { ...prepared, phase: "metadata_committed" as const };
          const cleanupFailures: unknown[] = [];
          try {
            await input.journal.save(committed);
          } catch (error) { cleanupFailures.push(error); }
          try {
            await finalizeCommittedDeletion(input, committed);
          } catch (error) { cleanupFailures.push(error); }
          if (cleanupFailures.length > 0) {
            const failure = cleanupFailures.length === 1
              ? cleanupFailures[0]
              : new AggregateError(cleanupFailures, `Committed Space deletion ${deletionId} cleanup did not converge.`);
            publishDiagnostic(input.onDiagnostic, { kind: "committed_cleanup_failed", deletionId, error: failure });
            throw new SpaceFeatureError("space_deletion_journal_failure", `Committed Space deletion ${deletionId} cleanup did not converge; recovery will retry it.`, { cause: failure });
          }
        },
      );
    },
  };
}

async function recoverDeletion(
  input: {
    readonly repository: SpaceRepository;
    readonly journal: SpaceReferenceDeletionJournalStore;
    readonly files: SpaceReferenceDeletionFilePort;
    readonly deleteOwnedAssets?: (assetIds: readonly string[]) => Promise<void>;
  },
  record: SpaceReferenceDeletionJournalRecord,
): Promise<void> {
  const snapshot = await input.repository.read();
  const currentById = new Map(snapshot.referenceItems.map((item) => [item.id, item] as const));
  const present = record.removedReferences.flatMap((expected) => {
    const current = currentById.get(expected.id);
    return current === undefined ? [] : [{ expected, current }];
  });
  if (present.length !== 0 && present.length !== record.removedReferences.length) {
    throw recoveryError(record.deletionId, "Space metadata contains only part of the journaled reference subtree.");
  }
  if (present.some(({ expected, current }) => !isDeepStrictEqual(expected, current))) {
    throw recoveryError(record.deletionId, "Space metadata identity differs from the journaled reference subtree.");
  }

  if (present.length === 0) {
    await finalizeCommittedDeletion(input, record);
    return;
  }

  const restore: SpaceReferenceDeletionTarget[] = [];
  for (const target of record.targets) {
    const state = await input.files.inspect(target);
    if (state.sourceExists && !state.stagedExists) continue;
    if (!state.sourceExists && state.stagedExists) {
      restore.push(target);
      continue;
    }
    throw recoveryError(
      record.deletionId,
      state.sourceExists
        ? `Source and staged paths both exist for reference ${target.referenceId}.`
        : `Source and staged paths are both missing for reference ${target.referenceId}.`,
    );
  }
  for (const target of restore.reverse()) await input.files.restore(target);
  await input.journal.delete(record.deletionId);
}

async function rollbackUncommittedDeletion(
  input: {
    readonly journal: SpaceReferenceDeletionJournalStore;
    readonly files: SpaceReferenceDeletionFilePort;
    readonly deleteOwnedAssets?: (assetIds: readonly string[]) => Promise<void>;
  },
  record: SpaceReferenceDeletionJournalRecord,
  cause: unknown,
): Promise<never> {
  const failures: unknown[] = [];
  for (const target of [...record.targets].reverse()) {
    try {
      const state = await input.files.inspect(target);
      if (!state.sourceExists && state.stagedExists) {
        await input.files.restore(target);
      } else if (!state.sourceExists || state.stagedExists) {
        throw recoveryError(
          record.deletionId,
          `Rollback found an ambiguous source/staged pair for reference ${target.referenceId}.`,
        );
      }
    } catch (error) { failures.push(error); }
  }
  if (failures.length === 0) {
    try { await input.journal.delete(record.deletionId); }
    catch (error) { failures.push(error); }
  }
  if (failures.length > 0) {
    throw new SpaceFeatureError(
      "space_deletion_recovery_failed",
      `Space deletion ${record.deletionId} failed and rollback did not converge; the journal was retained for recovery.`,
      { cause: new AggregateError([cause, ...failures], "Space reference deletion rollback did not converge.") },
    );
  }
  throw cause;
}

async function finalizeCommittedDeletion(
  input: {
    readonly journal: SpaceReferenceDeletionJournalStore;
    readonly files: SpaceReferenceDeletionFilePort;
    readonly deleteOwnedAssets?: (assetIds: readonly string[]) => Promise<void>;
  },
  record: SpaceReferenceDeletionJournalRecord,
): Promise<void> {
  const failures: unknown[] = [];
  for (const target of record.targets) {
    try {
      const state = await input.files.inspect(target);
      if (state.stagedExists) await input.files.removeStaged(target);
    } catch (error) {
      failures.push(error);
    }
  }
  const ownedAssetIds = record.ownedAssetIds ?? [];
  if (ownedAssetIds.length > 0) {
    try {
      if (input.deleteOwnedAssets === undefined) throw new Error("Synech asset deletion is unavailable during Space deletion recovery.");
      await input.deleteOwnedAssets(ownedAssetIds);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Committed Space deletion ${record.deletionId} cleanup failed.`);
  }
  await input.journal.delete(record.deletionId);
}

function ownedDeletionItems(items: readonly SpaceReferenceItem[]): readonly SpaceReferenceItem[] {
  const candidates = items.filter((item) =>
    item.reference.kind === "managed_folder"
  ).sort((left, right) => sourcePath(left).length - sourcePath(right).length || sourcePath(left).localeCompare(sourcePath(right)));
  const roots: SpaceReferenceItem[] = [];
  for (const candidate of candidates) {
    const candidatePath = sourcePath(candidate);
    if (roots.some((root) => sourcePath(root) === candidatePath ||
      (root.reference.kind === "managed_folder" && isWithinRoot(sourcePath(root), candidatePath)))) continue;
    roots.push(candidate);
  }
  return roots.sort((left, right) => mutationPath(sourcePath(left)).localeCompare(mutationPath(sourcePath(right))));
}

function sourcePath(item: SpaceReferenceItem): string {
  if (item.reference.kind !== "managed_folder" && item.reference.kind !== "local_file") {
    throw new SpaceFeatureError("space_deletion_recovery_failed", `Reference ${item.id} has no owned source path.`);
  }
  return path.resolve(item.reference.path);
}

async function withDeletionLeases<T>(
  leases: SpaceReferenceDeletionLeasePort,
  journalMutationKey: string,
  targets: readonly SpaceReferenceDeletionTarget[],
  operation: () => Promise<T>,
): Promise<T> {
  return withSourceLeases(leases, journalMutationKey, targets.map((target) => target.sourcePath), operation);
}

async function withSourceLeases<T>(
  leases: SpaceReferenceDeletionLeasePort,
  journalMutationKey: string,
  sourcePaths: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(sourcePaths.map(mutationPath))].sort();
  return leases.runExclusive(journalMutationKey, async () => await withLeaseKeys(leases, keys, operation));
}

async function withLeaseKeys<T>(
  leases: SpaceReferenceDeletionLeasePort,
  keys: readonly string[],
  operation: () => Promise<T>,
  index = 0,
): Promise<T> {
  const key = keys[index];
  return key === undefined
    ? await operation()
    : await leases.run(key, async () => await withLeaseKeys(leases, keys, operation, index + 1));
}

function mutationPath(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function recoveryError(deletionId: string, message: string): SpaceFeatureError {
  return new SpaceFeatureError(
    "space_deletion_recovery_failed",
    `Space deletion ${deletionId} cannot be recovered safely: ${message}`,
  );
}

function publishDiagnostic(
  listener: ((diagnostic: SpaceReferenceDeletionDiagnostic) => void) | undefined,
  diagnostic: SpaceReferenceDeletionDiagnostic,
): void {
  try { listener?.(diagnostic); }
  catch { /* Diagnostics cannot rewrite an already committed deletion. */ }
}