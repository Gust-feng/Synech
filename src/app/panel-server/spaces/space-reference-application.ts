import type { SpaceFeature } from "../../spaces/index.js";
import type { SpaceReferenceItem } from "../../spaces/index.js";
import type { SpaceConversationDeletionCoordinator } from "./space-conversation-coordinator.js";
import type { LocalWorkspaceMutationCoordinator } from "../../tool-center/adapters/local-workspace-mutation-coordinator.js";
import { createManagedSpaceFolder, deleteManagedSpaceFolder } from "./space-managed-folder-store.js";

/** Application command for the managed-folder creation workflow.
 *
 * The folder is physical state owned by the host while its membership is
 * owned by SpaceFeature. Keeping allocation, membership write, and
 * compensation together prevents an HTTP route from becoming a two-resource
 * transaction coordinator.
 */
export type ManagedSpaceFolderApplication = {
  create(input: { readonly spaceId: string; readonly title: string }): Promise<SpaceReferenceItem>;
};

export type ManagedSpaceFolderApplicationDependencies = {
  readonly spaceFeature: {
    readonly commands: Pick<SpaceFeature["commands"], "addReference">;
  };
  readonly spaceConversationDeletion: Pick<SpaceConversationDeletionCoordinator, "assertAvailable" | "admit">;
  readonly fileMutationCoordinator: Pick<LocalWorkspaceMutationCoordinator, "run">;
  readonly managedSpaceFolderRoot: string;
};

export function createManagedSpaceFolderApplication(
  runtime: ManagedSpaceFolderApplicationDependencies,
): ManagedSpaceFolderApplication {
  return {
    create: async ({ spaceId, title }) => {
      runtime.spaceConversationDeletion.assertAvailable(spaceId);
      return runtime.spaceConversationDeletion.admit(spaceId, async () =>
        await runtime.fileMutationCoordinator.run(runtime.managedSpaceFolderRoot, async () => {
          const folder = await createManagedSpaceFolder(runtime.managedSpaceFolderRoot);
          try {
            return await runtime.spaceFeature.commands.addReference({
              spaceId,
              title,
              reference: { kind: "managed_folder", path: folder },
              actor: { kind: "user" },
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
