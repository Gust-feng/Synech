export type PanelSpaceReference =
  | { readonly kind: "local_file"; readonly path: string }
  | { readonly kind: "workspace_folder"; readonly path: string }
  | { readonly kind: "managed_folder"; readonly path: string }
  | { readonly kind: "asset_folder" }
  | { readonly kind: "managed_asset"; readonly assetId: string }
  | { readonly kind: "web_page"; readonly url: string }
  | { readonly kind: "generated_artifact"; readonly artifactRef: string };

export type PanelSpaceReferenceAnnotation = {
  readonly markdown: string;
  readonly keyPoints?: readonly string[];
  readonly tags?: readonly string[];
  readonly revision: number;
  readonly updatedAt: string;
  readonly updatedBy: "agent" | "user";
  readonly actor: {
    readonly kind: "agent" | "user";
    readonly actorId?: string;
    readonly traceId?: string;
    readonly goalId?: string;
    readonly toolCallId?: string;
  };
};

export type PanelSpaceReferenceItem = {
  readonly id: string;
  readonly spaceId: string;
  readonly title: string;
  readonly parentId?: string;
  readonly reference: PanelSpaceReference;
  readonly sourceIdentity?: string;
  readonly annotation?: PanelSpaceReferenceAnnotation;
  readonly imageCaptions?: Readonly<Record<string, {
    readonly text: string;
    readonly revision: number;
    readonly updatedAt: string;
    readonly updatedBy: "agent" | "user";
    readonly actor: PanelSpaceReferenceAnnotation["actor"];
  }>>;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type PanelSpace = {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type PanelSpaceTreeEntry = {
  readonly kind: "reference";
  readonly item: PanelSpaceReferenceItem;
};

export type PanelSpaceTree = {
  readonly space: PanelSpace;
  readonly entries: readonly PanelSpaceTreeEntry[];
};

export type PanelSpaceSummary = PanelSpace & {
  readonly folderCount: number;
  readonly referenceItemCount: number;
};

export type SpaceReference = PanelSpaceReference;
export type SpaceReferenceAnnotation = PanelSpaceReferenceAnnotation;
export type SpaceReferenceItem = PanelSpaceReferenceItem;
export type SpaceTreeEntry = PanelSpaceTreeEntry;
export type SpaceTree = PanelSpaceTree;
export type SpaceSummary = PanelSpaceSummary;
