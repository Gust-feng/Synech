import { useCallback, useEffect, useState } from "react";
import {
  fetchMemoryCapability,
  fetchMemoryDiagnostics,
  setMemoryRollout,
  type MemoryCapabilityStatus,
  type MemoryDiagnosticSnapshot,
  type MemoryRolloutMode,
} from "@panel-api/memory-admin";

export function MemoryDiagnosticsPanel(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<MemoryDiagnosticSnapshot | null>(null);
  const [capability, setCapability] = useState<MemoryCapabilityStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [response, capabilityResponse] = await Promise.all([
        fetchMemoryDiagnostics(),
        fetchMemoryCapability(),
      ]);
      setSnapshot(response.diagnostics);
      setCapability(capabilityResponse.status);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取记忆诊断");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const changeRollout = useCallback(async (rollout: MemoryRolloutMode) => {
    setLoading(true);
    try {
      await setMemoryRollout({ rollout });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法更新记忆 rollout");
      setLoading(false);
    }
  }, [refresh]);

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
          </div>
          <label className="memory-rollout-control">
            <span>开发者 rollout / kill switch</span>
            <select
              value={capability?.rollout ?? "off"}
              disabled={loading || capability === null}
              onChange={(event) => void changeRollout(event.target.value as MemoryRolloutMode)}
            >
              <option value="off">关闭（停止整理 / 注入）</option>
              <option value="shadow">Shadow（只整理评估，不注入）</option>
              <option value="active">Active（按用户许可与 Space 参与生效）</option>
            </select>
          </label>
          <p className="memory-hint">
            仅展示结构化诊断；Stored、Injected 可观测，模型是否实际采用（Used）不可观测；
            工具调用次数只是观察项。
          </p>
          {snapshot.recentOutcomes.length > 0 && (
            <ul className="memory-diagnostics-list">
              {snapshot.recentOutcomes.slice(0, 8).map((entry, index) => (
                <li key={`${entry.at}-${index}`}>
                  <code>{entry.outcome}</code>
                  <span>{entry.longTermUpdated ? "含长期修订" : "仅会话总结"}</span>
                  {entry.reason !== undefined && <span>{entry.reason}</span>}
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
