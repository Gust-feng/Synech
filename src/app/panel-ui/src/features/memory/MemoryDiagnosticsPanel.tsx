import { useEffect, useState } from "react";
import { setMemoryRollout, type MemoryDiagnosticContext, type MemoryDiagnosticJob, type MemoryDiagnosticSnapshot,
  type MemoryRolloutMode } from "@panel-api/memory-admin";
import type { MemorySettingsScope } from "./MemorySettingsPanel";
import { useMemoryDiagnostics } from "./use-memory-diagnostics";
import { MemoryHistoryProbe } from "./MemoryHistoryProbe";
import "./memory.css";
import "./memory-diagnostics.css";

const JOB_LABEL = { queued: "排队", running: "整理中", done: "已完成", failed: "失败" };
const WAIT_LABEL = { active_conversation: "会话仍在运行", policy_blocked: "策略未允许或来源不可用",
  retry_backoff: "等待退避重试", idle_delay: "等待空闲资格", ready: "已到期，等待工作线程" };
const BLOCK_LABEL: Record<string, string> = { global_consent: "全局自动记忆未开启", space_participation: "此 Space 未参与",
  rollout_off: "开发者总开关已关闭", generation_fence: "删除或清除正在阻断该范围" };
const OUTCOME_LABEL = { committed: "已发布", failed: "失败", retry_queued: "等待重试", no_evidence: "没有新增合格内容", discarded: "结果已丢弃" };
const BINDING_LABEL = { unbound: "尚未绑定", none: "已固定为空背景", available: "绑定版本当前可供给", unavailable: "绑定版本当前不可供给" };

