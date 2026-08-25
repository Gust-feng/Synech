import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { OrdinaryAgentFeature } from "../../ordinary-agent/index.js";
import type { SpaceFeature } from "../../spaces/index.js";
import type { WorkspaceFeature } from "../../workspaces/index.js";
import { PanelHttpError, readJsonBody, writeJson } from "../http-utils.js";
import type { SpaceConversationDeletionCoordinator } from "./space-conversation-coordinator.js";

export type SpaceMetadataRouteDependencies = {
  readonly spaceFeature: {
    readonly commands: Pick<SpaceFeature["commands"], "createSpace">;
    readonly queries: Pick<SpaceFeature["queries"], "list" | "getTree">;
  };
  readonly ordinaryAgentFeature: {
    readonly queries: Pick<OrdinaryAgentFeature["queries"], "listConversationsByOwner" | "getConversation">;
  };
  readonly workspaceFeature: { readonly queries: Pick<WorkspaceFeature["queries"], "get"> };
  readonly spaceConversationDeletion: Pick<SpaceConversationDeletionCoordinator, "assertAvailable" | "deleteSpace">;
  readonly ensureDefaultSpace: () => Promise<void>;
  readonly flushSpaceKnowledgeSync: () => Promise<void>;
};

const createSpaceSchema = z.object({ title: z.string().trim().min(1).max(160) }).strict();

export async function handlePanelSpaceMetadataRoute(
  dependencies: SpaceMetadataRouteDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname === "/api/spaces") {
    if (request.method === "GET") {
      await dependencies.ensureDefaultSpace();
      writeJson(response, 200, { ok: true, spaces: await dependencies.spaceFeature.queries.list() });
      return true;
    }
    if (request.method === "POST") {
      const result = createSpaceSchema.safeParse(await readJsonBody(request));
      if (!result.success) throw new PanelHttpError(400, "invalid_space_input", "空间名称无效。");
      writeJson(response, 201, { ok: true, space: await dependencies.spaceFeature.commands.createSpace(result.data) });
      return true;
    }
    return false;
  }

  const treeMatch = /^\/api\/spaces\/([^/]+)$/u.exec(url.pathname);
  if (treeMatch !== null && request.method === "GET") {
    await dependencies.ensureDefaultSpace();
    const spaceId = decode(treeMatch[1]);
    const tree = await dependencies.spaceFeature.queries.getTree(spaceId);
    if (tree === undefined) throw new PanelHttpError(404, "space_not_found", "未找到空间。");
    const canonicalConversations = await dependencies.ordinaryAgentFeature.queries.listConversationsByOwner({ kind: "space", id: spaceId });
    const entries = await Promise.all(tree.entries.map(async (entry) => {
      if (entry.item.reference.kind !== "workspace") return entry;
      const workspace = await dependencies.workspaceFeature.queries.get(entry.item.reference.workspaceId);
      const mount = workspace === undefined ? undefined : [...workspace.mounts].reverse().find((candidate) => candidate.status === "active");
      return {
        ...entry,
        item: {
          ...entry.item,
          workspace: {
            status: workspace?.status ?? "disconnected",
            ...(mount === undefined ? {} : { rootPath: mount.rootPath, mountVersion: mount.mountVersion }),
          },
        },
      };
    }));
    writeJson(response, 200, {
      ok: true,
      tree: { ...tree, entries },
      conversations: [
        ...canonicalConversations.map((conversation) => ({
          conversationId: conversation.conversationId,
          title: conversation.title,
          updatedAt: conversation.updatedAt,
          pinnedAt: conversation.pinnedAt,
        })),
      ],
    });
    return true;
  }
  if (treeMatch !== null && request.method === "DELETE") {
    const spaceId = decode(treeMatch[1]);
    if (await dependencies.spaceFeature.queries.getTree(spaceId) === undefined) {
      throw new PanelHttpError(404, "space_not_found", "未找到空间。");
    }
    await dependencies.spaceConversationDeletion.deleteSpace(spaceId);
    await dependencies.flushSpaceKnowledgeSync();
    writeJson(response, 200, { ok: true });
    return true;
  }
  return false;
}

function decode(value: string | undefined): string {
  try {
    return decodeURIComponent(value ?? "");
  } catch {
    throw new PanelHttpError(400, "invalid_space_input", "空间标识无效。");
  }
}
