import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Brain, Pause, Plus, RefreshCw, Save, Trash2, TriangleAlert } from "lucide-react";
import { MemoryFeedback } from "./memory-feedback";
import { MemoryDocumentReader } from "./memory-document-reader";
import { clearMemory, fetchMemoryStatus, fetchMemoryView, setMemoryEnabled, updateMemory,
  MemoryApiError, type MemoryScope, type MemoryView, type MemoryCapabilityStatus,
  type MemoryEntryRevisionView, type MemorySourceView, type UpdateMemoryInput } from "@panel-api/memory-admin";
import "./memory.css";

export type MemorySettingsOwner = { readonly kind: "space"; readonly id: string };
export type MemorySettingsScope = { readonly owner?: MemorySettingsOwner; readonly conversationId?: string };
export type MemorySettingsPanelProps = {
  readonly scope: MemorySettingsScope | null;
  readonly onAfterChange?: () => void;
  readonly onOpenConversation?: (conversationId: string) => void;
};
type Draft = { readonly edit: UpdateMemoryInput["edit"]; readonly requestId: string };
const KIND_LABEL = { initial: "首次认识", supplement: "补充", change: "状态变化", correction: "纠正", withdrawal: "撤回" };
const ROLE_LABEL = { current: "当前认识", historical: "历史认识", withdrawn: "已撤回" };
const SOURCE_LABEL: Record<MemorySourceView["readback"], string> = {
  available: "可回看", deleted: "来源对话已删除；已发布认识保留，原文不可回看", superseded: "来源分支已替换；此修订仅作历史参考",
  temporarily_unavailable: "来源暂时不可读，请稍后重试", not_applicable: "用户编辑，无来源对话",
};

