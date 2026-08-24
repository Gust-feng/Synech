import type {
  OrdinaryRunContextInput,
  OrdinaryRunContextReferenceInput,
} from "../../../domain/ordinary/index.js";
import {
  spaceReferenceAttachmentId,
  spaceReferenceWritePermission,
  spaceScopePermission,
  type SpaceFeature,
  type SpaceReferenceItem,
} from "../../spaces/index.js";

export type ConversationSpaceAccess = {
  readonly spaceId?: string;
  readonly contextInput?: OrdinaryRunContextInput;
};

type AgentAccessibleSpaceReferenceItem = SpaceReferenceItem & {
  readonly reference:
    | { readonly kind: "local_file"; readonly path: string }
    | { readonly kind: "workspace_folder"; readonly path: string }
    | { readonly kind: "managed_folder"; readonly path: string };
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
  const fileItems = tree.entries
    .map((entry) => entry.item)
    .filter(isAgentAccessibleLocalReference);
  const generatedAttachmentIds = new Set(fileItems.map((item) => spaceReferenceAttachmentId(item.id)));
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

function isAgentAccessibleLocalReference(item: SpaceReferenceItem): item is AgentAccessibleSpaceReferenceItem {
  return item.reference.kind === "local_file" ||
    item.reference.kind === "workspace_folder" ||
    item.reference.kind === "managed_folder";
}

function contextRefFor(
  item: AgentAccessibleSpaceReferenceItem,
): OrdinaryRunContextReferenceInput {
  const file = item.reference.kind === "local_file";
  return {
    attachmentId: spaceReferenceAttachmentId(item.id),
    ref: `${file ? "local-file" : "local-project"}:${item.reference.path}`,
    pathGranted: true,
    // Space 授权引用是自动注入的上下文列表，不是用户本轮显式附件：
    // 模型保持引用可见并按需用 AttachmentReadImage 读图，但不会自动把
    // 其中图片附加到每轮模型消息（automaticSpaceReference 标记由
    // model-input-files 消费）。
    automaticSpaceReference: true,
    ...(item.sourceIdentity === undefined ? {} : { sourceIdentity: item.sourceIdentity }),
    kind: file ? "file" : "project",
    title: item.title,
    summary: "当前对话所属空间授权的本地资源。",
  };
}

function permissionRefsFor(
  item: AgentAccessibleSpaceReferenceItem,
): readonly string[] {
  const readKind = item.reference.kind === "local_file" ? "local-file" : "local-project";
  return [`read:${readKind}:${item.reference.path}`, spaceReferenceWritePermission(item.id)];
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
