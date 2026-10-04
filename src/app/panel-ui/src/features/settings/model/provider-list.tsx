import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, GripVertical, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import type { ModelProviderListItem } from "./settings-projection";
import { ProviderLogo } from "./settings-icons";
import { sameStringList } from "./settings-list-equality";
import { useAutoHidden } from "../../../components/use-auto-hidden";

const SETTLE_DURATION_MS = 320;

export function ModelProviderList(props: {
  readonly items: readonly ModelProviderListItem[];
  readonly selectedItem?: ModelProviderListItem;
  readonly query: string;
  readonly saving?: boolean;
  readonly reorderEnabled: boolean;
  readonly onQueryChange: (value: string) => void;
  readonly onSelect: (item: ModelProviderListItem) => void;
  readonly onReorder: (order: readonly string[]) => Promise<void>;
  readonly onDeleteProvider: (item: ModelProviderListItem) => Promise<void>;
  readonly showProviderSearch: boolean;
  readonly failure?: { readonly message: string; readonly retry?: () => void };
  readonly onDismissFailure: () => void;
  readonly onOpenCatalog: () => void;
}): React.ReactElement {
  const [draggingKey, setDraggingKey] = useState<string | undefined>(undefined);
  const [insertIndex, setInsertIndex] = useState<number | undefined>(undefined);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const [dragRowStep, setDragRowStep] = useState(0);
  const failureAutoHidden = useAutoHidden(props.failure?.message);
  const [settlingDrag, setSettlingDrag] = useState<{ readonly key: string; readonly offsetY: number } | undefined>(undefined);
  const [dropHandoffActive, setDropHandoffActive] = useState(false);
  const [deleteZoneActive, setDeleteZoneActiveState] = useState(false);
  const deleteZoneRef = useRef<HTMLButtonElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const dragStateRef = useRef<{
    readonly key: string;
    readonly pointerId: number;
    readonly startY: number;
    readonly startIndex: number;
    readonly active: boolean;
    readonly rowStep: number;
    readonly suppressSelectOnEnd: boolean;
  } | undefined>(undefined);
  const insertIndexRef = useRef<number | undefined>(undefined);
  const deleteZoneActiveRef = useRef(false);
  const suppressSelectRef = useRef(false);
  const settleFrameRef = useRef<number | undefined>(undefined);
  const settleTimerRef = useRef<number | undefined>(undefined);
  const dropHandoffTimerRef = useRef<number | undefined>(undefined);
  const pendingSettleRef = useRef<{ readonly key: string; readonly fromTop: number } | undefined>(undefined);
  const draggingIndex = draggingKey === undefined ? -1 : props.items.findIndex((item) => item.key === draggingKey);
  const draggingItem = draggingKey === undefined ? undefined : props.items.find((item) => item.key === draggingKey);
  const deleteMode = draggingItem !== undefined;
  const deleteAvailable = draggingItem?.profileId !== undefined && draggingItem.protectedBuiltin !== true;

  useEffect(() => {
    return () => {
      clearSettleTimers();
      clearDropHandoffTimer();
    };
  }, []);

  useLayoutEffect(() => {
    const pending = pendingSettleRef.current;
    if (pending === undefined) return;
    pendingSettleRef.current = undefined;
    const row = rowRefs.current.get(pending.key);
    if (row === undefined) {
      cancelSettleAnimation();
      return;
    }
    startSettleAnimation(pending.key, pending.fromTop - row.getBoundingClientRect().top);
  });

  function updateInsertIndex(clientY: number): void {
    const dragState = dragStateRef.current;
    if (dragState === undefined || dragState.rowStep <= 0) return;
    const offsetY = clientY - dragState.startY;
    const nextIndex = clampIndex(
      dragState.startIndex + Math.round(offsetY / dragState.rowStep),
      props.items.length
    );
    setActiveInsertIndex(nextIndex);
  }

  function finishDrag(item: ModelProviderListItem): void {
    const nextIndex = insertIndexRef.current;
    const shouldDelete = deleteZoneActiveRef.current && item.profileId !== undefined && item.protectedBuiltin !== true;
    const currentKeys = props.items.map((provider) => provider.key);
    const nextOrder = nextIndex === undefined
      ? undefined
      : reorderedProviderKeys(currentKeys, item.key, nextIndex);
    const draggedRow = rowRefs.current.get(item.key);
    const settleFromTop = draggedRow?.getBoundingClientRect().top;
    dragStateRef.current = undefined;
    setDraggingKey(undefined);
    setDragOffsetY(0);
    setDragRowStep(0);
    setActiveInsertIndex(undefined);
    setDeleteZoneActive(false);
    if (shouldDelete) {
      cancelSettleAnimation();
      startDropHandoff();
      void props.onDeleteProvider(item);
      return;
    }
    if (settleFromTop !== undefined) {
      pendingSettleRef.current = { key: item.key, fromTop: settleFromTop };
    }
    if (nextOrder !== undefined) {
      startDropHandoff();
      void props.onReorder(nextOrder);
    }
  }

  function cancelReorder(): void {
    dragStateRef.current = undefined;
    pendingSettleRef.current = undefined;
    setDraggingKey(undefined);
    setDragOffsetY(0);
    setDragRowStep(0);
    setActiveInsertIndex(undefined);
    setDeleteZoneActive(false);
    setDropHandoffActive(false);
    clearDropHandoffTimer();
  }

  function setActiveInsertIndex(value: number | undefined): void {
    if (insertIndexRef.current === value) return;
    insertIndexRef.current = value;
    setInsertIndex(value);
  }

  function setDeleteZoneActive(value: boolean): void {
    if (deleteZoneActiveRef.current === value) return;
    deleteZoneActiveRef.current = value;
    setDeleteZoneActiveState(value);
  }

  function cancelSettleAnimation(): void {
    clearSettleTimers();
    setSettlingDrag(undefined);
  }

  function clearSettleTimers(): void {
    if (settleFrameRef.current !== undefined) {
      window.cancelAnimationFrame(settleFrameRef.current);
      settleFrameRef.current = undefined;
    }
    if (settleTimerRef.current !== undefined) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = undefined;
    }
  }

  function clearDropHandoffTimer(): void {
    if (dropHandoffTimerRef.current !== undefined) {
      window.clearTimeout(dropHandoffTimerRef.current);
      dropHandoffTimerRef.current = undefined;
    }
  }

  function startDropHandoff(): void {
    clearDropHandoffTimer();
    setDropHandoffActive(true);
    dropHandoffTimerRef.current = window.setTimeout(() => {
      dropHandoffTimerRef.current = undefined;
      setDropHandoffActive(false);
    }, SETTLE_DURATION_MS + 80);
  }

  function startSettleAnimation(key: string, offsetY: number): void {
    cancelSettleAnimation();
    if (Math.abs(offsetY) < 0.5) {
      return;
    }
    setSettlingDrag({ key, offsetY });
    settleFrameRef.current = window.requestAnimationFrame(() => {
      settleFrameRef.current = window.requestAnimationFrame(() => {
        settleFrameRef.current = undefined;
        setSettlingDrag((current) => current?.key === key ? { key, offsetY: 0 } : current);
      });
    });
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = undefined;
      setSettlingDrag((current) => current?.key === key ? undefined : current);
    }, SETTLE_DURATION_MS + 80);
  }

  function updateDeleteZone(clientX: number, clientY: number, item: ModelProviderListItem): boolean {
    const zone = deleteZoneRef.current;
    if (zone === null) {
      setDeleteZoneActive(false);
      return false;
    }
    const rect = zone.getBoundingClientRect();
    const inside = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    const active = inside && item.profileId !== undefined && item.protectedBuiltin !== true;
    setDeleteZoneActive(active);
    return active;
  }

  function beginPointerReorder(
    item: ModelProviderListItem,
    index: number,
    pointerId: number,
    clientY: number,
    active: boolean,
    suppressSelectOnEnd: boolean,
    rowStep: number
  ): void {
    dragStateRef.current = { key: item.key, pointerId, startY: clientY, startIndex: index, active, rowStep, suppressSelectOnEnd };
    setDragRowStep(rowStep);
    if (active) {
      cancelSettleAnimation();
      setDropHandoffActive(false);
      clearDropHandoffTimer();
      setDraggingKey(item.key);
      setDragOffsetY(0);
      setDeleteZoneActive(false);
      setActiveInsertIndex(index);
      updateInsertIndex(clientY);
    }
  }

  function movePointerReorder(item: ModelProviderListItem, pointerId: number, clientX: number, clientY: number): void {
    const dragState = dragStateRef.current;
    if (dragState?.key !== item.key || dragState.pointerId !== pointerId) return;
    const offsetY = clientY - dragState.startY;
    if (!dragState.active) {
      if (Math.abs(offsetY) < 5) return;
      dragStateRef.current = { ...dragState, active: true };
      cancelSettleAnimation();
      setDropHandoffActive(false);
      clearDropHandoffTimer();
      setDraggingKey(item.key);
      setDragRowStep(dragState.rowStep);
      setActiveInsertIndex(dragState.startIndex);
    }
    setDragOffsetY(offsetY);
    if (updateDeleteZone(clientX, clientY, item)) {
      setActiveInsertIndex(undefined);
      return;
    }
    updateInsertIndex(clientY);
  }

  function endPointerReorder(item: ModelProviderListItem, pointerId: number): void {
    const dragState = dragStateRef.current;
    if (dragState?.key !== item.key || dragState.pointerId !== pointerId) return;
    if (dragState.active) {
      suppressSelectRef.current = dragState.suppressSelectOnEnd;
      finishDrag(item);
      if (dragState.suppressSelectOnEnd) {
        window.setTimeout(() => {
          suppressSelectRef.current = false;
        }, 0);
      }
      return;
    }
    dragStateRef.current = undefined;
    setDragRowStep(0);
    setDeleteZoneActive(false);
  }

  return (
    <aside className="provider-list-pane" aria-label="模型服务">
      {props.showProviderSearch && (
        <div className="provider-list-header">
          <label className="provider-search">
            <Search size={14} />
            <input
              value={props.query}
              onChange={(event) => props.onQueryChange(event.target.value)}
              placeholder="搜索服务"
              aria-label="搜索模型服务"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
            />
            {props.query.length > 0 && <button
              type="button"
              className="provider-search-clear"
              aria-label="清空服务搜索"
              title="清空服务搜索"
              onClick={() => props.onQueryChange("")}
            ><X size={14} /></button>}
          </label>
        </div>
      )}
      <div className={`provider-list ${draggingKey === undefined ? "" : "reordering"} ${dropHandoffActive ? "drop-handoff" : ""}`}>
        {props.items.map((item, index) => {
          const selected = item.key === props.selectedItem?.key;
          const dragging = item.key === draggingKey;
          const settling = item.key === settlingDrag?.key;
          const deletePreview = deleteZoneActive && deleteAvailable;
          const rowShiftY = dragging
            ? dragOffsetY
            : settling
              ? settlingDrag.offsetY
              : deletePreview
                ? providerDeleteRowShift(index, draggingIndex, dragRowStep)
                : providerRowShift(index, draggingIndex, insertIndex, dragRowStep);
          return (
            <article
              className={`provider-row ${selected ? "selected" : ""} ${dragging ? "dragging" : ""} ${settling ? "settling" : ""}`}
              data-provider-key={item.key}
              key={item.key}
              ref={(node) => {
                if (node === null) {
                  rowRefs.current.delete(item.key);
                  return;
                }
                rowRefs.current.set(item.key, node);
              }}
              style={rowShiftY === 0 ? undefined : { transform: `translate3d(0, ${rowShiftY}px, 0)` }}
            >
              <button
                type="button"
                className="provider-row-main"
                aria-current={selected ? "true" : undefined}
                onClick={() => props.onSelect(item)}
              >
                <ProviderLogo item={item} />
                <strong className="provider-row-title">{item.title}</strong>
              </button>
              <button
                type="button"
                className="provider-row-drag"
                disabled={!props.reorderEnabled}
                aria-label="拖动排序"
                onPointerDown={(event) => {
                  if (!props.reorderEnabled || event.button !== 0) {
                    event.preventDefault();
                    return;
                  }
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  beginPointerReorder(item, index, event.pointerId, event.clientY, true, false, providerRowStep(event.currentTarget));
                }}
                onPointerMove={(event) => movePointerReorder(item, event.pointerId, event.clientX, event.clientY)}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  endPointerReorder(item, event.pointerId);
                }}
                onPointerCancel={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  cancelReorder();
                }}
              >
                <GripVertical size={14} className="provider-row-grip-icon" aria-hidden="true" />
              </button>
            </article>
          );
        })}
        {props.items.length === 0 && <p className="provider-directory-empty">没有匹配的服务</p>}
      </div>
      {props.failure !== undefined && !failureAutoHidden && <div className="provider-mutation-error" role="alert">
        <span>{props.failure.message}</span>
        <div>
          {props.failure.retry !== undefined && <button
            type="button"
            aria-label="重试保存模型服务"
            title="重试保存"
            disabled={props.saving}
            onClick={props.failure.retry}
          ><RotateCcw size={14} /></button>}
          <button
            type="button"
            aria-label="关闭模型服务错误提示"
            title="关闭提示"
            onClick={props.onDismissFailure}
          ><X size={14} /></button>
        </div>
      </div>}
      <button
        ref={deleteZoneRef}
        type="button"
        className={`provider-add-button ${deleteMode ? "delete-drop" : ""} ${deleteZoneActive ? "active" : ""}`}
        onClick={() => {
          if (deleteMode) return;
          props.onOpenCatalog();
        }}
        disabled={deleteMode ? !deleteAvailable : props.saving}
        aria-label={deleteMode ? "删除模型服务" : "添加服务"}
      >
        {deleteMode ? <Trash2 size={16} /> : <Plus size={16} />}
        {deleteMode ? (deleteAvailable ? "删除模型服务" : "无法删除") : "添加服务"}
      </button>
    </aside>
  );
}