export function MemorySettingsPanel(props: MemorySettingsPanelProps): React.ReactElement {
  const kind = props.scope?.owner?.kind;
  const id = props.scope?.owner?.id;
  const owner = kind === undefined || id === undefined ? undefined : { kind, id };
  const [status, setStatus] = useState<MemoryCapabilityStatus | null>(null);
  const [view, setView] = useState<MemoryView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editAuthority, setEditAuthority] = useState<MemoryEntryRevisionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [clearScope, setClearScope] = useState<MemoryScope | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const epoch = useRef(0);
  const readEpoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async (generation: number, cursor?: string): Promise<boolean> => {
    const serial = ++readEpoch.current;
    controller.current?.abort();
    const pending = new AbortController(); controller.current = pending; setLoading(true);
    try {
      const [s, v] = await Promise.all([
        fetchMemoryStatus(kind === undefined || id === undefined ? {} : { owner: { kind, id } }, pending.signal),
        kind === undefined || id === undefined ? Promise.resolve(undefined)
          : fetchMemoryView({ owner: { kind, id }, ...(cursor === undefined ? {} : { cursor }) }, pending.signal),
      ]);
      if (pending.signal.aborted || generation !== epoch.current || serial !== readEpoch.current) return false;
      setStatus(s.status);
      setView(previous => v === undefined ? null : cursor === undefined || previous === null ? v.view
        : { ...v.view, entries: [...previous.entries, ...v.view.entries] });
      return true;
    } catch (cause) {
      if (!pending.signal.aborted && generation === epoch.current && serial === readEpoch.current) {
        setError(cause instanceof Error ? cause.message : "无法读取记忆");
      }
      return false;
    } finally { if (generation === epoch.current && serial === readEpoch.current) setLoading(false); }
  }, [kind, id]);
  useEffect(() => {
    const generation = ++epoch.current;
    setStatus(null); setView(null); setDraft(null); setEditAuthority(null); setError(null);
    setClearScope(null); setHistoryId(null); setBusy(false);
    void refresh(generation);
    return () => { controller.current?.abort(); ++readEpoch.current; ++epoch.current; };
  }, [refresh]);

  async function mutate(operation: () => Promise<unknown>, savedDraft?: Draft) {
    const generation = epoch.current;
    setBusy(true); setError(null);
    try {
      await operation();
      if (generation !== epoch.current) return;
      if (savedDraft !== undefined) setDraft(current => current === savedDraft ? null : current);
      setClearScope(null);
      await refresh(generation);
      if (generation === epoch.current) props.onAfterChange?.();
    } catch (cause) {
      if (generation !== epoch.current) return;
      const message = cause instanceof MemoryApiError && cause.code === "memory_revision_stale"
        ? "条目已有新修订。草稿已保留；请查看权威版本，确认后再采用新版本提交。"
        : cause instanceof Error ? cause.message : "操作失败";
      // Refresh authority on every failed mutation; keep draft and its original CAS/requestId.
      await refresh(generation);
      if (generation !== epoch.current) return;
      if (savedDraft?.edit.operation === "revise" && owner !== undefined) {
        try {
          const authoritative = await fetchMemoryView({ owner, entryId: savedDraft.edit.entryId, limit: 1 });
          if (generation !== epoch.current) return;
          setEditAuthority(authoritative.view.entries[0] ?? null);
        } catch (refreshCause) {
          if (generation === epoch.current) setError(`${message} 权威修订读取失败：${refreshCause instanceof Error ? refreshCause.message : "请稍后刷新"}`);
          return;
        }
      }
      if (generation === epoch.current) setError(message);
    } finally { if (generation === epoch.current) setBusy(false); }
  }
  function begin(item?: MemoryEntryRevisionView, withdrawal = false) {
    setError(null); setEditAuthority(item ?? null);
    const content = item?.revision;
    const base = { markdown: withdrawal ? "" : content?.markdown ?? "", applicability: content?.applicability ?? null,
      occurredAt: content?.occurredAt ?? null, reason: null, topicIds: content?.topicIds ?? [], related: [] };
    setDraft({ requestId: crypto.randomUUID(), edit: item === undefined
      ? { ...base, operation: "create", entryId: crypto.randomUUID(), expectedRevisionId: null, kind: "initial", retractsRevisionIds: [] }
      : { ...base, operation: "revise", entryId: item.entry.entryId, expectedRevisionId: item.entry.headRevisionId,
        kind: withdrawal ? "withdrawal" : "supplement", retractsRevisionIds: withdrawal ? [item.entry.headRevisionId] : [] } });
  }
  function changeDraft(edit: UpdateMemoryInput["edit"]) { setDraft({ edit, requestId: crypto.randomUUID() }); }
  const disabled = busy || loading;
  const pageAuthority = draft?.edit.operation === "revise" ? view?.entries.find(item => item.entry.entryId === draft.edit.entryId) : undefined;
  const authoritative = draft?.edit.operation === "revise" && editAuthority?.entry.entryId === draft.edit.entryId
    && (pageAuthority === undefined || editAuthority.revision.revision >= pageAuthority.revision.revision)
    ? editAuthority : pageAuthority;
  const stale = draft?.edit.operation === "revise" && authoritative !== undefined && authoritative.entry.headRevisionId !== draft.edit.expectedRevisionId;
  if (status === null) return <section className="memory-settings" aria-busy={loading}>
    {error ? <MemoryFeedback kind="error">{error}</MemoryFeedback> : <p className="memory-hint">正在读取记忆…</p>}
    <button className="memory-button" disabled={loading} onClick={() => void refresh(epoch.current)}>重新加载</button>
  </section>;
  return <section className="memory-settings" aria-busy={disabled}>
    <div className="memory-control-row">
      <div className="memory-control-title"><Brain size={16} strokeWidth={1.8} aria-hidden="true" /><span>记忆</span></div>
      <div className="memory-control-actions">
        {status.hasContent && <button type="button" className="memory-icon-button" aria-label="清空记忆" title="清空记忆"
          disabled={disabled || draft !== null || clearScope !== null} onClick={() => setClearScope(owner ?? { kind: "global" })}><Trash2 size={15} aria-hidden="true" /></button>}
        <label className="memory-switch">
          <input id="memory-enabled" type="checkbox" role="switch" aria-label="启用记忆" checked={status.enabled}
            disabled={disabled || draft !== null || clearScope !== null} onChange={event => void mutate(() => setMemoryEnabled({ enabled: event.target.checked }))} /><span aria-hidden="true" />
        </label>
      </div>
    </div>
    {owner === undefined && <MemoryStateVisual enabled={status.enabled} health={status.health} busy={disabled} />}
    {owner && view && <>
      <section className="memory-document">
        <header className="memory-document-header"><h3>{owner.kind === "space" ? "当前空间" : "当前工作区"}记忆概览 <small className="memory-inline-meta">只读</small></h3>
          <button className="memory-icon-button" aria-label="刷新记忆" disabled={disabled} onClick={() => void refresh(epoch.current)}><RefreshCw size={15} /></button></header>
        {view.document?.markdown.trim()
          ? <MemoryDocumentReader content={view.document.markdown} emptyTitle="暂无记忆概览" />
          : <MemoryStateVisual enabled={status.enabled} health={status.health} busy={disabled} />}
        {view.document && <p className="memory-editor-caption">概览版本 {view.document.revision} · {new Date(view.document.updatedAt).toLocaleString()}；条目修订可晚于此快照。</p>}
      </section>
      <section className="memory-entry-list">
        <header className="memory-document-header"><h3>记忆条目</h3><button className="memory-button" disabled={disabled || draft !== null} onClick={() => begin()}><Plus size={14} />添加条目</button></header>
        {view.entries.length === 0 && <p className="memory-hint">暂无条目，可以添加一条认识。</p>}
        {view.entries.map(item => <article className="memory-entry" key={item.entry.entryId}>
          <EntryRevision item={item} onOpenConversation={props.onOpenConversation} />
          <div className="memory-editor-actions">
            <button className="memory-button" disabled={disabled || draft !== null} onClick={() => begin(item)}>修订</button>
            <button className="memory-button memory-button-quiet" disabled={disabled || draft !== null || item.role === "withdrawn"} onClick={() => begin(item, true)}>撤回</button>
            <button className="memory-button memory-button-quiet" disabled={disabled} onClick={() => setHistoryId(value => value === item.entry.entryId ? null : item.entry.entryId)}>修订历史</button>
          </div>
          {historyId === item.entry.entryId && <EntryHistory key={`${item.entry.entryId}:${item.entry.headRevisionId}`} owner={owner} entryId={item.entry.entryId} onOpenConversation={props.onOpenConversation} />}
        </article>)}
        {view.nextCursor && <button className="memory-button" disabled={disabled} onClick={() => void refresh(epoch.current, view.nextCursor!)}>加载更多条目</button>}
      </section>
      {draft && <section className="memory-entry-editor" aria-label="编辑记忆条目">
        <h3>{draft.edit.operation === "create" ? "添加条目" : "修订条目"}</h3>
        {draft.edit.operation === "revise" && <label>修订类型 <select value={draft.edit.kind} disabled={disabled} onChange={event => {
          const edit = draft.edit; if (edit.operation !== "revise") return;
          const revisionKind = event.target.value as typeof edit.kind;
          changeDraft({ ...edit, kind: revisionKind, retractsRevisionIds: revisionKind === "correction" || revisionKind === "withdrawal" ? [edit.expectedRevisionId] : [] });
        }}>{(["supplement", "change", "correction", "withdrawal"] as const).map(value => <option value={value} key={value}>{KIND_LABEL[value]}</option>)}</select></label>}
        <label>正文<textarea className="memory-document-input" value={draft.edit.markdown} disabled={disabled} onChange={event => changeDraft({ ...draft.edit, markdown: event.target.value })} /></label>
        <label>适用范围（可选）<input value={draft.edit.applicability ?? ""} disabled={disabled} onChange={event => changeDraft({ ...draft.edit, applicability: event.target.value || null })} /></label>
        <label>事实发生时间（未知可留空）<input value={draft.edit.occurredAt ?? ""} disabled={disabled} onChange={event => changeDraft({ ...draft.edit, occurredAt: event.target.value || null })} /></label>
        <label>变化原因（可选）<input value={draft.edit.reason ?? ""} disabled={disabled} onChange={event => changeDraft({ ...draft.edit, reason: event.target.value || null })} /></label>
        {view.topics.length > 0 && <fieldset className="memory-topic-options"><legend>主题</legend>{view.topics.map(topic => <label key={topic.topicId}><input type="checkbox" disabled={disabled} checked={draft.edit.topicIds.includes(topic.topicId)}
          onChange={event => changeDraft({ ...draft.edit, topicIds: event.target.checked ? [...draft.edit.topicIds, topic.topicId] : draft.edit.topicIds.filter(id => id !== topic.topicId) })} />{topic.name}</label>)}</fieldset>}
        {draft.edit.kind === "correction" && <p className="memory-hint">纠正将撤销所选修订及引用它们的旧概览供给，保留历史记录。</p>}
        {draft.edit.kind === "withdrawal" && <p className="memory-hint">撤回指定修订并保留历史；后续新证据仍可能形成认识。永久清空请使用清空记忆。</p>}
        {draft.edit.operation === "revise" && (draft.edit.kind === "correction" || draft.edit.kind === "withdrawal") && <>
          <p className="memory-hint">选择明确受影响的修订；未选版本不会被自动认定为错误。</p>
          <EntryHistory owner={owner} entryId={draft.edit.entryId} selected={draft.edit.retractsRevisionIds} disabled={disabled}
            onSelect={revisionId => { if (draft.edit.operation !== "revise") return;
              changeDraft({ ...draft.edit, retractsRevisionIds: draft.edit.retractsRevisionIds.includes(revisionId)
                ? draft.edit.retractsRevisionIds.filter(id => id !== revisionId) : [...draft.edit.retractsRevisionIds, revisionId] });
            }} onOpenConversation={props.onOpenConversation} />
        </>}
        {stale && authoritative && <MemoryFeedback kind="warning">当前权威版本为 {authoritative.revision.revision}。<button className="memory-text-button" disabled={disabled} onClick={() => {
          if (draft.edit.operation !== "revise") return;
          const head = authoritative.entry.headRevisionId;
          changeDraft({ ...draft.edit, expectedRevisionId: head });
        }}>保留草稿，采用新版本作为提交基准</button></MemoryFeedback>}
        <div className="memory-editor-actions"><button className="memory-button" disabled={disabled} onClick={() => setDraft(null)}>取消</button>
          <button className="memory-button memory-button-primary" disabled={disabled || stale || (draft.edit.kind !== "withdrawal" && !draft.edit.markdown.trim()) || ((draft.edit.kind === "correction" || draft.edit.kind === "withdrawal") && draft.edit.retractsRevisionIds.length === 0)} onClick={() => void mutate(() => updateMemory({ owner, ...draft }), draft)}><Save size={14} />{draft.edit.kind === "withdrawal" ? "确认撤回" : "保存"}</button></div>
      </section>}
    </>}
    {error && <MemoryFeedback kind="error" dismissAfterMs={8_000}>{error}</MemoryFeedback>}
    {clearScope && <MemoryClearDialog busy={disabled} error={error} onCancel={() => setClearScope(null)} onConfirm={() => void mutate(() => clearMemory({ scope: clearScope }))} />}
  </section>;
}

