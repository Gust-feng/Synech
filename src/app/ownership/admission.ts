/** Space owner admission used by relationship and file mutations. */
export type SpaceAdmission = {
  readonly assertAvailable: (spaceId: string) => void;
  readonly admit: <T>(spaceId: string, operation: () => Promise<T>) => Promise<T>;
};

/** Workspace owner admission used by mount and deletion workflows. */
export type WorkspaceAdmission = {
  readonly assertAvailable: (workspaceId: string) => void;
  readonly admit: <T>(workspaceId: string, operation: () => Promise<T>) => Promise<T>;
};

/** Acquires multiple Space admissions in stable order. */
export async function withOrderedSpaceAdmissions<T>(
  admission: Pick<SpaceAdmission, "admit">,
  spaceIds: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(spaceIds)].sort();
  const admit = async (index: number): Promise<T> => {
    const spaceId = ordered[index];
    if (spaceId === undefined) return await operation();
    return await admission.admit(spaceId, async () => await admit(index + 1));
  };
  return await admit(0);
}