export function ProviderDirectory(props: {
  readonly items: readonly ModelProviderListItem[];
  readonly warnings?: readonly { readonly presetId: string; readonly message: string }[];
  readonly saving?: boolean;
  readonly onClose: () => void;
  readonly onAddProvider: (item: ModelProviderListItem) => Promise<void>;
  readonly onAddCustomProvider: () => Promise<void>;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [addingKey, setAddingKey] = useState<string | undefined>(undefined);
  const [selectedBrandId, setSelectedBrandId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const directoryErrorAutoHidden = useAutoHidden(error);
  const normalizedQuery = query.trim().toLowerCase();
  const brands = new Map<string, { readonly label: string; readonly items: ModelProviderListItem[] }>();
  for (const item of props.items) {
    const brandId = item.brandId ?? item.presetId ?? item.key;
    const brand = brands.get(brandId);
    if (brand === undefined) brands.set(brandId, { label: item.brandLabel ?? item.title, items: [item] });
    else brand.items.push(item);
  }
  const selectedBrand = selectedBrandId === undefined ? undefined : brands.get(selectedBrandId);
  function matches(item: ModelProviderListItem): boolean {
    if (normalizedQuery.length === 0) return true;
    const aliases = PROVIDER_SEARCH_ALIASES[item.brandId ?? item.presetId ?? ""] ?? [];
    return [item.title, item.vendor, item.brandLabel, item.serviceLabel, ...aliases].some((value) =>
      value?.toLowerCase().includes(normalizedQuery),
    );
  }
  const visibleBrands = [...brands.entries()].filter(([, brand]) => brand.items.some(matches));
  const services = selectedBrand?.items.filter(matches) ?? [];
  async function add(key: string, action: () => Promise<void>): Promise<void> {
    setAddingKey(key);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "模型服务添加失败。");
    } finally {
      setAddingKey(undefined);
    }
  }
  return (
    <section className="provider-directory-pane" aria-label="添加服务">
      <header className="provider-directory-header">
        <div className="provider-directory-heading">
          {selectedBrand !== undefined && (
            <button
              type="button"
              className="provider-directory-close"
              onClick={() => { setSelectedBrandId(undefined); setQuery(""); setError(undefined); }}
              aria-label="返回厂商目录"
              title="返回厂商目录"
              disabled={addingKey !== undefined}
            ><ArrowLeft size={18} /></button>
          )}
          <h2>{selectedBrand?.label ?? "添加服务"}</h2>
        </div>
        <button type="button" className="provider-directory-close" onClick={props.onClose} disabled={addingKey !== undefined} aria-label="返回我的服务" title="返回我的服务">
          <X size={18} />
        </button>
      </header>
      <div className="provider-directory-toolbar">
        <button
          type="button"
          className="provider-directory-custom"
          onClick={() => void add("custom", props.onAddCustomProvider)}
          disabled={addingKey !== undefined || props.saving}
        >
          <Plus size={16} /> 自定义服务
        </button>
        <label className="provider-directory-search">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={selectedBrand === undefined ? "搜索厂商或平台" : "搜索服务方案"} aria-label={selectedBrand === undefined ? "搜索厂商或平台" : "搜索服务方案"} spellCheck={false} autoComplete="off" />
        </label>
      </div>
      {props.warnings?.map((warning) => <p key={warning.presetId} className="provider-directory-empty" role="status">{warning.message}</p>)}
      {error !== undefined && !directoryErrorAutoHidden && <p className="provider-directory-empty" role="alert">{error}</p>}
      {(selectedBrand === undefined ? visibleBrands.length : services.length) === 0 ? <p className="provider-directory-empty">没有匹配的服务</p> : <div className="provider-directory-groups">
        <div className="provider-directory-grid">
          {selectedBrand === undefined ? visibleBrands.map(([brandId, brand]) => (
            <button
              type="button"
              key={brandId}
              disabled={addingKey !== undefined || props.saving}
              onClick={() => { setSelectedBrandId(brandId); setQuery(""); setError(undefined); }}
            >
              <ProviderLogo item={brand.items[0]!} large />
              <span><strong>{brand.label}</strong><small>{brand.items.length} 个服务方案</small></span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          )) : services.map((item) => (
            <button
              type="button"
              key={item.key}
              disabled={addingKey !== undefined || props.saving}
              onClick={() => void add(item.key, () => props.onAddProvider(item))}
            >
              <ProviderLogo item={item} large />
              <span><strong>{item.serviceLabel ?? item.title}</strong><small>{item.preset?.regionLabel ?? item.vendor ?? "服务连接"}</small></span>
            </button>
          ))}
        </div>
      </div>}
    </section>
  );
}

