import type {
  OrdinaryRunContextInput,
  OrdinaryRunContextReferenceInput,
} from "../../../domain/ordinary/index.js";
import {
  serializeContextReference,
  serializePermissionBoundaryRef,
} from "../../../domain/ordinary/index.js";
import {
  spaceReferenceAttachmentId,
  spaceReferenceWritePermission,
  spaceScopePermission,
  type SpaceFeature,
  type SpaceReferenceItem,
} from "../../spaces/index.js";
import type { WorkspaceFeature } from "../../workspaces/index.js";
import { resolveSpaceFilesystemReference } from "./space-workspace-reference.js";
import { PanelHttpError } from "../http-utils.js";

export type ConversationSpaceAccess = {
  readonly spaceId?: string;
  readonly contextInput?: OrdinaryRunContextInput;
};

type AgentAccessibleSpaceReference = {
  readonly item: SpaceReferenceItem;
  readonly path: string;
  readonly kind: "file" | "project";
  readonly sourceIdentity?: string;
};

/**
 * Resolves the unique Space owning a conversation and freezes that Space's
 * local references into this turn's Ordinary context. Later additions affect only
 * later turns; removals are enforced separately by the live deny overlay.
 *
 * Owner is read from the Ordinary canonical conversation record.
 */
export async function resolveConversationSpaceAccess(
  spaces: {
    readonly queries: Pick<SpaceFeature["queries"], "getTree">;
  },
  workspaces: {
    readonly commands: Pick<WorkspaceFeature["commands"], "invalidateMount">;
    readonly queries: Pick<WorkspaceFeature["queries"], "get">;
  },
  ordinaryOwner: ((conversationId: string) => Promise<{ readonly kind: "space" | "workspace"; readonly id: string } | undefined>) | undefined,
  conversationId: string | undefined,
  contextInput: OrdinaryRunContextInput | undefined,
  requestedSpaceId?: string,
): Promise<ConversationSpaceAccess> {
  const owner = conversationId === undefined
    ? (requestedSpaceId === undefined ? undefined : { spaceId: requestedSpaceId })
    : await (ordinaryOwner === undefined ? Promise.resolve(undefined) : ordinaryOwner(conversationId))
      .then((canonical) => canonical?.kind === "space" ? { spaceId: canonical.id } : undefined);
  if (owner === undefined) return { contextInput };
  if (conversationId !== undefined && requestedSpaceId !== undefined && owner.spaceId !== requestedSpaceId) {
    throw new Error(`Conversation ${conversationId} belongs to Space ${owner.spaceId}, not ${requestedSpaceId}.`);
  }
  const tree = await spaces.queries.getTree(owner.spaceId);
  if (tree === undefined) return { contextInput };
  const resolvedEntries: readonly (AgentAccessibleSpaceReference | undefined)[] = await Promise.all(tree.entries.map(async (entry): Promise<AgentAccessibleSpaceReference | undefined> => {
    const item = entry.item;
    if (item.reference.kind !== "local_file" && item.reference.kind !== "managed_folder" && item.reference.kind !== "workspace") return undefined;
    try {
      const resolved = await resolveSpaceFilesystemReference({ workspaceFeature: workspaces }, item);
      return {
        item,
        path: resolved.path,
        kind: resolved.sourceKind === "local_file" ? "file" as const : "project" as const,
        sourceIdentity: resolved.sourceIdentity,
      };
    } catch (error) {
      if (error instanceof PanelHttpError && (
        error.code === "workspace_not_available" ||
        error.code === "space_reference_source_missing" ||
        error.code === "space_reference_source_replaced"
      )) return undefined;
      throw error;
    }
  }));
  const fileItems = resolvedEntries.filter((item): item is AgentAccessibleSpaceReference => item !== undefined);
  const generatedAttachmentIds = new Set(fileItems.map(({ item }) => spaceReferenceAttachmentId(item.id)));
  const contextRefs = [
    ...fileItems.map(contextRefFor),
    ...(contextInput?.contextRefs ?? []).filter((ref) =>
      ref.attachmentId === undefined || !generatedAttachmentIds.has(ref.attachmentId)
    ),
  ];
  const permissionBoundaryRefs = unique([
    spaceScopePermission(owner.spaceId),
    ...fileItems.flatMap(permissionRefsFor),
    ...(contextInput?.permissionBoundaryRefs ?? []),
  ]);
  return {
    spaceId: owner.spaceId,
    contextInput: { contextRefs, permissionBoundaryRefs },
  };
}

function contextRefFor(
  resolved: AgentAccessibleSpaceReference,
): OrdinaryRunContextReferenceInput {
  const { item } = resolved;
  const file = resolved.kind === "file";
  return {
    attachmentId: spaceReferenceAttachmentId(item.id),
    ref: serializeContextReference(file
      ? { scheme: "local_file", path: resolved.path }
      : { scheme: "local_project", path: resolved.path }),
    pathGranted: true,
    // Space 授权引用是自动注入的上下文列表，不是用户本轮显式附件：
    // 模型保持引用可见并按需用 AttachmentReadImage 读图，但不会自动把
    // 其中图片附加到每轮模型消息（automaticSpaceReference 标记由
    // model-input-files 消费）。
    automaticSpaceReference: true,
    ...(resolved.sourceIdentity === undefined ? {} : { sourceIdentity: resolved.sourceIdentity }),
    kind: file ? "file" : "project",
    title: item.title,
    summary: "当前对话所属空间授权的本地资源。",
  };
}

function permissionRefsFor(
  resolved: AgentAccessibleSpaceReference,
): readonly string[] {
  const target = serializeContextReference(resolved.kind === "file"
    ? { scheme: "local_file", path: resolved.path }
    : { scheme: "local_project", path: resolved.path });
  return [
    serializePermissionBoundaryRef({ kind: "access", mode: "read", target }),
    spaceReferenceWritePermission(resolved.item.id),
  ];
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
