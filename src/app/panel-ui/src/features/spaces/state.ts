import { useCallback, useEffect, useRef, useState } from "react";
import { deleteJson, getJson, postJson } from "../../api";
import { selectLocalContextAttachment } from "../../workbench/attachments";
import { selectTaskWorkspaceDirectory } from "./workspace-selection";
import type { ContextAttachment } from "../../contracts/context";
import type { SpaceSummary, SpaceTree } from "@panel-api/spaces";
import type { PersonalSpaceProjection } from "../../personal-workbench/space";
import { subscribeWorkbenchProjectionChanges } from "../../workbench/projection-changes";
import { invalidateDocumentPreviews } from "../../personal-workbench/workbench/app/components/referencePreviewClient";
import { projectSpaceTree, type SpaceConversationSummary } from "./projection";

type SpaceSummaryResponse = {
  readonly spaces: readonly SpaceSummary[];
};

type SpaceTreeResponse = {
  readonly tree: SpaceTree;
  readonly conversations?: readonly SpaceConversationSummary[];
};

/** Panel query state for SpaceFeature's one-way tree projection. */
export function useSpaceProjection(enabled = true): {
  readonly spaces: readonly PersonalSpaceProjection[];
  readonly createSpace: (title: string) => Promise<void>;
  readonly deleteSpace: (spaceId: string) => Promise<void>;
  readonly createManagedFolder: (spaceId: string, title: string) => Promise<void>;
  readonly addLocalFile: (spaceId: string) => Promise<void>;
  readonly addWorkspaceFolder: (spaceId: string) => Promise<void>;
  readonly addWebReference: (spaceId: string, title: string, url: string) => Promise<void>;
  readonly rename: (target: { readonly kind: "space" | "reference"; readonly id: string }, title: string) => Promise<void>;
  readonly unlinkReference: (itemId: string) => Promise<void>;
  readonly reconnectWorkspace: (workspaceId: string) => Promise<void>;
  readonly removeReference: (itemId: string) => Promise<void>;
  readonly openReference: (spaceId: string, itemId: string) => Promise<void>;
  readonly refresh: () => Promise<void>;
  /** 会话控制变更后刷新单个空间的 owner read-model。 */
  readonly refreshSpace: (spaceId: string) => Promise<void>;
  readonly loading: boolean;
  readonly mutationPending: boolean;
  readonly error?: string;
} {
  const [spaces, setSpaces] = useState<readonly PersonalSpaceProjection[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | undefined>();
  const refreshAbortRef = useRef<AbortController | undefined>(undefined);
  const refreshEpochRef = useRef(0);
  const spaceRefreshRevisionRef = useRef(new Map<string, number>());
  const spaceRefreshControllersRef = useRef(new Map<string, AbortController>());
  const mutationPromisesRef = useRef(new Map<string, Promise<void>>());
  const [mutationPendingCount, setMutationPendingCount] = useState(0);

  const refreshSpaceTree = useCallback(async (spaceId: string): Promise<void> => {
    const revision = (spaceRefreshRevisionRef.current.get(spaceId) ?? 0) + 1;
    spaceRefreshRevisionRef.current.set(spaceId, revision);
    spaceRefreshControllersRef.current.get(spaceId)?.abort();
    const abortController = new AbortController();
    spaceRefreshControllersRef.current.set(spaceId, abortController);
    try {
      const { tree, conversations } = await getJson<SpaceTreeResponse>(
        `/api/spaces/${encodeURIComponent(spaceId)}`,
        { signal: abortController.signal },
      );
      if (spaceRefreshRevisionRef.current.get(spaceId) !== revision) return;
      setSpaces((current) => current.map((space) => space.spaceId === spaceId ? projectSpaceTree(tree, conversations) : space));
    } catch (reason: unknown) {
      // A newer refresh for the same Space owns the result. Superseded reads
      // are normal during quick successive mutations and must not surface as
      // failed user actions.
      if (isAbortError(reason) || spaceRefreshRevisionRef.current.get(spaceId) !== revision) return;
      throw reason;
    } finally {
      if (spaceRefreshControllersRef.current.get(spaceId) === abortController) {
        spaceRefreshControllersRef.current.delete(spaceId);
      }
    }
  }, []);

  const refreshAffectedSpaces = useCallback(async (spaceIds: readonly string[]): Promise<void> => {
    const uniqueIds = [...new Set(spaceIds.filter((spaceId) => spaceId.length > 0))];
    await Promise.all(uniqueIds.map((spaceId) => refreshSpaceTree(spaceId)));
  }, [refreshSpaceTree]);

  const refresh = useCallback(async (): Promise<void> => {
    const epoch = ++refreshEpochRef.current;
    refreshAbortRef.current?.abort();
    const abortController = new AbortController();
    refreshAbortRef.current = abortController;
    setLoading(true);
    setError(undefined);
    try {
      const listed = await getJson<SpaceSummaryResponse>("/api/spaces", { signal: abortController.signal });
      if (epoch !== refreshEpochRef.current) return;
      const revisionsAtStart = new Map(
        listed.spaces.map((summary) => [summary.id, spaceRefreshRevisionRef.current.get(summary.id) ?? 0]),
      );
      const trees = await Promise.all(listed.spaces.map(async (summary) => {
        const { tree, conversations } = await getJson<SpaceTreeResponse>(
          `/api/spaces/${encodeURIComponent(summary.id)}`,
          { signal: abortController.signal },
        );
        return projectSpaceTree(tree, conversations);
      }));
      if (epoch !== refreshEpochRef.current) return;
      setSpaces((current) => {
        const currentById = new Map(current.map((space) => [space.spaceId, space]));
        return trees.map((tree) => {
          const revisionAtStart = revisionsAtStart.get(tree.spaceId) ?? 0;
          const currentRevision = spaceRefreshRevisionRef.current.get(tree.spaceId) ?? 0;
          return currentRevision === revisionAtStart ? tree : currentById.get(tree.spaceId) ?? tree;
        });
      });
    } catch (reason: unknown) {
      if (epoch !== refreshEpochRef.current || isAbortError(reason)) return;
      setError(reason instanceof Error ? reason.message : "空间数据加载失败。");
      throw reason;
    } finally {
      if (epoch === refreshEpochRef.current) {
        setLoading(false);
        if (refreshAbortRef.current === abortController) refreshAbortRef.current = undefined;
      }
    }
  }, []);

  const runMutation = useCallback((key: string, request: () => Promise<unknown>, affectedSpaceIds?: readonly string[]): Promise<void> => {
    const existing = mutationPromisesRef.current.get(key);
    if (existing !== undefined) return existing;
    setMutationPendingCount((count) => count + 1);
    setError(undefined);
    const pending = (async () => {
      try {
        try {
          await request();
        } catch (reason: unknown) {
          setError(reason instanceof Error ? reason.message : "空间数据保存失败。");
          throw reason;
        }
        try {
          if (affectedSpaceIds === undefined) await refresh();
          else await refreshAffectedSpaces(affectedSpaceIds);
        } catch {
          setError("操作已完成，但空间数据刷新失败。请手动刷新。");
        }
      } finally {
        mutationPromisesRef.current.delete(key);
        setMutationPendingCount((count) => Math.max(0, count - 1));
      }
    })();
    mutationPromisesRef.current.set(key, pending);
    return pending;
  }, [refresh, refreshAffectedSpaces]);

  useEffect(() => {
    if (!enabled) {
      refreshAbortRef.current?.abort();
      for (const controller of spaceRefreshControllersRef.current.values()) controller.abort();
      spaceRefreshControllersRef.current.clear();
      setLoading(false);
      return undefined;
    }
    void refresh().catch(() => undefined);
    return () => {
      refreshAbortRef.current?.abort();
      for (const controller of spaceRefreshControllersRef.current.values()) controller.abort();
      spaceRefreshControllersRef.current.clear();
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeWorkbenchProjectionChanges((change) => {
      if (!change.owners.includes("spaces")) return;
      invalidateDocumentPreviews(change.referenceIds);
      void refresh().catch(() => undefined);
    });
  }, [enabled, refresh]);

  const createSpace = useCallback(async (title: string): Promise<void> => {
    await runMutation(`create-space:${title.trim()}`, () => postJson("/api/spaces", { title }));
  }, [runMutation]);

  const deleteSpace = useCallback(async (spaceId: string): Promise<void> => {
    await runMutation(`delete-space:${spaceId}`, () => deleteJson(`/api/spaces/${encodeURIComponent(spaceId)}`));
  }, [runMutation]);

  const createManagedFolder = useCallback(async (spaceId: string, title: string): Promise<void> => {
    await runMutation(`create-managed-folder:${spaceId}:${title.trim()}`, () => postJson(`/api/spaces/${encodeURIComponent(spaceId)}/managed-folders`, {
      title,
    }), [spaceId]);
  }, [runMutation]);

  const addLocalFile = useCallback(async (spaceId: string): Promise<void> => {
    const attachment = await selectLocalContextAttachment();
    if (attachment === undefined) return;
    if (attachment.localSource?.kind === "project") {
      const rootPath = attachment.localSource.path;
      await runMutation(`add-workspace:${spaceId}:${rootPath}`, () => postJson(`/api/spaces/${encodeURIComponent(spaceId)}/workspaces`, { rootPath, title: attachment.title }), [spaceId]);
      return;
    }
    const reference = localReferenceFromAttachment(attachment);
    if (reference === undefined) throw new Error("所选内容不能作为空间引用。");
    await runMutation(`add-local-file:${spaceId}:${attachment.ref}`, () => postJson(`/api/spaces/${encodeURIComponent(spaceId)}/references`, {
      title: attachment.title,
      reference,
    }), [spaceId]);
  }, [runMutation]);

  const addWorkspaceFolder = useCallback(async (spaceId: string): Promise<void> => {
    const directory = await selectTaskWorkspaceDirectory();
    if (directory === undefined) return;
    await runMutation(`add-workspace:${spaceId}:${directory}`, () => postJson(`/api/spaces/${encodeURIComponent(spaceId)}/workspaces`, {
      title: basename(directory),
      rootPath: directory,
    }), [spaceId]);
  }, [runMutation]);

  const addWebReference = useCallback(async (
    spaceId: string,
    title: string,
    url: string,
  ): Promise<void> => {
    await runMutation(`add-web:${spaceId}:${url}`, () => postJson(`/api/spaces/${encodeURIComponent(spaceId)}/references`, {
      title,
      reference: { kind: "web_page", url },
    }), [spaceId]);
  }, [runMutation]);

  const rename = useCallback(async (
    target: { readonly kind: "space" | "reference"; readonly id: string },
    title: string,
  ): Promise<void> => {
    const path = target.kind === "space"
      ? `/api/spaces/${encodeURIComponent(target.id)}/rename`
      : `/api/spaces/references/${encodeURIComponent(target.id)}/rename`;
    await runMutation(`rename:${target.kind}:${target.id}`, () => postJson(path, { title }));
  }, [runMutation]);

  const removeReference = useCallback(async (itemId: string): Promise<void> => {
    await runMutation(`remove-reference:${itemId}`, () => deleteJson(`/api/spaces/references/${encodeURIComponent(itemId)}`));
  }, [runMutation]);

  const unlinkReference = useCallback(async (itemId: string): Promise<void> => {
    await runMutation(`unlink-reference:${itemId}`, () => postJson(`/api/spaces/references/${encodeURIComponent(itemId)}/unlink`, {}));
  }, [runMutation]);

  const reconnectWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
    const directory = await selectTaskWorkspaceDirectory();
    if (directory === undefined) return;
    await runMutation(`reconnect-workspace:${workspaceId}`, () => postJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/reconnect`, { rootPath: directory }));
  }, [runMutation]);

  const openReference = useCallback(async (_spaceId: string, itemId: string): Promise<void> => {
    await postJson(`/api/spaces/references/${encodeURIComponent(itemId)}/open`, {});
  }, []);

  // 会话控制变更（置顶/重命名/删除）不经过 Space 命令，但会改变 owner read-model；
  // 由会话管理侧在成功后主动刷新对应空间。
  const refreshSpace = useCallback(async (spaceId: string): Promise<void> => {
    await refreshAffectedSpaces([spaceId]);
  }, [refreshAffectedSpaces]);

  return {
    spaces,
    createSpace,
    deleteSpace,
    createManagedFolder,
    addLocalFile,
    addWorkspaceFolder,
    addWebReference,
    rename,
    unlinkReference,
    reconnectWorkspace,
    removeReference,
    openReference,
    refresh,
    refreshSpace,
    loading,
    mutationPending: mutationPendingCount > 0,
    error,
  };
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException
    ? reason.name === "AbortError"
    : reason instanceof Error && reason.name === "AbortError";
}

function localReferenceFromAttachment(attachment: { readonly localSource?: ContextAttachment["localSource"] }):
  | { readonly kind: "local_file"; readonly path: string }
  | undefined {
  return attachment.localSource?.kind === "file"
    ? { kind: "local_file", path: attachment.localSource.path }
    : undefined;
}

function basename(value: string): string {
  const normalized = value.replace(/[\\/]+$/u, "");
  const segment = normalized.split(/[\\/]/u).at(-1)?.trim();
  return segment === undefined || segment.length === 0 ? "工作区文件夹" : segment;
}
