import {
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceFeatureError,
  type RegisterWorkspaceInput,
  type ReconnectWorkspaceInput,
  type Workspace,
  type WorkspaceDetail,
  type WorkspaceEvent,
  type WorkspaceFeature,
  type WorkspaceLink,
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
  const requireActiveMount = (snapshot: WorkspaceSnapshot, workspaceId: string): WorkspaceMount => {
    const mount = latestMountOf(snapshot, workspaceId);
    if (mount === undefined || mount.status !== "active") {
      throw new WorkspaceFeatureError("workspace_mount_invalid", `Workspace has no active mount: ${workspaceId}`);
    }
    return mount;
  };
  const requireAvailable = (workspace: Workspace): void => {
    if (workspace.status !== "available") {
      throw new WorkspaceFeatureError("workspace_not_available", `Workspace is ${workspace.status}: ${workspace.id}`);
    }
  };

  return {
    ready: () => startup,
    commands: {
      async registerWorkspace(registerInput: RegisterWorkspaceInput) {
        assertUsable("register a Workspace");
        return serialize(async () => {
          const snapshot = await input.repository.read();
          const existingRoots = snapshot.mounts
            .filter((mount) => mount.status === "active" || snapshot.workspaces.some((w) => w.id === mount.workspaceId && w.status === "available"))
            .map((mount) => mount.rootPath);
          assertWorkspacePathUniqueness(existingRoots, registerInput.rootPath);
          const duplicateIdentity = snapshot.mounts.some((mount) => mount.sourceIdentity === registerInput.sourceIdentity);
          if (duplicateIdentity) {
            throw new WorkspaceFeatureError(
              "workspace_duplicate_identity",
              "The same filesystem object is already registered as a Workspace.",
            );
          }
          const at = now();
          const id = createId();
          const workspace: Workspace = {
            id,
            title: registerInput.title ?? pathBasename(registerInput.rootPath),
            status: "available",
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
            links: snapshot.links,
          });
          publish({ type: "workspace.registered", workspace, mount });
          return { workspace, mount };
        });
      },
      async reconnectWorkspace(reconnectInput: ReconnectWorkspaceInput) {
        assertUsable("reconnect a Workspace");
        return serialize(async () => {
          const snapshot = await input.repository.read();
          const workspace = requireWorkspace(snapshot, reconnectInput.workspaceId);
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
          if (previousMount.rootPath === candidate) {
            throw new WorkspaceFeatureError("workspace_mount_conflict", "Reconnect must point to a different path than the current mount.");
          }
          const at = now();
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
            mounts: [...snapshot.mounts, nextMount],
            links: snapshot.links,
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
          const mount = currentMountOf(snapshot, workspaceId);
          if (mount === undefined || mount.status !== "active") return [];
          const at = now();
          const invalidatedMount: WorkspaceMount = {
            ...mount,
            status: "invalidated",
            invalidatedAt: at,
          };
          const revokedLinkIds: string[] = [];
          const links = snapshot.links.map((link) => {
            if (link.workspaceId !== workspaceId || link.status !== "active") return link;
            revokedLinkIds.push(link.linkId);
            return { ...link, status: "revoked" as const, revokedAt: at };
          });
          const nextWorkspace: Workspace = {
            ...workspace,
            status: "disconnected",
            updatedAt: at,
          };
          await input.repository.write({
            schemaVersion: WORKSPACE_SCHEMA_VERSION,
            workspaces: snapshot.workspaces.map((entry) => entry.id === workspaceId ? nextWorkspace : entry),
            mounts: snapshot.mounts.map((entry) => entry === mount ? invalidatedMount : entry),
            links,
          });
          publish({ type: "workspace.mount_invalidated", workspaceId, mountVersion: mount.mountVersion });
          for (const link of links) {
            if (revokedLinkIds.includes(link.linkId)) publish({ type: "workspace.link_revoked", link });
          }
          return revokedLinkIds;
        });
      },
      async linkWorkspaceToSpace(linkInput: { readonly spaceId: string; readonly workspaceId: string }) {
        assertUsable("link a Workspace to a Space");
        return serialize(async () => {
          const snapshot = await input.repository.read();
          const workspace = requireWorkspace(snapshot, linkInput.workspaceId);
          requireAvailable(workspace);
          const duplicate = snapshot.links.some(
            (link) => link.status === "active" && link.spaceId === linkInput.spaceId && link.workspaceId === linkInput.workspaceId,
          );
          if (duplicate) {
            throw new WorkspaceFeatureError("workspace_link_conflict", "This Space already links the Workspace.");
          }
          const mount = requireActiveMount(snapshot, workspace.id);
          const at = now();
          const link: WorkspaceLink = {
            linkId: createId(),
            spaceId: linkInput.spaceId,
            workspaceId: workspace.id,
            mountVersion: mount.mountVersion,
            status: "active",
            createdAt: at,
          };
          await input.repository.write({
            schemaVersion: WORKSPACE_SCHEMA_VERSION,
            workspaces: snapshot.workspaces,
            mounts: snapshot.mounts,
            links: [...snapshot.links, link],
          });
          publish({ type: "workspace.link_created", link });
          return link;
        });
      },
      async unlinkWorkspaceFromSpace(linkId: string) {
        assertUsable("unlink a Workspace");
        return serialize(async () => {
          const snapshot = await input.repository.read();
          const link = snapshot.links.find((entry) => entry.linkId === linkId);
          if (link === undefined) {
            throw new WorkspaceFeatureError("workspace_link_not_found", `Workspace link not found: ${linkId}`);
          }
          if (link.status !== "active") return;
          const at = now();
          const revoked: WorkspaceLink = { ...link, status: "revoked", revokedAt: at };
          await input.repository.write({
            schemaVersion: WORKSPACE_SCHEMA_VERSION,
            workspaces: snapshot.workspaces,
            mounts: snapshot.mounts,
            links: snapshot.links.map((entry) => entry.linkId === linkId ? revoked : entry),
          });
          publish({ type: "workspace.link_revoked", link: revoked });
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
            links: snapshot.links,
          });
          publish({ type: "workspace.deleted", workspaceId });
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
            links: snapshot.links.filter((link) => link.workspaceId !== workspaceId),
          });
        });
      },
    },
    queries: {
      async list() {
        const snapshot = await serialize(() => input.repository.read());
        return snapshot.workspaces.map((workspace) => ({
          id: workspace.id,
          title: workspace.title,
          status: workspace.status,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
          currentMount: currentMountOf(snapshot, workspace.id),
          linkCount: snapshot.links.filter((link) => link.workspaceId === workspace.id && link.status === "active").length,
        }));
      },
      async get(workspaceId: string) {
        const snapshot = await serialize(() => input.repository.read());
        const workspace = snapshot.workspaces.find((entry) => entry.id === workspaceId);
        if (workspace === undefined) return undefined;
        return {
          ...workspace,
          mounts: snapshot.mounts.filter((mount) => mount.workspaceId === workspaceId),
          links: snapshot.links.filter((link) => link.workspaceId === workspaceId),
        } satisfies WorkspaceDetail;
      },
      async getLink(linkId: string) {
        const snapshot = await serialize(() => input.repository.read());
        return snapshot.links.find((link) => link.linkId === linkId);
      },
      async listLinksBySpace(spaceId: string) {
        const snapshot = await serialize(() => input.repository.read());
        return snapshot.links.filter((link) => link.spaceId === spaceId);
      },
      async findByRootPath(rootPath: string) {
        const snapshot = await serialize(() => input.repository.read());
        const candidate = canonicalWorkspacePathIdentity(rootPath);
        const mount = snapshot.mounts.find((entry) => canonicalWorkspacePathIdentity(entry.rootPath) === candidate && entry.status === "active");
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

function pathBasename(rootPath: string): string {
  const segments = rootPath.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments[segments.length - 1] ?? rootPath;
}
