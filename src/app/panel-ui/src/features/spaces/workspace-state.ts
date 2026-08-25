import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { selectTaskWorkspaceDirectory } from "./workspace-selection";
import type { PersonalWorkspaceProjection } from "../../personal-workbench/workspace";
import { subscribeWorkbenchProjectionChanges } from "../../workbench/projection-changes";
import {
  createIdleAsyncRequestState,
  failAsyncRequest,
  resolveAsyncRequest,
  settleAsyncRequest,
  startAsyncRequest,
  type AsyncRequestState,
} from "../../workbench/async-request-state";

const workspaceSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["available", "disconnected", "deleting"]),
  currentMount: z.object({
    rootPath: z.string(),
  }).optional(),
  visibility: z.enum(["listed", "implicit"]),
});

const workspacesResponseSchema = z.object({
  ok: z.literal(true),
  workspaces: z.array(workspaceSummarySchema),
});

export type WorkspaceProjectionState = {
  readonly workspaces: readonly PersonalWorkspaceProjection[];
  readonly loading: boolean;
  readonly mutationPending: boolean;
  readonly error?: string;
  readonly refresh: () => Promise<void>;
  readonly addWorkspace: () => Promise<void>;
  /** 仅移出侧栏；Workspace 身份、外部文件、Space 引用和历史对话全部保留。 */
  readonly hideWorkspace: (workspaceId: string) => Promise<void>;
  readonly reconnectWorkspace: (workspaceId: string) => Promise<void>;
};

export function useWorkspaceProjection(enabled: boolean): WorkspaceProjectionState {
  const [requestState, setRequestState] = useState<AsyncRequestState<readonly PersonalWorkspaceProjection[], string>>(
    createIdleAsyncRequestState,
  );
  const [mutationPending, setMutationPending] = useState(false);
  const refreshAbortRef = useRef<AbortController | undefined>(undefined);
  const refreshEpochRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const epoch = ++refreshEpochRef.current;
    refreshAbortRef.current?.abort();
    const abortController = new AbortController();
    refreshAbortRef.current = abortController;
    setRequestState(startAsyncRequest);
    try {
      const response = await fetch("/api/workspaces", {
        signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = workspacesResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("工作区数据无效。");
      if (epoch !== refreshEpochRef.current) return;
      const workspaces = parsed.data.workspaces.map((workspace) => ({
        workspaceId: workspace.id,
        title: workspace.title,
        status: workspace.status,
        rootPath: workspace.currentMount?.rootPath,
      }));
      setRequestState(resolveAsyncRequest(workspaces));
    } catch (requestError) {
      if (epoch !== refreshEpochRef.current || isAbortError(requestError)) return;
      setRequestState((current) => failAsyncRequest(current, workspaceErrorText(requestError, "加载工作区失败。")));
    } finally {
      if (epoch === refreshEpochRef.current) {
        if (refreshAbortRef.current === abortController) refreshAbortRef.current = undefined;
      }
    }
  }, [enabled]);

  const addWorkspace = useCallback(async () => {
    if (!enabled || mutationPending) return;
    setMutationPending(true);
    try {
      const directory = await selectTaskWorkspaceDirectory();
      if (directory === undefined) return;
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rootPath: directory }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      }
      await refresh();
    } catch (requestError) {
      setRequestState((current) => failAsyncRequest(current, workspaceErrorText(requestError, "添加工作区失败。")));
    } finally {
      setMutationPending(false);
    }
  }, [enabled, mutationPending, refresh]);

  const hideWorkspace = useCallback(async (workspaceId: string) => {
    if (!enabled || mutationPending) return;
    setMutationPending(true);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility: "implicit" }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      }
      await refresh();
    } catch (requestError) {
      setRequestState((current) => failAsyncRequest(current, workspaceErrorText(requestError, "移除工作区失败。")));
    } finally {
      setMutationPending(false);
    }
  }, [enabled, mutationPending, refresh]);

  const reconnectWorkspace = useCallback(async (workspaceId: string) => {
    if (!enabled || mutationPending) return;
    const directory = await selectTaskWorkspaceDirectory();
    if (directory === undefined) return;
    setMutationPending(true);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/reconnect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rootPath: directory }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      }
      await refresh();
    } catch (requestError) {
      setRequestState((current) => failAsyncRequest(current, workspaceErrorText(requestError, "重新连接工作区失败。")));
    } finally {
      setMutationPending(false);
    }
  }, [enabled, mutationPending, refresh]);

  useEffect(() => {
    if (!enabled) {
      refreshEpochRef.current += 1;
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = undefined;
      setRequestState((current) => settleAsyncRequest(current));
      return;
    }
    void refresh();
    return () => {
      refreshEpochRef.current += 1;
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = undefined;
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeWorkbenchProjectionChanges((change) => {
      if (change.owners.includes("workspaces")) void refresh();
    });
  }, [enabled, refresh]);

  return {
    workspaces: requestState.data ?? [],
    loading: requestState.status === "loading" || requestState.status === "refreshing",
    mutationPending,
    error: requestState.status === "error" ? requestState.error : undefined,
    refresh,
    addWorkspace,
    hideWorkspace,
    reconnectWorkspace,
  };
}

function workspaceErrorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}
