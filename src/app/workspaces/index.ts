export {
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceFeatureError,
  type RegisterWorkspaceInput,
  type ReconnectWorkspaceInput,
  type Workspace,
  type WorkspaceDetail,
  type WorkspaceEvent,
  type WorkspaceFeature,
  type WorkspaceFeatureErrorCode,
  type WorkspaceLink,
  type WorkspaceLinkStatus,
  type WorkspaceMount,
  type WorkspaceMountStatus,
  type WorkspaceRepository,
  type WorkspaceSnapshot,
  type WorkspaceStatus,
  type WorkspaceSummary,
} from "./contracts.js";
export { createSqliteWorkspaceRepository } from "./sqlite-repository.js";
export {
  assertWorkspacePathUniqueness,
  canonicalWorkspacePathIdentity,
  workspacePathNesting,
  type WorkspacePathNesting,
} from "./workspace-identity.js";
export { createWorkspaceFeature, type CreateWorkspaceFeatureInput } from "./workspace-feature.js";
