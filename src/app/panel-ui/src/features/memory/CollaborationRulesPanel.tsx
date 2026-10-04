import { useCallback, useEffect, useId, useRef, useState } from "react";
import { RefreshCw, Save, Trash2 } from "lucide-react";
import { MemoryFeedback } from "./memory-feedback";
import {
  fetchCollaborationRules,
  saveCollaborationRules,
  type CollaborationRuleScope,
  type CollaborationRulesDocument,
} from "@panel-api/collaboration-rules";
import type { MemorySettingsScope } from "./MemorySettingsPanel";
import "./memory.css";

const GLOBAL_SCOPE = { kind: "global" } as const;

export function CollaborationRulesPanel(props: { readonly scope: MemorySettingsScope | null }): React.ReactElement {
  const scopeControlId = useId();
  const ownerScope = props.scope?.owner;
  const [selection, setSelection] = useState<"global" | "owner">("owner");
  const active = ownerScope === undefined ? "global" : selection;
  return <section className="memory-settings memory-rules-panel">
    {ownerScope !== undefined && <fieldset className="memory-rule-scopes">
      <legend className="memory-sr-only">规则适用范围</legend>
      <label><input type="radio" name={scopeControlId} checked={active === "owner"} onChange={() => setSelection("owner")} /><span>{ownerScope.kind === "space" ? "当前空间" : "当前工作区"}</span></label>
      <label><input type="radio" name={scopeControlId} checked={active === "global"} onChange={() => setSelection("global")} /><span>全部空间与工作区</span></label>
    </fieldset>}
    <div className="memory-rule-slot" hidden={active !== "global"}>
      <RuleEditor key="global" title="全局规则" scope={GLOBAL_SCOPE} />
    </div>
    {ownerScope !== undefined && <div className="memory-rule-slot" hidden={active !== "owner"}>
          <RuleEditor key={ownerScope.kind + ":" + ownerScope.id} title={ownerScope.kind === "space" ? "空间规则" : "工作区规则"} scope={ownerScope} />
        </div>}
  </section>;
}

