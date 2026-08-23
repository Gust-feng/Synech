import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { selectTaskWorkspaceDirectory } from "./app-workspace-selection";
import type { PersonalWorkspaceProjection } from "./personal-workbench/workspace";

const workspaceSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["available", "disconnected", "deleting"]),
  currentMount: z.object({
    rootPath: z.string(),
  }).optional(),
  linkCount: z.number(),
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
  /** 移除工作区登记：外部文件夹与知识副本保留，直属对话按删除流程收口。 */
  readonly deleteWorkspace: (workspaceId: string) => Promise<void>;
};

export function useWorkspaceProjection(enabled: boolean): WorkspaceProjectionState {
  const [workspaces, setWorkspaces] = useState<readonly PersonalWorkspaceProjection[]>([]);
  const [loading, setLoading] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const refreshAbortRef = useRef<AbortController | undefined>(undefined);
  const refreshEpochRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const epoch = ++refreshEpochRef.current;
    refreshAbortRef.current?.abort();
    const abortController = new AbortController();
    refreshAbortRef.current = abortController;
    setLoading(true);
    try {
      const response = await fetch("/api/workspaces", {
        signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = workspacesResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("工作区数据无效。");
      if (epoch !== refreshEpochRef.current) return;
      setWorkspaces(parsed.data.workspaces.map((workspace) => ({
        workspaceId: workspace.id,
        title: workspace.title,
        status: workspace.status,
        rootPath: workspace.currentMount?.rootPath,
        linkCount: workspace.linkCount,
      })));
      setError(undefined);
    } catch (requestError) {
      if (epoch !== refreshEpochRef.current || isAbortError(requestError)) return;
      setError(workspaceErrorText(requestError, "加载工作区失败。"));
    } finally {
      if (epoch === refreshEpochRef.current) {
        setLoading(false);
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
      setError(undefined);
      await refresh();
    } catch (requestError) {
      setError(workspaceErrorText(requestError, "添加工作区失败。"));
    } finally {
      setMutationPending(false);
    }
  }, [enabled, mutationPending, refresh]);

  const deleteWorkspace = useCallback(async (workspaceId: string) => {
    if (!enabled || mutationPending) return;
    setMutationPending(true);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      }
      setError(undefined);
      await refresh();
    } catch (requestError) {
      setError(workspaceErrorText(requestError, "移除工作区失败。"));
    } finally {
      setMutationPending(false);
    }
  }, [enabled, mutationPending, refresh]);

  useEffect(() => {
    if (!enabled) {
      refreshEpochRef.current += 1;
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = undefined;
      setLoading(false);
      return;
    }
    void refresh();
    return () => {
      refreshEpochRef.current += 1;
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = undefined;
    };
  }, [enabled, refresh]);

  return { workspaces, loading, mutationPending, error, refresh, addWorkspace, deleteWorkspace };
}

function workspaceErrorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}