function reorderedProviderKeys(
  currentKeys: readonly string[],
  fromKey: string,
  insertIndex: number
): readonly string[] | undefined {
  const fromIndex = currentKeys.indexOf(fromKey);
  if (fromIndex < 0) return undefined;
  const nextKeys = currentKeys.filter((key) => key !== fromKey);
  const nextIndex = Math.min(Math.max(insertIndex, 0), nextKeys.length);
  nextKeys.splice(nextIndex, 0, fromKey);
  if (sameStringList(currentKeys, nextKeys)) {
    return undefined;
  }
  return nextKeys;
}

function providerRowShift(
  index: number,
  draggingIndex: number,
  insertIndex: number | undefined,
  rowStep: number
): number {
  if (draggingIndex < 0 || insertIndex === undefined || rowStep <= 0 || insertIndex === draggingIndex) {
    return 0;
  }
  if (insertIndex < draggingIndex) {
    return index >= insertIndex && index < draggingIndex ? rowStep : 0;
  }
  return index > draggingIndex && index <= insertIndex ? -rowStep : 0;
}

function providerDeleteRowShift(
  index: number,
  draggingIndex: number,
  rowStep: number
): number {
  if (draggingIndex < 0 || rowStep <= 0 || index <= draggingIndex) {
    return 0;
  }
  return -rowStep;
}

