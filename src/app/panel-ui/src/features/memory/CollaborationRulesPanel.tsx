import { useCallback, useEffect, useState } from "react";
import {
  deleteCollaborationRules,
  fetchCollaborationRules,
  saveCollaborationRules,
  type CollaborationRuleScope,
  type CollaborationRulesDocument,
} from "@panel-api/collaboration-rules";
import type { MemorySettingsScope } from "./MemorySettingsPanel";
import "./memory.css";

const GLOBAL_SCOPE = { kind: "global" } as const;

export function CollaborationRulesPanel(props: { readonly scope: MemorySettingsScope | null }): React.ReactElement {
  const ownerScope = props.scope?.owner;
  return (
    <section className="memory-settings">
      <RuleEditor key="global" title="全局规则" scope={GLOBAL_SCOPE} />
      {ownerScope === undefined ? (
        <p className="memory-hint">打开 Space 或工作区对话后，可编辑该范围的规则。</p>
      ) : (
        <RuleEditor
          key={`${ownerScope.kind}:${ownerScope.id}`}
          title={ownerScope.kind === "space" ? "当前 Space 规则" : "当前工作区规则"}
          scope={ownerScope}
        />
      )}
    </section>
  );
}

function RuleEditor(props: { readonly title: string; readonly scope: CollaborationRuleScope }): React.ReactElement {
  const [document, setDocument] = useState<CollaborationRulesDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const next = await fetchCollaborationRules(props.scope);
      setDocument(next);
      setDraft(next.content);
      setError(null);
      setConfirmClear(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取协作规则");
    } finally {
      setBusy(false);
    }
  }, [props.scope]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    if (document === null) return;
    setBusy(true);
    try {
      const saved = await saveCollaborationRules({
        scope: props.scope,
        content: draft,
        expectedVersion: document.version,
      });
      setDocument(saved);
      setDraft(saved.content);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存协作规则");
    } finally {
      setBusy(false);
    }
  }, [document, draft, props.scope]);

  const clear = useCallback(async () => {
    if (document === null) return;
    setBusy(true);
    try {
      const deleted = await deleteCollaborationRules({ scope: props.scope, expectedVersion: document.version });
      setDocument(deleted);
      setDraft("");
      setError(null);
      setConfirmClear(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法删除协作规则");
    } finally {
      setBusy(false);
    }
  }, [document, props.scope]);

  return (
    <article className="memory-rule-editor" aria-busy={busy}>
      <div className="memory-editor-heading">
        <h3>{props.title}</h3>
        <button type="button" onClick={() => void load()} disabled={busy}>刷新</button>
      </div>
      {error !== null && <p className="memory-error" role="alert">{error}</p>}
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={busy || document === null}
        maxLength={2_000}
        placeholder="例如：优先给出结论、说明风险，并保持回答简洁。"
        aria-label={props.title}
      />
      {confirmClear ? (
        <div className="memory-clear-confirm" role="alertdialog">
          <p>这会删除这份协作规则，无法恢复。</p>
          <div className="memory-editor-actions">
            <button type="button" onClick={() => setConfirmClear(false)} disabled={busy}>取消</button>
            <button type="button" className="danger" onClick={() => void clear()} disabled={busy}>确认删除</button>
          </div>
        </div>
      ) : (
        <div className="memory-editor-actions">
          <button type="button" onClick={() => void save()} disabled={busy || document === null}>保存</button>
          <button type="button" className="memory-clear" onClick={() => setConfirmClear(true)} disabled={busy || draft.length === 0}>清空</button>
        </div>
      )}
    </article>
  );
}
