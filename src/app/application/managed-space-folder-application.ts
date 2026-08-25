import type {
  ManagedSpaceFolderActor,
  ManagedSpaceFolderApplication,
} from "../../domain/managed-space-folder.js";
import { createManagedSpaceFolder, deleteManagedSpaceFolder } from "./managed-space-folder-store.js";

export type ManagedSpaceFolderApplicationDependencies<TItem> = {
  readonly addReference: (input: {
    readonly spaceId: string;
    readonly title: string;
    readonly reference: { readonly kind: "managed_folder"; readonly path: string };
    readonly actor: ManagedSpaceFolderActor;
  }) => Promise<TItem>;
  readonly spaceConversationDeletion: {
    assertAvailable(spaceId: string): void;
    admit<T>(spaceId: string, operation: () => Promise<T>): Promise<T>;
  };
  readonly fileMutationCoordinator: {
    run<T>(key: string, operation: () => Promise<T>): Promise<T>;
  };
  readonly managedSpaceFolderRoot: string;
};

export function createManagedSpaceFolderApplication<TItem>(
  runtime: ManagedSpaceFolderApplicationDependencies<TItem>,
): ManagedSpaceFolderApplication<TItem> {
  return {
    create: async ({ spaceId, title, actor }) => {
      runtime.spaceConversationDeletion.assertAvailable(spaceId);
      return runtime.spaceConversationDeletion.admit(spaceId, async () =>
        await runtime.fileMutationCoordinator.run(runtime.managedSpaceFolderRoot, async () => {
          const folder = await createManagedSpaceFolder(runtime.managedSpaceFolderRoot);
          try {
            return await runtime.addReference({
              spaceId,
              title,
              reference: { kind: "managed_folder", path: folder },
              actor,
            });
          } catch (error) {
            try {
              await deleteManagedSpaceFolder(runtime.managedSpaceFolderRoot, folder);
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                "Managed Space folder membership failed and physical compensation could not be confirmed.",
              );
            }
            throw error;
          }
        }));
    },
  };
}