function RuleEditor(props: { readonly title: string; readonly scope: CollaborationRuleScope }): React.ReactElement {
  const editorId = useId();
  const scopeKind = props.scope.kind;
  const scopeId = props.scope.kind === "global" ? undefined : props.scope.id;
  // 调用方每次渲染都可能新建 scope 对象，回调用字符串键重建请求范围，避免依赖对象身份。
  const requestScope = useCallback((): CollaborationRuleScope =>
    scopeKind === "global" ? { kind: "global" } : { kind: scopeKind, id: scopeId! }, [scopeId, scopeKind]);
  const [document, setDocument] = useState<CollaborationRulesDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const epochRef = useRef(0);

  const load = useCallback(async (epoch: number, signal: AbortSignal) => {
    setBusy(true);
    try {
      const next = await fetchCollaborationRules(requestScope(), signal);
      if (signal.aborted || epochRef.current !== epoch) return;
      setDocument(next);
      setDraft(next.content);
      setError(null);
      setNotice(null);
      setConfirmClear(false);
    } catch (cause) {
      if (!signal.aborted && epochRef.current === epoch) {
        setError(cause instanceof Error ? cause.message : "无法读取协作规则");
      }
    } finally {
      if (!signal.aborted && epochRef.current === epoch) setBusy(false);
    }
  }, [requestScope]);

  useEffect(() => {
    const epoch = ++epochRef.current;
    const controller = new AbortController();
    setDocument(null);
    setDraft("");
    setError(null);
    setNotice(null);
    void load(epoch, controller.signal);
    return () => {
      controller.abort();
      if (epochRef.current === epoch) epochRef.current += 1;
    };
  }, [load]);

  const saveContent = useCallback(async (content: string) => {
    if (document === null) return;
    const epoch = epochRef.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveCollaborationRules({
        scope: requestScope(),
        content,
        expectedVersion: document.version,
      });
      if (epochRef.current !== epoch) return;
      setDocument(saved);
      setDraft(saved.content);
      setNotice("已保存");
      setConfirmClear(false);
    } catch (cause) {
      // 冲突或失败都保留当前草稿，只反馈错误，不用服务端内容覆盖用户输入。
      if (epochRef.current === epoch) setError(cause instanceof Error ? cause.message : "无法保存协作规则");
    } finally {
      if (epochRef.current === epoch) setBusy(false);
    }
  }, [document, requestScope]);

  const workspaceFile = scopeKind === "workspace";
  const maximumLength = workspaceFile ? undefined : 2_000;
  const dirty = document !== null && draft !== document.content;
  return <article className="memory-document memory-rule-editor" aria-busy={busy} aria-labelledby={editorId + "-heading"}>
    <header className="memory-document-header">
      <div className="memory-document-title"><h3 id={editorId + "-heading"}>{workspaceFile ? "AGENTS.md" : props.title}</h3></div>
        <button className="memory-icon-button" type="button" aria-label={"刷新" + props.title} title={"刷新" + props.title} disabled={busy || dirty} onClick={() => {
          const epoch = epochRef.current;
          const controller = new AbortController();
          void load(epoch, controller.signal);
        }}><RefreshCw size={15} aria-hidden="true" /></button>
    </header>
    {document === null ? <div className="memory-document-loading" role="status"><RefreshCw size={16} aria-hidden="true" />{error === null ? "正在读取规则…" : "暂时无法读取规则"}</div>
      : <div className="memory-document-editing">
          <label className="memory-sr-only" htmlFor={editorId + "-content"}>{props.title}正文</label>
          <textarea id={editorId + "-content"} className="memory-document-input" value={draft} spellCheck={false}
            onChange={event => { setDraft(event.target.value); setNotice(null); }} disabled={busy || confirmClear}
            {...(maximumLength === undefined ? {} : { maxLength: maximumLength })}
            placeholder="添加规则…" />
        </div>}
    {error !== null && <div className="memory-document-feedback"><MemoryFeedback kind="error" dismissAfterMs={8_000}>{error}</MemoryFeedback></div>}
    <footer className="memory-document-footer memory-rule-footer">
      <div className="memory-editor-actions">
        <button className="memory-button memory-button-danger-quiet" type="button" onClick={() => setConfirmClear(true)} disabled={busy || confirmClear || document === null || document.content.length === 0 || dirty}><Trash2 size={14} aria-hidden="true" />清空</button>
        <span className="memory-editor-caption" role="status">{dirty ? "未保存" : notice}</span>
      </div>
      <div className="memory-editor-actions">
        {dirty && <button className="memory-button memory-button-quiet" type="button" disabled={busy} onClick={() => { setDraft(document?.content ?? ""); setNotice(null); }}>取消</button>}
        <button className="memory-button memory-button-primary" type="button" disabled={busy || confirmClear || !dirty} onClick={() => void saveContent(draft)}><Save size={14} aria-hidden="true" />{busy ? "保存中…" : "保存"}</button>
      </div>
    </footer>
    {error !== null && document !== null && <button className="memory-text-button memory-load-retry" type="button" disabled={busy} onClick={() => { const controller = new AbortController(); void load(epochRef.current, controller.signal); }}>放弃修改并重新加载</button>}
    {confirmClear && <div className="memory-clear-confirm memory-rule-confirm" role="alertdialog" aria-label={"确认清空" + props.title}>
      <div className="memory-confirm-copy"><Trash2 size={17} aria-hidden="true" /><div><strong>清空{props.title}？</strong><p>{workspaceFile ? "AGENTS.md 将保存为空正文，文件不会被删除。" : "这会移除该范围的长期协作约定。"}</p></div></div>
      <div className="memory-editor-actions">
        <button className="memory-button" type="button" onClick={() => setConfirmClear(false)} disabled={busy}>取消</button>
        <button className="memory-button memory-button-danger" type="button" onClick={() => void saveContent("")} disabled={busy}>确认清空</button>
      </div>
    </div>}
  </article>;
}