export function MemoryDiagnosticsPanel(props: {
  readonly scope?: MemorySettingsScope | null;
  readonly onOpenConversation?: (id: string) => void;
  readonly onOpenMemorySettings?: () => void;
}): React.ReactElement {
  const currentSpace = props.scope?.owner?.kind === "space" ? props.scope.owner.id : undefined;
  const currentConversation = currentSpace === undefined ? undefined : props.scope?.conversationId;
  const [scopeChoice, setScopeChoice] = useState<"all" | "space" | "conversation">("all");
  const [selectedConversation, setSelectedConversation] = useState<string>();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    setScopeChoice(currentConversation ? "conversation" : currentSpace ? "space" : "all");
    setSelectedConversation(undefined);
  }, [currentSpace, currentConversation]);
  const query = {
    spaceId: scopeChoice === "all" ? undefined : currentSpace,
    conversationId: selectedConversation ?? (scopeChoice === "conversation" ? currentConversation : undefined),
  };
  const { snapshot, loading, error } = useMemoryDiagnostics(query, autoRefresh, refreshKey);
  const context = snapshot?.context;

  async function changeRollout(rollout: MemoryRolloutMode) {
    setBusy(true); setNotice(null);
    try { await setMemoryRollout({ rollout }); setRefreshKey(key => key + 1); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : "开关更新失败"); }
    finally { setBusy(false); }
  }
  async function copySnapshot(value: MemoryDiagnosticSnapshot) {
    const c = value.context;
    const safe = { ...value, context: c === null ? null : { ...c,
      memory: c.memory === null ? null : { ...c.memory, markdown: "[正文未复制]" },
      summary: c.summary === null ? null : { ...c.summary, markdown: "[正文未复制]" },
      binding: c.binding === null ? null : { ...c.binding, markdown: null },
    } };
    try { await navigator.clipboard.writeText(JSON.stringify(safe, null, 2)); setNotice("诊断已复制，未包含记忆和摘要正文。"); }
    catch { setNotice("复制失败，请检查剪贴板权限。"); }
  }

  return <section className="settings-card memory-diagnostics memory-debug" aria-busy={loading}>
    <div className="settings-card-title-row">
      <div><h3>记忆调试</h3><p className="memory-hint">检查整理进度、背景绑定和历史命中。</p></div>
      <button type="button" onClick={() => setRefreshKey(key => key + 1)} disabled={loading}>刷新</button>
    </div>
    <div className="memory-debug-toolbar">
      <label>查看范围 <select value={scopeChoice} onChange={event => {
        setScopeChoice(event.target.value as typeof scopeChoice); setSelectedConversation(undefined); setNotice(null);
      }}>
        <option value="all">全部任务</option><option value="space" disabled={!currentSpace}>当前 Space</option>
        <option value="conversation" disabled={!currentConversation}>当前会话</option>
      </select></label>
      <label className="memory-debug-toggle"><input type="checkbox" checked={autoRefresh} onChange={event => setAutoRefresh(event.target.checked)} />每 5 秒刷新</label>
      <button type="button" disabled={!snapshot} onClick={() => snapshot && void copySnapshot(snapshot)}>复制诊断</button>
    </div>
    {selectedConversation && <button className="memory-debug-back" type="button" onClick={() => setSelectedConversation(undefined)}>← 返回所选范围的任务列表</button>}
    {(notice || error) && <p className={error ? "memory-error" : "memory-hint"} role="status">{error ?? notice}</p>}
    {!snapshot ? <p className="memory-hint">{error ? "暂时无法读取诊断。" : "正在读取记忆状态…"}</p> : !snapshot.enabled ?
      <p className="memory-hint">此运行实例未装配记忆诊断。</p> : <>
      <div className="memory-diagnostics-grid">
        {(["queued", "running", "done", "failed"] as const).map(status => <div className="memory-diagnostic-value" key={status}>
          <span>{JOB_LABEL[status]}</span><strong>{snapshot.jobs[status]}</strong>
        </div>)}
      </div>
      <p className="memory-debug-meta">快照 {time(snapshot.generatedAt)} · 计数仅针对当前查看范围</p>
      <div className="memory-debug-policy">
        <label>开发者总开关 <select value={snapshot.capability?.rollout ?? "off"} disabled={busy || !snapshot.capability}
          onChange={event => void changeRollout(event.target.value as MemoryRolloutMode)}>
          <option value="off">关闭</option><option value="shadow">观察：整理但不注入</option><option value="active">启用：按用户许可供给</option>
        </select></label>
        <p className="memory-hint">此开关对所有 Space 生效，仍受全局自动记忆与各 Space 参与开关约束。</p>
        <p>全局自动记忆：{snapshot.capability?.globalConsent ? "已开启" : "未开启"}
          {context && <> · 当前 Space：{context.capability.spaceParticipation ? "已参与" : "未参与"}</>}</p>
        {context && <p className="memory-debug-state">{context.blockingReasons.length > 0
          ? context.blockingReasons.map(reason => BLOCK_LABEL[reason] ?? reason).join("；")
          : context.capability.effective === "shadow" ? "可整理；观察模式下不注入长期背景。" : "当前策略允许整理和背景供给。"}</p>}
        {props.onOpenMemorySettings && (!snapshot.capability?.globalConsent || (context && !context.capability.spaceParticipation)) &&
          <button type="button" onClick={props.onOpenMemorySettings}>打开记忆设置</button>}
      </div>

      {context && <ContextInspector context={context} onOpenConversation={props.onOpenConversation} />}
      <section className="memory-debug-section">
        <h4>整理任务 {snapshot.jobRowsTruncated && <small>· 显示最近 30 条，运行与失败优先</small>}</h4>
        {snapshot.jobRows.length === 0 ? <p className="memory-hint">此范围还没有整理任务。会话产生新内容并稳定结束、且记忆开关允许后，才会进入空闲等待。</p> :
          <div className="memory-debug-jobs">{snapshot.jobRows.map(job => <JobRow key={job.jobId} job={job}
            onInspect={() => setSelectedConversation(job.conversationId)} />)}</div>}
      </section>
      {context ? <MemoryHistoryProbe key={`${context.spaceId}:${context.conversation?.id ?? ""}`}
        spaceId={context.spaceId} conversationId={context.conversation?.id} onOpenConversation={props.onOpenConversation} /> :
        <p className="memory-hint">切换到当前 Space，或检查列表中的会话，即可查看文档并测试历史搜索。</p>}
      <section className="memory-debug-section">
        <h4>最近批次 <small>· 当前进程</small></h4>
        <p className="memory-hint">进程重启后记录清空；任务的持久状态仍在上方。这里不判断模型是否真正采用了记忆。</p>
        {snapshot.recentOutcomes.length === 0 ? <p className="memory-hint">当前进程尚无此范围的批次结果。</p> :
          <ol className="memory-debug-traces">{snapshot.recentOutcomes.slice(0, 12).map((entry, index) => <li key={`${entry.at}:${index}`}>
            <div><span>{OUTCOME_LABEL[entry.outcome]}</span><time>{time(entry.at)}</time>
              {entry.durationMs !== undefined && <span>{(entry.durationMs / 1000).toFixed(1)} 秒</span>}
              {entry.outcome === "committed" && <span>{entry.longTermUpdated ? "更新摘要与长期文档" : "更新会话摘要"}</span>}</div>
            {entry.reason && <code>{entry.reason}</code>}
            {entry.conversationId && <button type="button" onClick={() => setSelectedConversation(entry.conversationId)}>检查该会话</button>}
          </li>)}</ol>}
      </section>
      {snapshot.limits && <details className="memory-debug-section"><summary>运行参数</summary>
        <dl className="memory-debug-facts">
          <dt>空闲资格</dt><dd>{snapshot.limits.idleDelayMs / 1000} 秒</dd>
          <dt>请求配置预算</dt><dd>{snapshot.limits.requestTokens.toLocaleString()} tokens（含输出预留）</dd>
          <dt>输出预留</dt><dd>{snapshot.limits.outputReserveTokens.toLocaleString()} tokens</dd>
          <dt>长期文档 / 摘要</dt><dd>{snapshot.limits.memoryTokens.toLocaleString()} / {snapshot.limits.summaryTokens.toLocaleString()} tokens</dd>
        </dl>
      </details>}
    </>}
  </section>;
}