function providerRowStep(node: HTMLElement): number {
  const row = node.closest("[data-provider-key]");
  if (!(row instanceof HTMLElement)) return 58;
  const rowHeight = row.getBoundingClientRect().height;
  const list = row.parentElement;
  if (list === null) return rowHeight;
  const styles = window.getComputedStyle(list);
  const gap = Number.parseFloat(styles.rowGap || styles.gap || "0");
  return rowHeight + (Number.isFinite(gap) ? gap : 0);
}

function clampIndex(value: number, itemCount: number): number {
  return Math.min(Math.max(value, 0), Math.max(0, itemCount - 1));
}

const PROVIDER_SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = {
  moonshot: ["kimi", "月之暗面", "moonshot"],
  glm: ["智谱", "zhipu", "glm", "bigmodel", "zai", "z.ai"],
  zai: ["智谱", "zhipu", "glm", "bigmodel", "zai", "z.ai"],
  openai: ["chatgpt", "gpt", "openai"],
  anthropic: ["claude", "anthropic"],
  qwen: ["通义", "千问", "阿里", "dashscope", "qwen"],
  minimax: ["稀宇", "minimax", "海螺"],
  deepseek: ["深度求索", "deepseek"],
  google: ["gemini", "gemma", "google", "谷歌"],
  xai: ["grok", "xai", "x-ai"],
  meta: ["llama", "meta"],
  xiaomi: ["小米", "mimo", "xiaomi"],
};
