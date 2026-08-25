import {
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceFeatureError,
  type EnsureWorkspaceInput,
  type ReconnectWorkspaceInput,
  type Workspace,
  type WorkspaceDetail,
  type WorkspaceEvent,
  type WorkspaceFeature,
  type WorkspaceMount,
  type WorkspaceRepository,
  type WorkspaceSnapshot,
} from "./contracts.js";
import {
  assertWorkspacePathUniqueness,
  canonicalWorkspacePathIdentity,
} from "./workspace-identity.js";

export type CreateWorkspaceFeatureInput = {
  readonly repository: WorkspaceRepository;
  readonly now?: () => string;
  readonly idFactory?: () => string;
  /** 生成 mountVersion（默认按时间戳）。 */
  readonly mountVersionFactory?: () => string;
};

export function createWorkspaceFeature(input: CreateWorkspaceFeatureInput): WorkspaceFeature {
  const now = input.now ?? (() => new Date().toISOString());
  const createId = input.idFactory ?? (() => crypto.randomUUID());
  const nextMountVersion = input.mountVersionFactory ?? (() => `m-${now()}`);
  const listeners = new Set<(event: WorkspaceEvent) => void>();
  let released = false;
  let tail = Promise.resolve();
  let startupSucceeded = false;

  const serialize = <T>(operation: () => Promise<T>, waitForStartup = true): Promise<T> => {
    const guarded = async () => {
      if (waitForStartup && !startupSucceeded) await startup;
      return operation();
    };
    const result = tail.then(guarded, guarded);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const assertUsable = (action: string) => {
    if (released) throw new WorkspaceFeatureError("workspace_feature_released", `Workspace feature is released and cannot ${action}`);
  };
  const publish = (event: WorkspaceEvent) => {
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* Observers cannot roll back an already committed Workspace command. */ }
    }
  };
  const startup: Promise<void> = serialize(async () => {
    await input.repository.read();
  }, false);
  void startup.then(() => { startupSucceeded = true; }, () => undefined);

  const requireWorkspace = (snapshot: WorkspaceSnapshot, workspaceId: string): Workspace => {
    const workspace = snapshot.workspaces.find((entry) => entry.id === workspaceId);
    if (workspace === undefined) {
      throw new WorkspaceFeatureError("workspace_not_found", `Workspace not found: ${workspaceId}`);
    }
    return workspace;
  };
  const latestMountOf = (snapshot: WorkspaceSnapshot, workspaceId: string): WorkspaceMount | undefined => {
    const mounts = snapshot.mounts.filter((mount) => mount.workspaceId === workspaceId);
    const active = mounts.filter((mount) => mount.status === "active");
    const newest = active.length > 0 ? active : mounts;
    return newest.length === 0 ? undefined : newest[newest.length - 1];
  };
  return {
    ready: () => startup,
    commands: {
      async ensureWorkspace(registerInput: EnsureWorkspaceInput) {
        assertUsable("ensure a Workspace");
        return serialize(async () => {
          const snapshot = await input.repository.read();
          const candidateRoot = canonicalWorkspacePathIdentity(registerInput.rootPath);
          const identityMount = snapshot.mounts.find((mount) => mount.sourceIdentity === registerInput.sourceIdentity);
          const pathMount = snapshot.mounts.find((mount) => canonicalWorkspacePathIdentity(mount.rootPath) === candidateRoot && mount.status === "active");
          if (identityMount !== undefined && pathMount !== undefined && identityMount.workspaceId !== pathMount.workspaceId) {
            throw new WorkspaceFeatureError("workspace_mount_conflict", "The selected path and filesystem identity belong to different Workspaces.");
          }
          const existingMount = identityMount ?? pathMount;
          if (existingMount !== undefined) {
            const current = requireWorkspace(snapshot, existingMount.workspaceId);
            if (current.status === "deleting") throw new WorkspaceFeatureError("workspace_not_available", `Workspace is deleting: ${current.id}`);
            if (pathMount !== undefined && pathMount.sourceIdentity !== registerInput.sourceIdentity) {
              throw new WorkspaceFeatureError("workspace_mount_conflict", "The selected path is bound to a different Workspace object.");
            }
            const visibility = current.visibility === "listed" || registerInput.visibility === "listed" ? "listed" : "implicit";
            const mount = latestMountOf(snapshot, current.id);
            if (mount === undefined || mount.sourceIdentity !== registerInput.sourceIdentity) {
              throw new WorkspaceFeatureError("workspace_mount_conflict", "The selected directory is not the same filesystem object as the existing Workspace.");
            }
            if (mount.status !== "active" || canonicalWorkspacePathIdentity(mount.rootPath) !== candidateRoot) {
              throw new WorkspaceFeatureError(
                "workspace_mount_invalid",
                "The Workspace mount changed or is disconnected; reconnect it through the explicit reconnect command.",
              );
            }
            const workspace: Workspace = visibility === current.visibility
              ? current
              : { ...current, visibility, updatedAt: now() };
            if (workspace !== current) {
              await input.repository.write({
                schemaVersion: WORKSPACE_SCHEMA_VERSION,
                workspaces: snapshot.workspaces.map((entry) => entry.id === current.id ? workspace : entry),
                mounts: snapshot.mounts,
              });
              if (workspace.visibility !== current.visibility) publish({ type: "workspace.visibility_changed", workspace });
            }
            return { workspace, mount, created: false };
          }
          assertWorkspaceRootAvailable(snapshot, registerInput.rootPath);
          const at = now();
          const id = createId();
          const workspace: Workspace = {
            id,
            title: registerInput.title ?? pathBasename(registerInput.rootPath),
            status: "available",
            visibility: registerInput.visibility,
            createdAt: at,
            updatedAt: at,
          };
          const mount: WorkspaceMount = {
            workspaceId: id,
            mountVersion: nextMountVersion(),
            rootPath: canonicalWorkspacePathIdentity(registerInput.rootPath),
            sourceIdentity: registerInput.sourceIdentity,
            status: "active",
            connectedAt: at,
          };
          await input.repository.write({
            schemaVersion: WORKSPACE_SCHEMA_VERSION,
            workspaces: [...snapshot.workspaces, workspace],
            mounts: [...snapshot.mounts, mount],
          });
          publish({ type: "workspace.registered", workspace, mount });
          return { workspace, mount, created: true };
        });
      },
      async setVisibility(workspaceId, visibility) {
        assertUsable("change Workspace visibility");
        return serialize(async () => {
          const snapshot = await input.repository.read();
          const current = requireWorkspace(snapshot, workspaceId);
          if (current.visibility === visibility) return current;
          const workspace: Workspace = { ...current, visibility, updatedAt: now() };
          await input.repository.write({ schemaVersion: WORKSPACE_SCHEMA_VERSION, workspaces: snapshot.workspaces.map((entry) => entry.id === workspaceId ? workspace : entry), mounts: snapshot.mounts });
          publish({ type: "workspace.visibility_changed", workspace });
          return workspace;
        });
      },
      async reconnectWorkspace(reconnectInput: ReconnectWorkspaceInput) {
        assertUsable("reconnect a Workspace");
        return serialize(async () => {
          const snapshot = await input.repository.read();
          const workspace = requireWorkspace(snapshot, reconnectInput.workspaceId);
          if (workspace.status === "deleting") {
            throw new WorkspaceFeatureError("workspace_not_available", `Workspace is deleting: ${workspace.id}`);
          }
          const previousMount = latestMountOf(snapshot, workspace.id);
          if (previousMount === undefined) {
            throw new WorkspaceFeatureError("workspace_mount_invalid", `Workspace has no mount to reconnect: ${workspace.id}`);
          }
          if (previousMount.sourceIdentity !== reconnectInput.sourceIdentity) {
            throw new WorkspaceFeatureError(
              "workspace_mount_conflict",
              "Reconnect target is a different filesystem object; register a new Workspace instead.",
            );
          }
          const candidate = canonicalWorkspacePathIdentity(reconnectInput.rootPath);
          if (previousMount.status === "active" && canonicalWorkspacePathIdentity(previousMount.rootPath) === candidate && workspace.status === "available") {
            return { workspace, mount: previousMount };
          }
          const at = now();
          assertWorkspaceRootAvailable(snapshot, reconnectInput.rootPath, workspace.id);
          const nextMount: WorkspaceMount = {
            workspaceId: workspace.id,
            mountVersion: nextMountVersion(),
            rootPath: candidate,
            sourceIdentity: reconnectInput.sourceIdentity,
            status: "active",
            connectedAt: at,
          };
          const nextWorkspace: Workspace = {
            ...workspace,
            status: "available",
            updatedAt: at,
          };
          const updatedSnapshot: WorkspaceSnapshot = {
            schemaVersion: WORKSPACE_SCHEMA_VERSION,
            workspaces: snapshot.workspaces.map((entry) => entry.id === workspace.id ? nextWorkspace : entry),
            mounts: [...invalidateActiveMounts(snapshot.mounts, workspace.id, at), nextMount],
          };
          await input.repository.write(updatedSnapshot);
          publish({ type: "workspace.reconnected", workspaceId: workspace.id, mount: nextMount });
          return { workspace: nextWorkspace, mount: nextMount };
        });
      },
      async invalidateMount(workspaceId: string) {
        assertUsable("invalidate a mount");
        return serialize(async () => {
          const snapshot = await input.repository.read();
          const workspace = requireWorkspace(snapshot, workspaceId);
          const activeMounts = snapshot.mounts.filter((mount) => mount.workspaceId === workspaceId && mount.status === "active");
          if (activeMounts.length === 0) return;
          const at = now();
          const nextWorkspace: Workspace = {
            ...workspace,
            status: "disconnected",
            updatedAt: at,
          };
          await input.repository.write({
            schemaVersion: WORKSPACE_SCHEMA_VERSION,
            workspaces: snapshot.workspaces.map((entry) => entry.id === workspaceId ? nextWorkspace : entry),
            mounts: invalidateActiveMounts(snapshot.mounts, workspaceId, at),
          });
          for (const mount of activeMounts) {
            publish({ type: "workspace.mount_invalidated", workspaceId, mountVersion: mount.mountVersion });
          }
        });
      },
      async deleteWorkspace(workspaceId: string) {
        assertUsable("delete a Workspace");
        return serialize(async () => {
          const snapshot = await input.repository.read();
          const workspace = requireWorkspace(snapshot, workspaceId);
          if (workspace.status === "deleting") return;
          const at = now();
          const next: Workspace = { ...workspace, status: "deleting", updatedAt: at };
          await input.repository.write({
            schemaVersion: WORKSPACE_SCHEMA_VERSION,
            workspaces: snapshot.workspaces.map((entry) => entry.id === workspaceId ? next : entry),
            mounts: snapshot.mounts,
          });
          publish({ type: "workspace.deleted", workspaceId });
        });
      },
      async discardImplicitWorkspace(workspaceId: string) {
        assertUsable("discard an implicit Workspace");
        return serialize(async () => {
          const snapshot = await input.repository.read();
          const workspace = requireWorkspace(snapshot, workspaceId);
          if (workspace.visibility !== "implicit" || workspace.status === "deleting") {
            throw new WorkspaceFeatureError(
              "workspace_discard_not_allowed",
              `Workspace ${workspaceId} is not an attach-only implicit registration.`,
            );
          }
          await input.repository.write({
            schemaVersion: WORKSPACE_SCHEMA_VERSION,
            workspaces: snapshot.workspaces.filter((entry) => entry.id !== workspaceId),
            mounts: snapshot.mounts.filter((mount) => mount.workspaceId !== workspaceId),
          });
        });
      },
      async purgeWorkspace(workspaceId: string) {
        assertUsable("purge a Workspace");
        return serialize(async () => {
          const snapshot = await input.repository.read();
          const workspace = requireWorkspace(snapshot, workspaceId);
          if (workspace.status !== "deleting") {
            throw new WorkspaceFeatureError(
              "workspace_not_deleting",
              `Workspace must enter deleting before purge: ${workspaceId}`,
            );
          }
          // 删除流程的收尾：级联（停止进程、删除 Conversation、撤销 links）完成后，
          // 物理移除软件侧登记（元数据、mount 与残留 link），外部文件夹与知识副本不受影响。
          await input.repository.write({
            schemaVersion: WORKSPACE_SCHEMA_VERSION,
            workspaces: snapshot.workspaces.filter((entry) => entry.id !== workspaceId),
            mounts: snapshot.mounts.filter((mount) => mount.workspaceId !== workspaceId),
          });
        });
      },
    },
    queries: {
      async list() {
        const snapshot = await serialize(() => input.repository.read());
        return snapshot.workspaces.filter((workspace) => workspace.visibility === "listed").map((workspace) => ({
          id: workspace.id,
          title: workspace.title,
          status: workspace.status,
          visibility: workspace.visibility,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
          currentMount: currentMountOf(snapshot, workspace.id),
        }));
      },
      async listAll() {
        const snapshot = await serialize(() => input.repository.read());
        return snapshot.workspaces.map((workspace) => ({
          id: workspace.id,
          title: workspace.title,
          status: workspace.status,
          visibility: workspace.visibility,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
          currentMount: currentMountOf(snapshot, workspace.id),
        }));
      },
      async get(workspaceId: string) {
        const snapshot = await serialize(() => input.repository.read());
        const workspace = snapshot.workspaces.find((entry) => entry.id === workspaceId);
        if (workspace === undefined) return undefined;
        return {
          ...workspace,
          mounts: snapshot.mounts.filter((mount) => mount.workspaceId === workspaceId),
        } satisfies WorkspaceDetail;
      },
      async findByRootPath(rootPath: string) {
        const snapshot = await serialize(() => input.repository.read());
        const candidate = canonicalWorkspacePathIdentity(rootPath);
        const mount = snapshot.mounts.find((entry) => canonicalWorkspacePathIdentity(entry.rootPath) === candidate && entry.status === "active");
        return mount === undefined ? undefined : snapshot.workspaces.find((workspace) => workspace.id === mount.workspaceId);
      },
      async findBySourceIdentity(sourceIdentity: string) {
        const snapshot = await serialize(() => input.repository.read());
        const mount = snapshot.mounts.find((entry) => entry.sourceIdentity === sourceIdentity);
        return mount === undefined ? undefined : snapshot.workspaces.find((workspace) => workspace.id === mount.workspaceId);
      },
    },
    events: { subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    } },
    release() {
      released = true;
      return tail.then(() => undefined, () => undefined);
    },
  };
}

