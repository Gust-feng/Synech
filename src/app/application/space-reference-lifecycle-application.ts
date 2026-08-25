import type { SpaceFeature, SpaceReferenceActorRecord, SpaceReferenceItem, SpaceTarget } from "../spaces/index.js";

export type SpaceReferenceLifecycleApplication = {
  addReference(input: { readonly spaceId: string; readonly title: string; readonly reference: Parameters<SpaceFeature["commands"]["addReference"]>[0]["reference"]; readonly actor: SpaceReferenceActorRecord }): Promise<SpaceReferenceItem>;
  move(input: { readonly sourceSpaceId: string; readonly target: { readonly kind: "reference"; readonly id: string }; readonly destinationSpaceId: string }): Promise<void>;
  rename(input: { readonly target: SpaceTarget; readonly title: string }): Promise<SpaceTarget | undefined>;
  remove(input: { readonly itemId: string }): Promise<void>;
  unlink(input: { readonly itemId: string }): Promise<void>;
};

export type SpaceReferenceLifecycleApplicationDependencies = {
  readonly spaceFeature: Pick<SpaceFeature, "commands" | "queries">;
  readonly spaceAdmission: { admit<T>(spaceId: string, operation: () => Promise<T>): Promise<T> };
  readonly unlinkExternalReference: (itemId: string) => Promise<void>;
};

export function createSpaceReferenceLifecycleApplication(
  runtime: SpaceReferenceLifecycleApplicationDependencies,
): SpaceReferenceLifecycleApplication {
  return {
    addReference: async (input) => await runtime.spaceAdmission.admit(input.spaceId, async () =>
      await runtime.spaceFeature.commands.addReference({
        spaceId: input.spaceId,
        title: input.title,
        reference: input.reference,
        actor: input.actor,
      })),
    move: async (input) => await withAdmissions(runtime, [input.sourceSpaceId, input.destinationSpaceId], async () => {
      const tree = await runtime.spaceFeature.queries.getTree(input.sourceSpaceId);
      if (tree === undefined || !tree.entries.some((entry) => entry.item.id === input.target.id)) {
        throw new Error("space_invalid_move");
      }
      await runtime.spaceFeature.commands.move({ target: input.target, destinationSpaceId: input.destinationSpaceId });
    }),
    rename: async (input) => {
      const spaceId = input.target.kind === "space"
        ? input.target.id
        : (await runtime.spaceFeature.queries.getReference(input.target.id))?.spaceId;
      if (spaceId === undefined) return undefined;
      return await runtime.spaceAdmission.admit(spaceId, async () =>
        await runtime.spaceFeature.commands.rename({ target: input.target, title: input.title }));
    },
    remove: async ({ itemId }) => {
      const item = await runtime.spaceFeature.queries.getReference(itemId);
      if (item === undefined) return;
      await runtime.spaceAdmission.admit(item.spaceId, async () => await runtime.spaceFeature.commands.removeReference(itemId));
    },
    unlink: async ({ itemId }) => await runtime.unlinkExternalReference(itemId),
  };
}

async function withAdmissions<T>(
  runtime: SpaceReferenceLifecycleApplicationDependencies,
  spaceIds: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(spaceIds)].sort();
  const admit = async (index: number): Promise<T> => {
    const spaceId = ordered[index];
    if (spaceId === undefined) return await operation();
    return await runtime.spaceAdmission.admit(spaceId, async () => await admit(index + 1));
  };
  return await admit(0);
}
