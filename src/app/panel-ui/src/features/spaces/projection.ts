import type { SpaceReference, SpaceTree, SpaceTreeEntry } from "@panel-api/spaces"
import type { PersonalSpaceItemProjection, PersonalSpaceProjection } from "../../personal-workbench/space"

export type SpaceConversationSummary = {
  readonly conversationId: string
  readonly title: string
  readonly updatedAt?: string
  readonly pinnedAt?: string
}

export function projectSpaceTree(
  tree: SpaceTree,
  conversations?: readonly SpaceConversationSummary[],
  now = Date.now(),
): PersonalSpaceProjection {
  return {
    spaceId: tree.space.id,
    title: tree.space.title,
    itemCount: tree.entries.length,
    color: colorFor(tree.space.id),
    items: projectEntries(tree.entries, now),
    ...(conversations === undefined ? {} : {
      conversations: conversations.map((conversation) => ({
        conversationId: conversation.conversationId,
        title: conversation.title,
        ...(conversation.updatedAt === undefined ? {} : { updatedAt: conversation.updatedAt }),
        ...(conversation.pinnedAt === undefined ? {} : { pinnedAt: conversation.pinnedAt }),
      })),
    }),
  }
}

function projectEntries(entries: readonly SpaceTreeEntry[], now: number): PersonalSpaceItemProjection[] {
  const childrenByParent = new Map<string | undefined, SpaceTreeEntry[]>()
  for (const entry of entries) {
    const group = childrenByParent.get(entry.item.parentId) ?? []
    group.push(entry)
    childrenByParent.set(entry.item.parentId, group)
  }
  const project = (entry: SpaceTreeEntry): PersonalSpaceItemProjection => ({
    ...projectEntry(entry, now),
    ...((childrenByParent.get(entry.item.id)?.length ?? 0) > 0
      ? { children: childrenByParent.get(entry.item.id)!.map(project) }
      : {}),
  })
  return (childrenByParent.get(undefined) ?? []).map(project)
}

function projectEntry(entry: SpaceTreeEntry, now: number): PersonalSpaceItemProjection {
  const { item } = entry
  const openable = item.reference.kind !== "generated_artifact"
    && item.reference.kind !== "asset_folder"
    && item.workspace?.status !== "disconnected"
  const isFileSystemFolder = item.reference.kind === "workspace" || item.reference.kind === "managed_folder"
  return {
    itemId: item.id,
    title: item.title,
    kind: itemKind(item.reference.kind),
    openable,
    ...(isFileSystemFolder ? { referenceId: item.id } : {}),
    ...(item.reference.kind === "managed_asset" ? { referenceId: item.id, assetId: item.reference.assetId } : {}),
    ...(item.reference.kind === "workspace" ? {
      workspaceId: item.reference.workspaceId,
      workspaceStatus: item.workspace?.status ?? "disconnected",
    } : {}),
    ...(item.reference.kind === "web_page" ? { openUrl: item.reference.url } : {}),
    detail: itemDetail(item.reference),
    updatedAtLabel: relativeTimeLabel(item.updatedAt, now),
  }
}

function itemKind(kind: SpaceReference["kind"]): PersonalSpaceItemProjection["kind"] {
  switch (kind) {
    case "local_file": return "local_file"
    case "workspace": return "workspace"
    case "managed_folder": return "managed_folder"
    case "asset_folder": return "folder"
    case "managed_asset": return "managed_asset"
    case "web_page": return "web_reference"
    case "generated_artifact": return "generated_artifact"
    default: return "local_file"
  }
}

function itemDetail(reference: SpaceReference): string | undefined {
  switch (reference.kind) {
    case "local_file":
    case "managed_folder": return reference.path
    case "workspace":
    case "asset_folder":
    case "managed_asset": return undefined
    case "web_page": return reference.url
    case "generated_artifact": return reference.artifactRef
  }
}

function relativeTimeLabel(value: string, now: number): string | undefined {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return undefined
  const elapsed = now - timestamp
  if (elapsed < 60_000) return "刚刚"
  if (elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
}

function colorFor(id: string): string {
  const palette = ["#7a78bd", "#5f9a6b", "#c28b44", "#7186ab"]
  let value = 0
  for (const character of id) value = ((value << 5) - value + character.charCodeAt(0)) | 0
  return palette[Math.abs(value) % palette.length] ?? palette[0]!
}