function currentMountOf(snapshot: WorkspaceSnapshot, workspaceId: string): WorkspaceMount | undefined {
  const mounts = snapshot.mounts.filter((mount) => mount.workspaceId === workspaceId);
  const active = mounts.filter((mount) => mount.status === "active");
  const newest = active.length > 0 ? active : mounts;
  return newest.length === 0 ? undefined : newest[newest.length - 1];
}

function assertWorkspaceRootAvailable(
  snapshot: WorkspaceSnapshot,
  candidatePath: string,
  excludeWorkspaceId?: string,
): void {
  const activeRoots = snapshot.mounts
    .filter((mount) => mount.status === "active" && mount.workspaceId !== excludeWorkspaceId)
    .filter((mount) => snapshot.workspaces.some((workspace) =>
      workspace.id === mount.workspaceId && workspace.status === "available"))
    .map((mount) => mount.rootPath);
  assertWorkspacePathUniqueness(activeRoots, candidatePath);
}

function invalidateActiveMounts(
  mounts: readonly WorkspaceMount[],
  workspaceId: string,
  invalidatedAt: string,
): readonly WorkspaceMount[] {
  return mounts.map((mount) => mount.workspaceId === workspaceId && mount.status === "active"
    ? { ...mount, status: "invalidated" as const, invalidatedAt }
    : mount);
}

function pathBasename(rootPath: string): string {
  const segments = rootPath.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments[segments.length - 1] ?? rootPath;
}
