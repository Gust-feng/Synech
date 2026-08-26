export type SpaceReferenceTextUpdate = {
  readonly relativePath?: string;
  readonly expectedFingerprint: string;
  readonly text: string;
};

export type SpaceReferenceCaptionUpdate = {
  readonly relativePath?: string;
  readonly expectedFingerprint: string;
  readonly caption: string;
};

export type SpaceReferenceContentApplicationPort<TPreview, TItem, TActor, TAnnotationPatch> = {
  updateText(input: {
    readonly itemId: string;
    readonly update: SpaceReferenceTextUpdate;
  }): Promise<TPreview>;
  updateCaption(input: {
    readonly itemId: string;
    readonly update: SpaceReferenceCaptionUpdate;
    readonly actor: TActor;
  }): Promise<TPreview>;
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
    readonly patch: TAnnotationPatch;
    readonly actor: TActor;
  }): Promise<TItem>;
};

export type SpaceReferenceLifecycleApplicationPort<TReference, TItem, TTarget, TActor, TAnnotation> = {
  addReference(input: {
    readonly spaceId: string;
    readonly title: string;
    readonly reference: TReference;
    readonly actor: TActor;
    readonly annotation?: TAnnotation;
  }): Promise<TItem>;
  move(input: {
    readonly sourceSpaceId: string;
    readonly target: { readonly kind: "reference"; readonly id: string };
    readonly destinationSpaceId: string;
  }): Promise<void>;
  rename(input: { readonly target: TTarget; readonly title: string }): Promise<TTarget | undefined>;
  remove(input: { readonly itemId: string }): Promise<void>;
  unlink(input: { readonly itemId: string }): Promise<void>;
};
