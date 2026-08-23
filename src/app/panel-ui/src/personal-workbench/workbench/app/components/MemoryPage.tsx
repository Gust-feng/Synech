import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronRight,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { ApiError } from "../../../../api";
import {
  deleteMemoryNote,
  deletePathDependency,
  fetchMemorySnapshot,
  fetchPathDependency,
} from "../../../../memory-client";
import type {
  MemoryNote,
  MemoryOwner,
  MemoryOwnerSelection,
  MemorySnapshot,
  MemorySourceRef,
  MemoryVerification,
  PathDependency,
} from "../../../../contracts/memory";

type NoteScope = "global" | "owner";
type MemoryKind = "notes" | "paths";

const GLOBAL_OWNER: MemoryOwnerSelection = { kind: "global" };

/**
 * Memory Center is a read-and-delete surface. The model owns memory creation
 * and refinement; the panel exposes scope, provenance, usage facts and direct
 * deletion without pretending that a user-authored edit is model memory.
 */
export function MemoryPage(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | undefined>(undefined);
  const snapshotRef = useRef<MemorySnapshot | undefined>(undefined);
  const [ownerSelection, setOwnerSelection] = useState<MemoryOwnerSelection>(GLOBAL_OWNER);
  const [memoryKind, setMemoryKind] = useState<MemoryKind>("notes");
  const [loadState, setLoadState] = useState<"loading" | "refreshing" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [detail, setDetail] = useState<PathDependency | undefined>(undefined);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | undefined>(undefined);
  const [detailOpen, setDetailOpen] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [noteDeleteArmed, setNoteDeleteArmed] = useState<NoteScope | null>(null);
  const [noteDeleting, setNoteDeleting] = useState<NoteScope | null>(null);
  const [noteError, setNoteError] = useState<string | undefined>(undefined);
  const [showScopeRefresh, setShowScopeRefresh] = useState(false);
  const detailRequestRef = useRef<{ readonly id: number; readonly controller: AbortController } | undefined>(undefined);
  const detailRequestSequenceRef = useRef(0);

  const cancelDetailRequest = useCallback((): void => {
    detailRequestRef.current?.controller.abort();
    detailRequestRef.current = undefined;
    detailRequestSequenceRef.current += 1;
  }, []);

  const reload = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setLoadState(snapshotRef.current === undefined ? "loading" : "refreshing");
    setLoadError(undefined);
    try {
      const next = await fetchMemorySnapshot({ owner: ownerSelection, signal });
      if (signal?.aborted) return;
      snapshotRef.current = next;
      setSnapshot(next);
      setLoadState("ready");
    } catch (error) {
      if (signal?.aborted) return;
      setLoadState("error");
      setLoadError(messageOf(error));
    }
  }, [ownerSelection]);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(undefined);
    setDetailOpen(false);
    setNoteDeleteArmed(null);
    setNoteError(undefined);
    setDeleteArmed(false);
    void reload(controller.signal);
    return () => {
      controller.abort();
      cancelDetailRequest();
    };
  }, [cancelDetailRequest, reload]);

  const ownerOptions = useMemo(
    () => uniqueOwners([GLOBAL_OWNER, ...(snapshot?.owners ?? []), ...(snapshot?.owner === undefined ? [] : [snapshot.owner])]),
    [snapshot?.owner, snapshot?.owners],
  );
  const snapshotMatchesSelection = snapshot !== undefined
    && ownerKey(snapshot.owner ?? GLOBAL_OWNER) === ownerKey(ownerSelection);
  const activeSnapshot = snapshotMatchesSelection ? snapshot : undefined;
  const scopeRefreshing = !snapshotMatchesSelection && loadState !== "error";
  const scopeLoadFailed = !snapshotMatchesSelection && loadState === "error";
  // Keep the outgoing scope mounted until the next snapshot can replace it atomically.
  // The body is inert while stale, so its mutation actions cannot target the new owner.
  const displayedSnapshot = activeSnapshot ?? (scopeRefreshing ? snapshot : undefined);
  const owner: MemoryOwner | undefined = displayedSnapshot?.owner ?? ownerSelection;
  const scopedOwner = isScopedOwner(owner) ? owner : undefined;
  const dependencies = displayedSnapshot?.pathDependencies ?? [];
  const ownerNote = displayedSnapshot?.ownerNote;
  const globalNote = displayedSnapshot?.globalNote;
  const notes = useMemo(() => {
    const records: readonly { readonly scope: NoteScope; readonly note: MemoryNote; readonly label: string; readonly status: string }[] = [
      ...(scopedOwner !== undefined && hasNoteContent(ownerNote)
        ? [{ scope: "owner" as const, note: ownerNote, label: "当前范围", status: "只在此范围使用" }]
        : []),
      ...(hasNoteContent(globalNote)
        ? [{ scope: "global" as const, note: globalNote, label: "全局", status: "所有范围共用" }]
        : []),
    ];
    return records;
  }, [globalNote, ownerNote, scopedOwner]);
  const visibleNotes = memoryKind === "notes" ? notes : [];
  const visibleDependencies = memoryKind === "paths" ? dependencies : [];
  const visibleCount = memoryKind === "notes" ? visibleNotes.length : visibleDependencies.length;
  const kindLabel = memoryKind === "notes" ? "记忆" : "路径依赖";

  useEffect(() => {
    if (!scopeRefreshing) {
      setShowScopeRefresh(false);
      return;
    }
    const timer = window.setTimeout(() => setShowScopeRefresh(true), 180);
    return () => window.clearTimeout(timer);
  }, [scopeRefreshing]);

  const openDependency = useCallback((dependency: PathDependency): void => {
    cancelDetailRequest();
    const requestId = detailRequestSequenceRef.current + 1;
    const controller = new AbortController();
    detailRequestRef.current = { id: requestId, controller };
    detailRequestSequenceRef.current = requestId;
    setDetail(dependency);
    setDetailOpen(true);
    setDetailError(undefined);
    setDeleteArmed(false);
    setDetailLoading(true);
    void fetchPathDependency(dependency.id, { owner: ownerSelection, signal: controller.signal })
      .then((fresh) => {
        if (detailRequestRef.current?.id !== requestId) return;
        setDetail(fresh);
      })
      .catch((error: unknown) => {
        if (detailRequestRef.current?.id !== requestId || controller.signal.aborted) return;
        setDetailError(messageOf(error));
      })
      .finally(() => {
        if (detailRequestRef.current?.id !== requestId) return;
        detailRequestRef.current = undefined;
        setDetailLoading(false);
      });
  }, [cancelDetailRequest, ownerSelection]);

  const closeDetail = useCallback((force = false): void => {
    if (!force && deleting) return;
    cancelDetailRequest();
    setDetailOpen(false);
    setDetail(undefined);
    setDeleteArmed(false);
    setDetailError(undefined);
  }, [cancelDetailRequest, deleting]);

  const deleteDependency = useCallback(async (): Promise<void> => {
    if (detail === undefined || !deleteArmed) return;
    setDeleting(true);
    setDetailError(undefined);
    try {
      await deletePathDependency(detail.id, {
        ...memoryMutationContext(ownerSelection),
        expectedRevision: detail.revision,
      });
      setSnapshot((current) => current === undefined
        ? current
        : { ...current, pathDependencies: current.pathDependencies.filter((dependency) => dependency.id !== detail.id) });
      closeDetail(true);
    } catch (error) {
      setDetailError(isConflict(error)
        ? "这条记忆已被其他操作更新，请重新打开后确认删除。"
        : messageOf(error));
    } finally {
      setDeleting(false);
    }
  }, [closeDetail, deleteArmed, detail, ownerSelection]);

  const deleteNote = useCallback(async (scope: NoteScope): Promise<void> => {
    if (noteDeleteArmed !== scope || snapshot === undefined || noteDeleting !== null) return;
    const note = scope === "global" ? snapshot.globalNote : snapshot.ownerNote;
    if (note === undefined) return;
    setNoteDeleting(scope);
    setNoteError(undefined);
    try {
      const deleted = await deleteMemoryNote(scope, {
        ...memoryMutationContext(ownerSelection),
        expectedVersion: note.version,
      });
      setSnapshot((current) => current === undefined
        ? current
        : scope === "global" ? { ...current, globalNote: deleted } : { ...current, ownerNote: deleted });
      setNoteDeleteArmed(null);
    } catch (error) {
      setNoteError(isConflict(error)
        ? "这条记忆已被其他操作更新，请重新读取后确认删除。"
        : messageOf(error));
    } finally {
      setNoteDeleting(null);
    }
  }, [noteDeleteArmed, noteDeleting, ownerSelection, snapshot]);

  if (loadState === "loading" && snapshot === undefined) {
    return <MemoryPageFrame><MemoryLoadingState /></MemoryPageFrame>;
  }
  if (loadState === "error" && snapshot === undefined) {
    return (
      <MemoryPageFrame>
        <div className="memory-center__error" role="alert">
          <span>{loadError ?? "记忆暂时无法加载。"}</span>
          <button type="button" className="memory-center__text-button" onClick={() => void reload()} style={{ marginLeft: 10 }}>
            重试
          </button>
        </div>
      </MemoryPageFrame>
    );
  }

  return (
    <MemoryPageFrame>
      <main className="memory-center__main">
        <header className="memory-center__masthead">
          <div className="memory-center__heading">
            <h1 className="memory-center__title">{kindLabel}</h1>
            {!scopeLoadFailed && (
              <span className={`memory-center__result-count${showScopeRefresh ? " is-refreshing" : ""}`}>{visibleCount} 条</span>
            )}
          </div>
          <label className="memory-center__scope-control">
            <span>范围</span>
            <select
              aria-label="记忆范围"
              value={ownerKey(ownerSelection)}
              onChange={(event) => {
                const next = ownerOptions.find((candidate) => ownerKey(candidate) === event.target.value);
                if (next !== undefined) setOwnerSelection(toOwnerSelection(next));
              }}
            >
              {ownerOptions.map((candidate) => <option key={ownerKey(candidate)} value={ownerKey(candidate)}>{ownerOptionLabel(candidate)}</option>)}
            </select>
          </label>
        </header>
        <div className="memory-center__content">
          <MemorySectionNav kind={memoryKind} onChange={setMemoryKind} />
          <div className="memory-center__content-main">
            {noteError !== undefined && <div className="memory-center__conflict" role="alert">{noteError}</div>}

            <section
              className={`memory-center__list-panel${visibleCount === 0 && !scopeLoadFailed ? " is-empty" : ""}${showScopeRefresh ? " is-refreshing" : ""}${scopeLoadFailed ? " is-error" : ""}`}
              aria-busy={scopeRefreshing}
              aria-label={`${kindLabel}列表`}
            >
              {showScopeRefresh && scopeRefreshing && <MemoryScopeRefreshStatus />}
              {scopeLoadFailed ? (
                <MemoryListLoadError message={loadError} onRetry={() => void reload()} />
              ) : (
                <div
                  className="memory-center__list-body"
                  aria-hidden={scopeRefreshing || undefined}
                  inert={scopeRefreshing || undefined}
                >
                  {visibleCount === 0 ? (
                    <MemoryListEmpty kind={memoryKind} />
                  ) : memoryKind === "notes" ? (
                    <div className="memory-center__notes">
                      {visibleNotes.map((record) => (
                        <NoteCard
                          key={record.scope}
                          scope={record.scope}
                          note={record.note}
                          label={record.label}
                          status={record.status}
                          deleteArmed={noteDeleteArmed === record.scope}
                          deleting={noteDeleting === record.scope}
                          onArmDelete={() => setNoteDeleteArmed(record.scope)}
                          onCancelDelete={() => setNoteDeleteArmed(null)}
                          onDelete={() => void deleteNote(record.scope)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="memory-center__dependencies">
                      {visibleDependencies.map((dependency) => (
                        <DependencyRow key={dependency.id} dependency={dependency} onClick={() => openDependency(dependency)} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
      </main>

      {detailOpen && (
        <DependencyDialog
          dependency={detail}
          loading={detailLoading}
          error={detailError}
          deleteArmed={deleteArmed}
          deleting={deleting}
          onClose={closeDetail}
          onArmDelete={() => setDeleteArmed(true)}
          onCancelDelete={() => setDeleteArmed(false)}
          onDelete={() => void deleteDependency()}
          onReload={() => {
            if (detail !== undefined) openDependency(detail);
          }}
        />
      )}
    </MemoryPageFrame>
  );
}

function MemoryPageFrame({ children }: { readonly children: ReactNode }): React.ReactElement {
  return (
    <section className="memory-center flex min-h-0 flex-1" aria-label="记忆">
      <div className="memory-center__scroll w-full">
        <div className="memory-center__inner">{children}</div>
      </div>
    </section>
  );
}

function MemoryLoadingState(): React.ReactElement {
  return (
    <div className="memory-center__loading" role="status" aria-label="正在加载记忆">
      <div className="memory-center__eyebrow">记忆</div>
      <div className="memory-center__loading-title" />
      <div className="memory-center__loading-line" />
      <div className="memory-center__loading-panel" />
    </div>
  );
}

function MemorySectionNav(props: {
  readonly kind: MemoryKind;
  readonly onChange: (kind: MemoryKind) => void;
}): React.ReactElement {
  return (
    <nav className="memory-center__section-nav" aria-label="记忆视图">
      <button
        type="button"
        className={`memory-center__section-item${props.kind === "notes" ? " is-active" : ""}`}
        aria-current={props.kind === "notes" ? "page" : undefined}
        onClick={() => props.onChange("notes")}
      >
        <span>记忆</span>
        <small>事实与约定</small>
      </button>
      <button
        type="button"
        className={`memory-center__section-item${props.kind === "paths" ? " is-active" : ""}`}
        aria-current={props.kind === "paths" ? "page" : undefined}
        onClick={() => props.onChange("paths")}
      >
        <span>路径依赖</span>
        <small>可复用方法</small>
      </button>
    </nav>
  );
}

function MemoryListEmpty({ kind }: { readonly kind: MemoryKind }): React.ReactElement {
  const title = kind === "paths" ? "还没有路径依赖" : "还没有记忆";
  const copy = kind === "paths"
    ? "当复杂任务形成可复用的方法时，模型会把方法保存到这里。"
    : "模型会在判断某条信息对未来有帮助时自主保存。";
  return (
    <div className="memory-center__list-empty" role="status">
      <strong>{title}</strong>
      <span>{copy}</span>
    </div>
  );
}

function MemoryScopeRefreshStatus(): React.ReactElement {
  return (
    <div className="memory-center__scope-refresh" role="status" aria-label="正在切换记忆范围">
      <RefreshCw size={12} className="animate-spin" aria-hidden="true" />
      <span>正在切换</span>
    </div>
  );
}

function MemoryListLoadError(props: { readonly message?: string; readonly onRetry: () => void }): React.ReactElement {
  return (
    <div className="memory-center__list-load-error" role="alert">
      <span>{props.message ?? "这个范围的记忆暂时无法加载。"}</span>
      <button type="button" className="memory-center__text-button" onClick={props.onRetry}>重试</button>
    </div>
  );
}

function NoteCard(props: {
  readonly scope: NoteScope;
  readonly note: MemoryNote;
  readonly label: string;
  readonly status: string;
  readonly deleteArmed: boolean;
  readonly deleting: boolean;
  readonly onArmDelete: () => void;
  readonly onCancelDelete: () => void;
  readonly onDelete: () => void;
}): React.ReactElement {
  return (
    <article className="memory-center__note" data-scope={props.scope}>
      <div className="memory-center__note-header">
        <span className="memory-center__note-label">{props.label}</span>
        <span className="memory-center__note-status">{props.status}</span>
      </div>
      <p className="memory-center__note-preview">{props.note.content}</p>
      <div className="memory-center__note-footer">
        {props.deleteArmed ? (
          <div className="memory-center__delete-confirm" role="alert">
            <span>删除后不可恢复</span>
            <button type="button" className="memory-center__secondary-button" onClick={props.onCancelDelete} disabled={props.deleting}>保留</button>
            <button type="button" className="memory-center__danger-button" onClick={props.onDelete} disabled={props.deleting}>
              {props.deleting ? "删除中…" : "确认删除"}
            </button>
          </div>
        ) : (
          <button type="button" className="memory-center__text-button" onClick={props.onArmDelete} disabled={props.deleting}>删除</button>
        )}
      </div>
    </article>
  );
}

function DependencyRow({ dependency, onClick }: { readonly dependency: PathDependency; readonly onClick: () => void }): React.ReactElement {
  return (
    <button type="button" className="memory-center__dependency" onClick={onClick}>
      <span className="memory-center__dependency-header">
        <span className="memory-center__dependency-title">{dependency.title}</span>
        {verificationBadge(dependency.verification)}
      </span>
      <span className="memory-center__dependency-excerpt">{dependency.excerpt ?? dependency.methodology ?? "打开查看完整方法。"}</span>
      <span className="memory-center__dependency-footer">
        {(dependency.tags ?? []).slice(0, 3).map((tag) => <span key={tag} className="memory-center__tag">#{tag}</span>)}
        <span aria-hidden="true" className="memory-center__dependency-arrow"><ChevronRight size={15} /></span>
      </span>
    </button>
  );
}

function DependencyDialog(props: {
  readonly dependency?: PathDependency;
  readonly loading: boolean;
  readonly error?: string;
  readonly deleteArmed: boolean;
  readonly deleting: boolean;
  readonly onClose: () => void;
  readonly onArmDelete: () => void;
  readonly onCancelDelete: () => void;
  readonly onDelete: () => void;
  readonly onReload: () => void;
}): React.ReactElement {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [props.onClose]);

  return (
    <div className="memory-center__modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) props.onClose();
    }}>
      <div className="memory-center__modal" role="dialog" aria-modal="true" aria-labelledby="memory-dependency-dialog-title">
        <header className="memory-center__modal-header">
          <div className="min-w-0">
            <p className="memory-center__eyebrow">路径依赖</p>
            <h2 id="memory-dependency-dialog-title" className="memory-center__modal-title">{props.dependency?.title ?? "路径依赖"}</h2>
          </div>
          <button type="button" className="memory-center__modal-close" aria-label="关闭详情" onClick={props.onClose} disabled={props.deleting}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="memory-center__modal-body">
          {props.loading && <div className="memory-center__meta-row" role="status"><RefreshCw size={12} className="animate-spin" />正在读取最新内容…</div>}
          {props.error !== undefined && (
            <div className="memory-center__error" role="alert">
              {props.error}
              <button type="button" className="memory-center__text-button" onClick={props.onReload} style={{ marginLeft: 8 }}>重新读取</button>
            </div>
          )}
          {props.dependency !== undefined && (
            <>
              <div className="memory-center__methodology">
                <p className="memory-center__section-label">方法</p>
                <p className="memory-center__methodology-body">{props.dependency.methodology ?? props.dependency.excerpt ?? "暂无方法正文。"}</p>
              </div>
              <DependencyProvenance dependency={props.dependency} />
            </>
          )}
          {props.deleteArmed && (
            <div className="memory-center__warning" role="alert">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>删除后不可恢复，相关正文会立即移除。</span>
            </div>
          )}
        </div>
        <footer className="memory-center__modal-footer">
          {props.deleteArmed ? (
            <div className="memory-center__footer-actions" style={{ marginLeft: 0 }}>
              <button type="button" className="memory-center__secondary-button" onClick={props.onCancelDelete} disabled={props.deleting}>保留</button>
              <button type="button" className="memory-center__danger-button" onClick={props.onDelete} disabled={props.deleting}>
                <Trash2 size={12} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 5 }} />
                {props.deleting ? "删除中…" : "确认删除"}
              </button>
            </div>
          ) : (
            <button type="button" className="memory-center__danger-button" onClick={props.onArmDelete} disabled={props.dependency === undefined}>删除</button>
          )}
          <button type="button" className="memory-center__secondary-button" onClick={props.onClose} disabled={props.deleting}>关闭</button>
        </footer>
      </div>
    </div>
  );
}

function DependencyProvenance({ dependency }: { readonly dependency: PathDependency }): React.ReactElement {
  const refs = dependency.sourceRunRefs ?? [];
  const evidenceRefs = dependency.evidenceRefs ?? [];
  const references = dependency.references ?? [];
  const readCount = dependency.readCount ?? references.filter((reference) => reference.kind === "read").length;
  const useCount = dependency.useCount ?? references.filter((reference) => reference.kind === "applied").length;
  return (
    <div className="memory-center__provenance">
      <p className="memory-center__section-label">来源与使用</p>
      <div className="memory-center__facts">
        <div><span>状态</span>{verificationBadge(dependency.verification) ?? <strong>未记录</strong>}</div>
        <div><span>来源</span><strong>{dependency.sourceRunCount ?? refs.length}</strong></div>
        <div><span>证据</span><strong>{dependency.evidenceCount ?? evidenceRefs.length}</strong></div>
        <div><span>读取</span><strong>{readCount}</strong></div>
        <div><span>采用</span><strong>{useCount}</strong></div>
      </div>
      <div className="memory-center__provenance-columns">
        <div>
          <p>来源 Run</p>
          {refs.length === 0 ? <span className="memory-center__muted">暂无来源记录</span> : (
            <ul>{refs.map((ref, index) => <li key={`${sourceRefLabel(ref)}-${index}`}>{sourceRefLabel(ref)}</li>)}</ul>
          )}
        </div>
        <div>
          <p>证据引用</p>
          {evidenceRefs.length === 0 ? <span className="memory-center__muted">暂无证据引用</span> : (
            <ul>{evidenceRefs.map((ref) => <li key={ref}>{ref}</li>)}</ul>
          )}
        </div>
      </div>
    </div>
  );
}

function verificationBadge(value: MemoryVerification | undefined): React.ReactElement | null {
  const status = verificationStatus(value);
  if (status === undefined) return null;
  const label = status === "observed" ? "已观察" : "未记录";
  return <span className="memory-center__verification" data-status={status}>{label}</span>;
}

function verificationStatus(value: MemoryVerification | undefined): "not_recorded" | "observed" | undefined {
  if (typeof value === "string") return value;
  return value?.status;
}

function hasNoteContent(note: MemoryNote | undefined): note is MemoryNote {
  return note !== undefined && note.content.trim().length !== 0;
}

function memoryMutationContext(
  owner: MemoryOwnerSelection,
): { readonly ownerKind: "space" | "workspace"; readonly ownerId: string } | Record<never, never> {
  if (owner.kind === "global") return {};
  return { ownerKind: owner.kind, ownerId: owner.id };
}

function uniqueOwners(owners: readonly MemoryOwner[]): readonly MemoryOwner[] {
  const seen = new Set<string>();
  return owners.filter((owner) => {
    const key = ownerKey(owner);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ownerKey(owner: MemoryOwner | MemoryOwnerSelection): string {
  return owner.kind === "global" ? "global" : `${owner.kind}:${owner.id}`;
}

function toOwnerSelection(owner: MemoryOwner): MemoryOwnerSelection {
  return owner.kind === "global" ? GLOBAL_OWNER : { kind: owner.kind, id: owner.id };
}

function isScopedOwner(owner: MemoryOwner | undefined): owner is Extract<MemoryOwner, { readonly kind: "space" | "workspace" }> {
  return owner?.kind === "space" || owner?.kind === "workspace";
}

function ownerOptionLabel(owner: MemoryOwner): string {
  if (owner.kind === "global") return "全局";
  const prefix = owner.kind === "space" ? "空间" : "工作区";
  return owner.title === undefined || owner.title.trim().length === 0 ? `${prefix} · ${owner.id}` : `${prefix} · ${owner.title}`;
}

function sourceRefLabel(ref: MemorySourceRef): string {
  if (typeof ref === "string") return ref;
  return ref.title ?? ref.runId;
}

function isConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.code?.includes("conflict") === true);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "记忆请求失败。";
}
