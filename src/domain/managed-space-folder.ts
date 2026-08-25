/** Narrow shared port used by HTTP and Agent adapters for one managed-folder write. */
export type ManagedSpaceFolderActor = {
  readonly kind: "agent" | "user";
  readonly actorId?: string;
  readonly traceId?: string;
  readonly goalId?: string;
  readonly toolCallId?: string;
};

export type ManagedSpaceFolderApplication<TItem = unknown> = {
  create(input: {
    readonly spaceId: string;
    readonly title: string;
    readonly actor: ManagedSpaceFolderActor;
  }): Promise<TItem>;
};
