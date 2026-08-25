import { z } from "zod";
import { WORKSPACE_SCHEMA_VERSION, WorkspaceFeatureError, type WorkspaceSnapshot } from "./contracts.js";
import { workspacePathNesting } from "./workspace-identity.js";

const workspaceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["available", "disconnected", "deleting"]),
  visibility: z.enum(["listed", "implicit"]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();

const mountSchema = z.object({
  workspaceId: z.string().min(1),
  mountVersion: z.string().min(1),
  rootPath: z.string().min(1),
  sourceIdentity: z.string().min(1),
  status: z.enum(["active", "invalidated"]),
  connectedAt: z.string().min(1),
  invalidatedAt: z.string().min(1).optional(),
}).strict();

const snapshotSchema = z.object({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  workspaces: z.array(workspaceSchema),
  mounts: z.array(mountSchema),
}).strict().superRefine((snapshot, context) => {
  const workspaceIds = new Set(snapshot.workspaces.map((workspace) => workspace.id));
  const identityOwners = new Map<string, string>();
  for (const [index, mount] of snapshot.mounts.entries()) {
    if (!workspaceIds.has(mount.workspaceId)) {
      context.addIssue({ code: "custom", path: ["mounts", index, "workspaceId"], message: "mount owner must exist" });
    }
    const owner = identityOwners.get(mount.sourceIdentity);
    if (owner !== undefined && owner !== mount.workspaceId) {
      context.addIssue({ code: "custom", path: ["mounts", index, "sourceIdentity"], message: "source identity cannot belong to multiple Workspaces" });
    } else {
      identityOwners.set(mount.sourceIdentity, mount.workspaceId);
    }
  }
  for (const [index, workspace] of snapshot.workspaces.entries()) {
    const activeMounts = snapshot.mounts.filter((mount) => mount.workspaceId === workspace.id && mount.status === "active");
    const valid = workspace.status === "available"
      ? activeMounts.length === 1
      : workspace.status === "disconnected"
        ? activeMounts.length === 0
        : activeMounts.length <= 1;
    if (!valid) context.addIssue({ code: "custom", path: ["workspaces", index, "status"], message: "status and active mount count disagree" });
  }
  const active = snapshot.mounts.filter((mount) => mount.status === "active");
  for (let left = 0; left < active.length; left += 1) {
    for (let right = left + 1; right < active.length; right += 1) {
      if (active[left]!.workspaceId === active[right]!.workspaceId) continue;
      if (workspacePathNesting(active[left]!.rootPath, active[right]!.rootPath).kind !== "none") {
        context.addIssue({ code: "custom", path: ["mounts", right, "rootPath"], message: "active Workspace roots cannot overlap" });
      }
    }
  }
});

export function validateWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  const result = snapshotSchema.safeParse(value);
  if (!result.success) {
    throw new WorkspaceFeatureError(
      "workspace_snapshot_incompatible",
      "Workspace snapshot is incompatible with the Synech v1 baseline.",
      { cause: result.error },
    );
  }
  return result.data;
}
