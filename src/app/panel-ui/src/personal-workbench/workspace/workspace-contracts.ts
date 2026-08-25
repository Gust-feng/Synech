export type PersonalWorkspaceProjection = {
  readonly workspaceId: string;
  readonly title: string;
  readonly status: "available" | "disconnected" | "deleting";
  readonly rootPath?: string;
};

export type PersonalWorkspaceActions = {
  readonly addWorkspace?: () => Promise<void>;
  readonly refresh?: () => Promise<void>;
  readonly reconnectWorkspace?: (workspaceId: string) => Promise<void>;
};