function MemoryStateVisual(props: {
  readonly enabled: boolean;
  readonly health: MemoryCapabilityStatus["health"];
  readonly busy: boolean;
}): React.ReactElement {
  const state = props.busy ? "updating" : !props.enabled ? "disabled" : props.health !== "ready" ? "attention" : "enabled";
  const label = state === "updating" ? "正在更新记忆" : state === "enabled" ? "记忆已启用" : state === "disabled" ? "记忆已关闭" : "记忆服务状态异常";
  const StatusIcon = state === "updating" ? RefreshCw : state === "disabled" ? Pause : state === "attention" ? TriangleAlert : undefined;
  return <div className="memory-state-scene" data-state={state} role="img" aria-label={label}>
    <div className="memory-folio" aria-hidden="true">
      <div className="memory-folio__leaf memory-folio__leaf--first"><span /><span /></div>
      <div className="memory-folio__leaf memory-folio__leaf--second"><span /><span /></div>
      <div className="memory-folio__cover">
        <span className="memory-folio__binding" />
        <span className="memory-folio__bookmark" />
        <div className="memory-folio__imprint"><Brain size={28} strokeWidth={1.3} /></div>
        <span className="memory-folio__signature">
          {StatusIcon ? <StatusIcon size={12} strokeWidth={1.65} /> : <><span /><span /></>}
        </span>
      </div>
    </div>
  </div>;
}

