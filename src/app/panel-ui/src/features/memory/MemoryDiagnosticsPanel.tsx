import { useCallback, useEffect, useState } from "react";
import { fetchMemoryDiagnostics, type MemoryDiagnosticSnapshot } from "@panel-api/memory-admin";

export function MemoryDiagnosticsPanel(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<MemoryDiagnosticSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchMemoryDiagnostics();
      setSnapshot(response.diagnostics);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取记忆诊断");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <section className="settings-card memory-diagnostics" aria-busy={loading}>
      <div className="settings-card-title-row">
        <h3>记忆诊断</h3>
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "读取中" : "刷新"}
        </button>
      </div>
      {error !== null && <p className="memory-error" role="alert">{error}</p>}
      {snapshot === null ? (
        <p className="memory-hint">{error === null ? "正在加载…" : "诊断暂时不可用。"}</p>
      ) : (
        <>
          <div className="memory-diagnostics-grid">
            <DiagnosticValue label="排队" value={snapshot.jobs.queued} />
            <DiagnosticValue label="运行中" value={snapshot.jobs.running} />
            <DiagnosticValue label="已完成" value={snapshot.jobs.done} />
            <DiagnosticValue label="失败" value={snapshot.jobs.failed} />
            <DiagnosticValue label="Shadow wouldInject" value={snapshot.shadowWouldInject.length} />
            <DiagnosticValue label="Recall traces" value={snapshot.traces.length} />
          </div>
          <p className="memory-hint">
            仅展示结构化诊断；Retrieved、Injected 可观测，模型是否实际采用（Used）不可观测。
          </p>
          {snapshot.shadowWouldInject.length > 0 && (
            <ul className="memory-diagnostics-list">
              {snapshot.shadowWouldInject.slice(-5).reverse().map((entry) => (
                <li key={`${entry.recallId}-${entry.at}`}>
                  <code>{entry.ownerKey}</code>
                  <span>{entry.candidateRefs.length} 个候选</span>
                </li>
              ))}
            </ul>
          )}
          {snapshot.traces.length > 0 && (
            <ul className="memory-diagnostics-list">
              {snapshot.traces.slice(-5).reverse().map((trace) => (
                <li key={`${trace.recallId}-${trace.at}`}>
                  <code>{trace.outcome}</code>
                  <span>{trace.retrievedRefs.length} retrieved / {trace.injectedRefs.length} injected</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function DiagnosticValue(props: { readonly label: string; readonly value: number }): React.ReactElement {
  return (
    <div className="memory-diagnostic-value">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}
