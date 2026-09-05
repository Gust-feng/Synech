import { useCallback, useEffect, useState } from "react";
import {
  deleteMemoryPathDependency,
  fetchMemoryPathDependencies,
  saveMemoryPathDependency,
  type MemoryPathDependencyScope,
  type PathDependency,
} from "@panel-api/memory";
import type { MemorySettingsScope } from "./MemorySettingsPanel";
import "./memory.css";

const GLOBAL_SCOPE = { kind: "global" } as const;

export function PathDependenciesPanel(props: { readonly scope: MemorySettingsScope | null }): React.ReactElement {
  return (
    <section className="memory-settings">
      <DependencyList key="global" title="全局路径依赖" scope={GLOBAL_SCOPE} />
      {props.scope?.owner !== undefined && (
        <DependencyList
          key={`${props.scope.owner.kind}:${props.scope.owner.id}`}
          title={props.scope.owner.kind === "space" ? "当前 Space 路径依赖" : "当前工作区路径依赖"}
          scope={props.scope.owner}
        />
      )}
    </section>
  );
}

function DependencyList(props: { readonly title: string; readonly scope: MemoryPathDependencyScope }): React.ReactElement {
  const [items, setItems] = useState<readonly PathDependency[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PathDependency | null | "new">(null);
  const [pendingDelete, setPendingDelete] = useState<PathDependency | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await fetchMemoryPathDependencies(props.scope);
      setItems(response.pathDependencies);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取路径依赖");
    }
  }, [props.scope]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  const remove = useCallback(async (item: PathDependency) => {
    setBusyId(item.id);
    try {
      await deleteMemoryPathDependency({
        memoryId: item.id,
        scope: props.scope,
        expectedRevision: item.revision,
      });
      await load();
      setPendingDelete(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法删除路径依赖");
    } finally {
      setBusyId(null);
    }
  }, [load, props.scope]);

  const save = useCallback(async (draft: DependencyDraft) => {
    setBusyId(draft.current?.id ?? "new");
    try {
      await saveMemoryPathDependency({
        scope: props.scope,
        title: draft.title,
        methodology: draft.methodology,
        tags: draft.tags,
        ...(draft.current === undefined ? {} : {
          memoryId: draft.current.id,
          expectedRevision: draft.current.revision,
        }),
      });
      await load();
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存路径依赖");
    } finally {
      setBusyId(null);
    }
  }, [load, props.scope]);

  return (
    <article className="memory-dependency-list">
      <div className="memory-editor-heading">
        <h3>{props.title}</h3>
        <div className="memory-editor-actions">
          <button type="button" onClick={() => setEditing("new")} disabled={busyId !== null}>新建</button>
          <button type="button" onClick={() => void load()} disabled={busyId !== null}>刷新</button>
        </div>
      </div>
      {error !== null && <p className="memory-error" role="alert">{error}</p>}
      {editing !== null && (
        <DependencyEditor
          key={editing === "new" ? "new" : editing.id}
          current={editing === "new" ? undefined : editing}
          busy={busyId !== null}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      )}
      {items === null ? <p className="memory-hint">正在加载…</p> : items.length === 0 ? (
        <p className="memory-hint">当前范围没有已保存的路径依赖。</p>
      ) : (
        <ul className="memory-dependency-items">
          {items.map((item) => (
            <li key={item.id}>
              <div>
                <strong>{item.title}</strong>
                <p>{item.methodology}</p>
                <span>{item.tags.length === 0 ? "无标签" : item.tags.join(" · ")} · {item.sourceRunCount} 个来源 · {item.useCount} 次采用</span>
              </div>
              <div className="memory-editor-actions">
                <button type="button" disabled={busyId !== null} onClick={() => setEditing(item)}>编辑</button>
                <button type="button" className="memory-clear" disabled={busyId !== null} onClick={() => setPendingDelete(item)}>删除</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {pendingDelete !== null && (
        <div className="memory-clear-confirm" role="alertdialog">
          <p>这会删除“{pendingDelete.title}”，无法恢复。</p>
          <div className="memory-editor-actions">
            <button type="button" onClick={() => setPendingDelete(null)} disabled={busyId !== null}>取消</button>
            <button type="button" className="danger" onClick={() => void remove(pendingDelete)} disabled={busyId !== null}>确认删除</button>
          </div>
        </div>
      )}
    </article>
  );
}

type DependencyDraft = {
  readonly current: PathDependency | undefined;
  readonly title: string;
  readonly methodology: string;
  readonly tags: readonly string[];
};

function DependencyEditor(props: {
  readonly current: PathDependency | undefined;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSave: (draft: DependencyDraft) => void;
}): React.ReactElement {
  const [title, setTitle] = useState(props.current?.title ?? "");
  const [methodology, setMethodology] = useState(props.current?.methodology ?? "");
  const [tagsText, setTagsText] = useState((props.current?.tags ?? []).join(", "));
  const canSave = title.trim().length > 0 && methodology.trim().length > 0 && !props.busy;
  return (
    <form
      className="memory-dependency-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        props.onSave({
          current: props.current,
          title: title.trim(),
          methodology: methodology.trim(),
          tags: [...new Set(tagsText.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0))],
        });
      }}
    >
      <label>
        <span>名称</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} disabled={props.busy} />
      </label>
      <label>
        <span>方法</span>
        <textarea value={methodology} onChange={(event) => setMethodology(event.target.value)} maxLength={50_000} disabled={props.busy} />
      </label>
      <label>
        <span>标签</span>
        <input value={tagsText} onChange={(event) => setTagsText(event.target.value)} maxLength={1_944} placeholder="以逗号分隔" disabled={props.busy} />
      </label>
      <div className="memory-editor-actions">
        <button type="button" onClick={props.onCancel} disabled={props.busy}>取消</button>
        <button type="submit" disabled={!canSave}>{props.current === undefined ? "创建" : "保存"}</button>
      </div>
    </form>
  );
}