function EntryRevision({ item, onOpenConversation }: { readonly item: MemoryEntryRevisionView; readonly onOpenConversation?: (id: string) => void }) {
  const r = item.revision;
  return <>
    <p className="memory-entry-meta">{ROLE_LABEL[item.role]} · {KIND_LABEL[r.kind]} · 修订 {r.revision} · {r.origin === "user_edit" ? "用户编辑" : "后台整理"}
      {item.currentRevisionId === null ? " · 当前无可供给修订" : item.currentRevisionId !== r.revisionId ? " · 已有其他当前修订" : ""}</p>
    <MemoryDocumentReader content={r.markdown} emptyTitle={r.kind === "withdrawal" ? "此修订已撤回" : "空正文"} />
    <p className="memory-editor-caption">发生：{r.occurredAt ?? "未知"} · 报告：{new Date(r.reportedAt).toLocaleString()} · 发布：{new Date(r.publishedAt).toLocaleString()}</p>
    {r.applicability && <p className="memory-hint">适用范围：{r.applicability}</p>}
    {r.reason && <p className="memory-hint">原因：{r.reason.text}</p>}
    <details className="memory-record-details"><summary>来源 · {item.sources.length}</summary><ul className="memory-source-list">
      {item.sources.map(source => <li key={source.sourceId}><div>
        {source.locator.kind === "user_edit" ? <span>用户编辑</span> : <>
          <span>来源对话 {source.locator.conversationId} · 轮次 {source.locator.fromOrdinal}–{source.locator.toOrdinal}</span>
          {source.lifecycle !== "deleted" && source.readback === "available" && onOpenConversation && <button className="memory-source-link" onClick={() => { if (source.locator.kind === "conversation_range") onOpenConversation(source.locator.conversationId); }}>打开来源对话</button>}
        </>}
        <small>{source.lifecycle === "deleted" ? SOURCE_LABEL.deleted : SOURCE_LABEL[source.readback]}{source.branch === "superseded" && source.readback !== "superseded" ? "；来源分支已替换" : ""}</small>
      </div></li>)}
    </ul></details>
  </>;
}

