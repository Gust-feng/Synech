import { useEffect, useState } from "react";
import { fetchMemoryDiagnostics, type MemoryDiagnosticQuery, type MemoryDiagnosticSnapshot } from "@panel-api/memory-admin";

export function useMemoryDiagnostics(query: MemoryDiagnosticQuery, autoRefresh: boolean, refreshKey: number) {
  const ownerKind = query.owner?.kind;
  const ownerId = query.owner?.id;
  const { conversationId } = query;
  const [snapshot, setSnapshot] = useState<MemoryDiagnosticSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSnapshot(null);
    setError(null);
    async function refresh() {
      if (controller.signal.aborted) return;
      setLoading(true);
      try {
        const response = await fetchMemoryDiagnostics({
          ...(ownerKind === undefined || ownerId === undefined ? {} : { owner: { kind: ownerKind, id: ownerId } }),
          ...(conversationId === undefined ? {} : { conversationId }),
        }, controller.signal);
        if (!controller.signal.aborted) { setSnapshot(response.diagnostics); setError(null); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "诊断读取失败");
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (autoRefresh) timer = setTimeout(tick, 5000);
        }
      }
    }
    function tick() {
      if (document.hidden) timer = setTimeout(tick, 5000);
      else void refresh();
    }
    void refresh();
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [ownerId, ownerKind, conversationId, autoRefresh, refreshKey]);
  return { snapshot, error, loading };
}