function ContextInspector(props: { readonly context: MemoryDiagnosticContext; readonly onOpenConversation?: (id: string) => void }) {
  const { context: c } = props;
  const binding = c.binding;
  return <section className="memory-debug-section">
    <div className="memory-debug-row-title"><h4>{c.conversation?.title ?? c.spaceTitle}</h4>
      {c.conversation && props.onOpenConversation && <button type="button" onClick={() => props.onOpenConversation?.(c.conversation!.id)}>打开会话</button>}</div>
    <p className="memory-debug-meta">{c.spaceTitle}{c.conversation ? ` · ${c.conversation.active ? "会话正在运行或排队" : "会话当前无运行任务"}` : " · Space 记忆"}</p>
    {binding && <div className="memory-debug-binding">
      <strong>{BINDING_LABEL[binding.state]}</strong>
      <p className="memory-hint">{binding.state === "none" ? "会话开始时绑定了空背景；后台产生新记忆不会自动换绑。"
        : binding.state === "unbound" ? "会话尚未选择背景，检查操作不会为它创建绑定。"
        : binding.state === "unavailable" ? "绑定版本已撤销或当前策略不允许供给，检查操作不会换成新版本。"
        : binding.differsFromHead ? "Space 已有新版本；本会话仍按固定绑定使用原版本。" : "绑定与当前文档一致；可供给不代表模型已经采用。"}</p>
      {binding.reference?.kind === "revision" && <p className="memory-debug-meta">绑定版本 {binding.reference.revision} · generation {binding.reference.generation} · {binding.reference.boundAt}</p>}
      {binding.markdown && <DocumentView title="查看绑定背景正文" markdown={binding.markdown} />}
    </div>}
    {c.memory ? <DocumentView title={`Space 长期文档 · 版本 ${c.memory.revision}`} markdown={c.memory.markdown}
      detail={`${c.memory.origin === "user_edit" ? "用户编辑" : "后台整理"} · ${time(c.memory.updatedAt)}`} /> : <p className="memory-hint">此 Space 还没有有效长期文档。</p>}
    {c.conversation && (c.summary ? <DocumentView title={`会话累计摘要 · 版本 ${c.summary.revision}`} markdown={c.summary.markdown}
      detail={`覆盖至第 ${c.summary.coveredThroughOrdinal} 轮 · ${time(c.summary.updatedAt)}`} /> : <p className="memory-hint">此会话还没有有效摘要。</p>)}
  </section>;
}

function DocumentView(props: { readonly title: string; readonly markdown: string; readonly detail?: string }) {
  return <details className="memory-debug-document"><summary>{props.title}</summary>
    {props.detail && <p className="memory-debug-meta">{props.detail}</p>}
    <pre>{props.markdown || "（空正文）"}</pre>
  </details>;
}

function JobRow({ job, onInspect }: { readonly job: MemoryDiagnosticJob; readonly onInspect: () => void }) {
  return <details className="memory-debug-job" data-status={job.status}>
    <summary><span className="memory-debug-job-status">{JOB_LABEL[job.status]}</span>
      <span className="memory-debug-job-title">{job.title}</span>
      <span className="memory-debug-meta">{job.waitReason ? WAIT_LABEL[job.waitReason] : time(job.updatedAt)}</span></summary>
    <dl className="memory-debug-facts">
      <dt>本任务目标</dt><dd>第 {job.requestedThrough} 轮</dd>
      <dt>会话处理进度</dt><dd>已处理至第 {job.processedThrough} 轮；排除至第 {job.excludedThrough} 轮</dd>
      {job.fragment && <><dt>分片位置</dt><dd>第 {job.fragment.ordinal} 轮 / 字符偏移 {job.fragment.end}</dd></>}
      <dt>可整理时间</dt><dd>{time(job.eligibleAt)}</dd>
      <dt>执行尝试</dt><dd>{job.attempt} 次{job.nextAttemptAt !== null && `；下次尝试 ${time(job.nextAttemptAt)}`}</dd>
      {job.lastFailure && <><dt>最近失败</dt><dd><code>{job.lastFailure}</code></dd></>}
      <dt>任务 / 范围</dt><dd><code>{job.jobId}<br />{job.ownerKey}</code></dd>
    </dl>
    <button type="button" onClick={onInspect}>检查会话记忆</button>
  </details>;
}

function time(value: number) { return new Date(value).toLocaleString(); }
