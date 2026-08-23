import React, { useSyncExternalStore } from 'react'
import { Activity, Trash2 } from 'lucide-react'
import {
  clearResponsivenessIncidents,
  getResponsivenessIncidents,
  subscribeResponsivenessIncidents,
} from '../app-responsiveness-diagnostics'
import './responsiveness-diagnostics.css'

export function ResponsivenessDiagnostics(): React.ReactElement {
  const incidents = useSyncExternalStore(
    subscribeResponsivenessIncidents,
    getResponsivenessIncidents,
    getResponsivenessIncidents,
  )
  const worstDuration = incidents.reduce((maximum, incident) => Math.max(maximum, incident.durationMs), 0)

  return (
    <section className="responsiveness-diagnostics" aria-label="界面响应诊断">
      <header>
        <div>
          <Activity size={16} />
          <h3>界面响应</h3>
        </div>
        {incidents.length > 0 && (
          <button type="button" onClick={clearResponsivenessIncidents} aria-label="清空界面响应记录">
            <Trash2 size={14} />
          </button>
        )}
      </header>
      <div className="responsiveness-diagnostics__summary">
        <span><strong>{incidents.length}</strong>次长任务</span>
        <span><strong>{worstDuration}</strong>ms 最长阻塞</span>
      </div>
      {incidents.length === 0 ? (
        <p className="responsiveness-diagnostics__empty">当前没有检测到超过 100ms 的界面阻塞。</p>
      ) : (
        <ol>
          {incidents.slice(0, 10).map((incident) => (
            <li key={incident.id}>
              <span>{incident.context}</span>
              <strong>{incident.durationMs}ms</strong>
              <time dateTime={incident.occurredAt}>{formatIncidentTime(incident.occurredAt)}</time>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function formatIncidentTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}