function EntryHistory(props: { readonly owner: MemorySettingsOwner; readonly entryId: string; readonly onOpenConversation?: (id: string) => void;
  readonly selected?: readonly string[]; readonly disabled?: boolean; readonly onSelect?: (revisionId: string) => void }) {
  const [items, setItems] = useState<readonly MemoryEntryRevisionView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async (next?: string) => {
    request.current?.abort(); const pending = new AbortController(); request.current = pending; setBusy(true);
    try {
      const response = await fetchMemoryView({ owner: props.owner, entryId: props.entryId, limit: 10, ...(next === undefined ? {} : { cursor: next }) }, pending.signal);
      if (pending.signal.aborted) return;
      setItems(previous => next === undefined ? response.view.entries : [...previous, ...response.view.entries]); setCursor(response.view.nextCursor); setError(null);
    } catch (cause) { if (!pending.signal.aborted) setError(cause instanceof Error ? cause.message : "历史读取失败"); }
    finally { if (!pending.signal.aborted) setBusy(false); }
  }, [props.owner.kind, props.owner.id, props.entryId]);
  useEffect(() => { void load(); return () => request.current?.abort(); }, [load]);
  return <section className="memory-entry-history" aria-label="修订历史" aria-busy={busy}>
    <p className="memory-hint">历史修订记录过去的认识；状态变化不表示过去内容错误，纠正与撤回会停止相应版本供给。</p>
    {items.map(item => <div key={item.revision.revisionId}>
      {props.onSelect && <label className="memory-retraction-choice"><input type="checkbox" disabled={props.disabled} checked={props.selected?.includes(item.revision.revisionId) ?? false}
        onChange={() => props.onSelect?.(item.revision.revisionId)} />撤销修订 {item.revision.revision} 的供给{item.supplyState === "revoked" ? "（已撤销）" : ""}</label>}
      <details><summary>修订 {item.revision.revision} · {KIND_LABEL[item.revision.kind]} · {ROLE_LABEL[item.role]}</summary><EntryRevision item={item} onOpenConversation={props.onOpenConversation} /></details>
    </div>)}
    {error && <MemoryFeedback kind="error" dismissAfterMs={8_000}>{error}</MemoryFeedback>}
    {error && <button className="memory-button" disabled={busy} onClick={() => void load()}>重新读取历史</button>}
    {cursor && <button className="memory-button" disabled={busy} onClick={() => void load(cursor)}>加载更多修订</button>}
  </section>;
}

function MemoryClearDialog(props: { readonly busy: boolean; readonly error: string | null; readonly onCancel: () => void; readonly onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null); const title = useId();
  useLayoutEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className="memory-clear-dialog" aria-labelledby={title} onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!props.busy) props.onCancel(); }}>
    <h3 id={title}>确定清空记忆？</h3><p className="memory-hint">删除此范围内条目、修订、来源和概览；清除前的对话不会重新回填。记忆开关保持不变。</p>
    {props.error && <MemoryFeedback kind="error" dismissAfterMs={8_000}>{props.error}</MemoryFeedback>}
    <div className="memory-editor-actions"><button className="memory-button" autoFocus disabled={props.busy} onClick={props.onCancel}>取消</button><button className="memory-button memory-button-danger" disabled={props.busy} onClick={props.onConfirm}>清空</button></div>
  </dialog>;
}
