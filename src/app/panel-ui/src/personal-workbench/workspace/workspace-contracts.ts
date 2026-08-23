export type PersonalWorkspaceProjection = {
  readonly workspaceId: string;
  readonly title: string;
  readonly status: "available" | "disconnected" | "deleting";
  readonly rootPath?: string;
  readonly linkCount: number;
};

export type PersonalWorkspaceActions = {
  readonly addWorkspace?: () => Promise<void>;
  readonly refresh?: () => Promise<void>;
};
