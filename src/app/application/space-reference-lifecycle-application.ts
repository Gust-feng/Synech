import {
  SpaceFeatureError,
  type SpaceFeature,
  type SpaceReferenceActorRecord,
  type SpaceReferenceAnnotationInput,
  type SpaceReferenceItem,
  type SpaceAddableReference,
  type SpaceTarget,
} from "../spaces/index.js";
import { withOrderedSpaceAdmissions, type SpaceAdmission } from "../ownership/admission.js";

export type SpaceReferenceLifecycleApplication = {
  addReference(input: { readonly spaceId: string; readonly title: string; readonly reference: Exclude<SpaceAddableReference, { readonly kind: "workspace" }>; readonly actor: SpaceReferenceActorRecord; readonly annotation?: SpaceReferenceAnnotationInput }): Promise<SpaceReferenceItem>;
  move(input: { readonly sourceSpaceId: string; readonly target: { readonly kind: "reference"; readonly id: string }; readonly destinationSpaceId: string }): Promise<void>;
  rename(input: { readonly target: SpaceTarget; readonly title: string }): Promise<SpaceTarget | undefined>;
  remove(input: { readonly itemId: string }): Promise<void>;
  unlink(input: { readonly itemId: string }): Promise<void>;
};

export type SpaceReferenceLifecycleApplicationDependencies = {
  readonly spaceFeature: Pick<SpaceFeature, "commands" | "queries">;
  readonly spaceAdmission: SpaceAdmission;
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
        ...(input.annotation === undefined ? {} : { annotation: input.annotation }),
      })),
    move: async (input) => await withOrderedSpaceAdmissions(runtime.spaceAdmission, [input.sourceSpaceId, input.destinationSpaceId], async () => {
      const tree = await runtime.spaceFeature.queries.getTree(input.sourceSpaceId);
      if (tree === undefined || !tree.entries.some((entry) => entry.item.id === input.target.id)) {
        throw new SpaceFeatureError("space_invalid_move", "The reference does not belong to the source Space or cannot be moved.");
      }
      await runtime.spaceFeature.commands.move({ target: input.target, destinationSpaceId: input.destinationSpaceId });
    }),
    rename: async (input) => {
      if (input.target.kind === "space") {
        return await runtime.spaceAdmission.admit(input.target.id, async () =>
          await runtime.spaceFeature.commands.rename({ target: input.target, title: input.title }));
      }
      return await withReferenceAdmission(runtime, input.target.id, (current) =>
        runtime.spaceFeature.commands.rename({ target: { kind: "reference", id: current.id }, title: input.title }), "throw");
    },
    remove: async ({ itemId }) => {
      await withReferenceAdmission(runtime, itemId, (current) => runtime.spaceFeature.commands.removeReference(current.id));
    },
    unlink: async ({ itemId }) => await runtime.unlinkExternalReference(itemId),
  };
}

async function withReferenceAdmission<T>(
  runtime: SpaceReferenceLifecycleApplicationDependencies,
  itemId: string,
  operation: (item: SpaceReferenceItem) => Promise<T>,
  missing: "return" | "throw" = "return",
): Promise<T | undefined> {
  const initial = await runtime.spaceFeature.queries.getReference(itemId);
  if (initial === undefined) {
    if (missing === "throw") throw new SpaceFeatureError("space_reference_not_found", `Space reference ${itemId} was not found.`);
    return undefined;
  }
  return await runtime.spaceAdmission.admit(initial.spaceId, async () => {
    const current = await runtime.spaceFeature.queries.getReference(itemId);
    if (current === undefined) {
      if (missing === "throw") throw new SpaceFeatureError("space_reference_not_found", `Space reference ${itemId} was removed while waiting for its admission.`);
      return undefined;
    }
    if (current.spaceId !== initial.spaceId) {
      throw new SpaceFeatureError(
        "space_reference_membership_changed",
        `Space reference ${itemId} changed Space membership while waiting for its admission.`,
      );
    }
    return await operation(current);
  });
}
