/**
 * WorkspaceFeature（ADR-0035 阶段二）。
 *
 * Workspace 是用户文件系统中的真实文件夹及其软件登记身份。WorkspaceFeature 拥有
 * Workspace 元数据、mount（mountVersion + sourceIdentity）、Space-Workspace link
 * （linkId）、唯一性校验和连接状态；不拥有 Conversation/Run、外部文件内容或 Space 树。
 *
 * 三层身份（ADR-0035 §4.1）：
 * - workspaceId：Workspace 的长期逻辑身份。
 * - mountVersion：某次真实目录绑定的版本，重新连接时生成新版本。
 * - linkId：某个 Space 对 Workspace 的一次引用关系，重新引用必须产生新 linkId。
 */

export const WORKSPACE_SCHEMA_VERSION = "workspaces/v1" as const;

export type WorkspaceStatus = "available" | "disconnected" | "deleting";

export type Workspace = {
  readonly id: string;
  readonly title: string;
  readonly status: WorkspaceStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type WorkspaceMountStatus = "active" | "invalidated";

export type WorkspaceMount = {
  readonly workspaceId: string;
  readonly mountVersion: string;
  readonly rootPath: string;
  readonly sourceIdentity: string;
  readonly status: WorkspaceMountStatus;
  readonly connectedAt: string;
  readonly invalidatedAt?: string;
};

export type WorkspaceLinkStatus = "active" | "revoked";

export type WorkspaceLink = {
  readonly linkId: string;
  readonly spaceId: string;
  readonly workspaceId: string;
  readonly mountVersion: string;
  readonly status: WorkspaceLinkStatus;
  readonly createdAt: string;
  readonly revokedAt?: string;
};

export type WorkspaceSnapshot = {
  readonly schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  readonly workspaces: readonly Workspace[];
  readonly mounts: readonly WorkspaceMount[];
  readonly links: readonly WorkspaceLink[];
};

export interface WorkspaceRepository {
  read(): Promise<WorkspaceSnapshot>;
  write(snapshot: WorkspaceSnapshot): Promise<void>;
}

export type WorkspaceSummary = Pick<Workspace, "id" | "title" | "status" | "createdAt" | "updatedAt"> & {
  /** 当前有效 mount；无有效 mount 时为 undefined（断连状态）。 */
  readonly currentMount?: WorkspaceMount;
  readonly linkCount: number;
};

export type WorkspaceDetail = Workspace & {
  readonly mounts: readonly WorkspaceMount[];
  readonly links: readonly WorkspaceLink[];
};

export type RegisterWorkspaceInput = {
  /** 系统文件夹选择器或等价 Host 接口获得的真实绝对路径；模型不能传入路径注册 Workspace。 */
  readonly rootPath: string;
  /** 首次捕获的文件系统来源身份（dev + inode）。 */
  readonly sourceIdentity: string;
  readonly title?: string;
};

export type ReconnectWorkspaceInput = {
  readonly workspaceId: string;
  /** 重新选择的目录路径；来源身份必须与当前 mount 一致（同一文件系统对象）。 */
  readonly rootPath: string;
  readonly sourceIdentity: string;
};

export type WorkspaceFeatureErrorCode =
  | "workspace_feature_released"
  | "workspace_not_found"
  | "workspace_duplicate_path"
  | "workspace_duplicate_identity"
  | "workspace_nested_path"
  | "workspace_mount_conflict"
  | "workspace_mount_invalid"
  | "workspace_not_available"
  | "workspace_not_deleting"
  | "workspace_link_not_found"
  | "workspace_link_conflict"
  | "workspace_invalid_input"
  | "workspace_snapshot_incompatible"
  | "workspace_repository_failure";

export class WorkspaceFeatureError extends Error {
  readonly name = "WorkspaceFeatureError";
  constructor(readonly code: WorkspaceFeatureErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export type WorkspaceEvent =
  | { readonly type: "workspace.registered"; readonly workspace: Workspace; readonly mount: WorkspaceMount }
  | { readonly type: "workspace.reconnected"; readonly workspaceId: string; readonly mount: WorkspaceMount }
  | { readonly type: "workspace.mount_invalidated"; readonly workspaceId: string; readonly mountVersion: string }
  | { readonly type: "workspace.link_created"; readonly link: WorkspaceLink }
  | { readonly type: "workspace.link_revoked"; readonly link: WorkspaceLink }
  | { readonly type: "workspace.deleted"; readonly workspaceId: string };

export type WorkspaceFeature = {
  /** 启动恢复完成后 Host 才能接受请求。 */
  ready(): Promise<void>;
  readonly commands: {
    registerWorkspace(input: RegisterWorkspaceInput): Promise<{ readonly workspace: Workspace; readonly mount: WorkspaceMount }>;
    /** 同一文件系统对象的重新连接；不同对象必须注册新 Workspace，不替换旧 mount。 */
    reconnectWorkspace(input: ReconnectWorkspaceInput): Promise<{ readonly workspace: Workspace; readonly mount: WorkspaceMount }>;
    /** 使当前 mount 失效并撤销所有依赖它的 Space link；返回被撤销的 linkId 列表供 Host 清理 Space 引用。 */
    invalidateMount(workspaceId: string, reason?: string): Promise<readonly string[]>;
    linkWorkspaceToSpace(input: { readonly spaceId: string; readonly workspaceId: string }): Promise<WorkspaceLink>;
    unlinkWorkspaceFromSpace(linkId: string): Promise<void>;
    /** 进入 deleting 并发布事件；跨 feature 级联由 Host coordinator 协调。 */
    deleteWorkspace(workspaceId: string): Promise<void>;
    /**
     * 物理移除 deleting Workspace 的软件侧登记（元数据、mount 与残留 link）。
     * 只能在 deleteWorkspace 之后执行；跨 feature 级联完成后由 Host coordinator 调用。
     */
    purgeWorkspace(workspaceId: string): Promise<void>;
  };
  readonly queries: {
    list(): Promise<readonly WorkspaceSummary[]>;
    get(workspaceId: string): Promise<WorkspaceDetail | undefined>;
    getLink(linkId: string): Promise<WorkspaceLink | undefined>;
    listLinksBySpace(spaceId: string): Promise<readonly WorkspaceLink[]>;
    /** 注册与重连前的唯一性预检；按规范化路径匹配。 */
    findByRootPath(rootPath: string): Promise<Workspace | undefined>;
  };
  readonly events: { subscribe(listener: (event: WorkspaceEvent) => void): () => void };
  release(): Promise<void>;
};
