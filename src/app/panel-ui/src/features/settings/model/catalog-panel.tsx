import React, { useState } from "react";
import { AlertCircle, Plus, RefreshCw, Search, Settings2, Trash2, X } from "lucide-react";
import type { ModelProviderModelItem } from "./settings-projection";
import { formatModelCount } from "./settings-projection";
import { ModelIcon } from "./settings-icons";
import { useAutoHidden } from "../../../components/use-auto-hidden";

export function ModelCatalogPanel(props: {
  readonly catalogModels: readonly ModelProviderModelItem[];
  readonly visibleCatalogModels: readonly ModelProviderModelItem[];
  readonly fetchedCandidates?: readonly ModelProviderModelItem[];
  readonly visibleFetchedCandidates?: readonly ModelProviderModelItem[];
  readonly fetched?: boolean;
  readonly hasModelQuery: boolean;
  readonly showSavedCount: boolean;
  readonly showModelSearch: boolean;
  readonly modelQuery: string;
  readonly selectedModelRowId?: string;
  readonly modelNameDrafts: Readonly<Record<string, string>>;
  readonly modelIconSvg: (model: ModelProviderModelItem) => string | undefined;
  readonly saving?: boolean;
  readonly canFetchModels: boolean;
  readonly fetchDisabledReason?: string;
  readonly modelsFetchBusy?: boolean;
  readonly fetchFeedback?: { readonly type: "error" | "success"; readonly message: string };
  readonly onClearFetchFeedback?: () => void;
  readonly onModelQueryChange: (value: string) => void;
  readonly onFetchModels: () => Promise<void>;
  readonly onSelectCatalogModel: (modelId: string) => void;
  readonly onModelNameDraftChange: (modelId: string, value: string) => void;
  readonly onCommitModelDisplayName: (modelId: string, value: string) => Promise<void>;
  readonly onRemoveCatalogModel: (modelId: string) => Promise<void>;
  readonly onAddCatalogModel?: (model: ModelProviderModelItem) => Promise<void>;
  readonly onEditModelSettings?: (model: ModelProviderModelItem) => void;
}): React.ReactElement {
  const listViewport = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (listViewport.current !== null) listViewport.current.scrollTop = 0;
  }, [props.modelQuery]);

  const modelCount = props.catalogModels.length;
  const visibleCount = props.visibleCatalogModels.length;
  const [manualEntryOpen, setManualEntryOpen] = useState(false);
  const [modelId, setModelId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [addingModel, setAddingModel] = useState(false);
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const addErrorAutoHidden = useAutoHidden(addError);
  const fetchErrorAutoHidden = useAutoHidden(props.fetchFeedback?.type === "error" ? props.fetchFeedback.message : undefined);

  async function addManualModel(): Promise<void> {
    const id = modelId.trim();
    if (id.length === 0 || props.onAddCatalogModel === undefined || addingModel) return;
    setAddingModel(true);
    setAddError(undefined);
    try {
      await props.onAddCatalogModel({ id, displayName: displayName.trim() || id });
      setModelId("");
      setDisplayName("");
      setManualEntryOpen(false);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : "模型添加失败。");
    } finally {
      setAddingModel(false);
    }
  }

  return (
    <section className="model-list-panel">
      <div className="model-panel-toolbar">
        <div className="model-panel-title">
          <strong>模型列表</strong>
          {modelCount > 0 && (
            <span className="model-panel-count-badge">
              {formatModelCount(visibleCount, modelCount, props.hasModelQuery)}
            </span>
          )}
        </div>

        {modelCount > 0 && (
          <label className="model-search-field">
            <Search size={14} />
            <input
              value={props.modelQuery}
              onChange={(event) => props.onModelQueryChange(event.target.value)}
              placeholder="搜索模型"
              aria-label="搜索已保存模型"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
            />
          </label>
        )}

        <div className="model-panel-actions">
          {props.onAddCatalogModel !== undefined && <button
            type="button"
            className="model-manage-button"
            disabled={props.saving || addingModel}
            onClick={() => { setManualEntryOpen((open) => !open); setAddError(undefined); }}
            aria-expanded={manualEntryOpen}
          >
            <Plus size={14} /> 添加模型
          </button>}
          <button
            type="button"
            className={`model-fetch-button ${props.modelsFetchBusy ? "loading" : ""}`}
            onClick={() => void props.onFetchModels()}
            disabled={props.saving || props.modelsFetchBusy || addingModel || !props.canFetchModels}
            title={props.canFetchModels ? "获取可用模型列表" : props.fetchDisabledReason}
            aria-busy={props.modelsFetchBusy ? "true" : "false"}
          >
            <RefreshCw className="model-fetch-icon" size={14} />
            <span className="model-fetch-label" aria-live="polite">
              {props.modelsFetchBusy ? "获取中" : "获取模型"}
            </span>
          </button>
        </div>
      </div>

      {manualEntryOpen && <form
        className="model-manual-entry"
        onSubmit={(event) => { event.preventDefault(); void addManualModel(); }}
      >
        <label>
          <span>模型 ID</span>
          <input value={modelId} onChange={(event) => setModelId(event.target.value)} disabled={props.saving || addingModel} required autoFocus autoComplete="off" spellCheck={false} />
        </label>
        <label>
          <span>显示名称</span>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={props.saving || addingModel} placeholder={modelId.trim() || "可选"} autoComplete="off" />
        </label>
        <button type="submit" disabled={props.saving || addingModel || modelId.trim().length === 0}>
          <Plus size={14} /> {addingModel ? "添加中" : "添加"}
        </button>
        {addError !== undefined && !addErrorAutoHidden && <p role="alert">{addError}</p>}
      </form>}

      {props.fetchFeedback && props.fetchFeedback.type === "error" && !fetchErrorAutoHidden && (
        <div className="model-fetch-feedback error" role="status">
          <span className="model-fetch-feedback-text">
            <AlertCircle size={14} />
            <span>{props.fetchFeedback.message}</span>
          </span>
          {props.onClearFetchFeedback && (
            <button
              type="button"
              className="model-fetch-feedback-dismiss"
              onClick={props.onClearFetchFeedback}
              aria-label="关闭提示"
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {modelCount === 0 ? (
        <div className="model-empty model-empty-start">
          <Plus className="model-empty-start-mark" aria-hidden="true" size={20} />
          <span className="model-empty-start-title">暂无可用的模型</span>
        </div>
      ) : visibleCount === 0 ? (
        <div className="model-empty compact">未找到与关键词匹配的模型</div>
      ) : (
        <div className="model-list-scroll" ref={listViewport} role="region" aria-label="已保存模型列表" tabIndex={0}>
          <div className="model-list">
            {props.visibleCatalogModels.map((model) => (
              <EditableModelRow
                key={model.id}
                model={model}
                selected={model.id === props.selectedModelRowId}
                saving={props.saving}
                nameDraft={props.modelNameDrafts[model.id] ?? model.displayName ?? model.id}
                iconSvg={props.modelIconSvg(model)}
                onSelectCatalogModel={props.onSelectCatalogModel}
                onModelNameDraftChange={props.onModelNameDraftChange}
                onCommitModelDisplayName={props.onCommitModelDisplayName}
                onRemoveCatalogModel={props.onRemoveCatalogModel}
                onEditModelSettings={props.onEditModelSettings}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function EditableModelRow(props: {
  readonly model: ModelProviderModelItem;
  readonly selected: boolean;
  readonly saving?: boolean;
  readonly nameDraft: string;
  readonly iconSvg: string | undefined;
  readonly onSelectCatalogModel: (modelId: string) => void;
  readonly onModelNameDraftChange: (modelId: string, value: string) => void;
  readonly onCommitModelDisplayName: (modelId: string, value: string) => Promise<void>;
  readonly onRemoveCatalogModel: (modelId: string) => Promise<void>;
  readonly onEditModelSettings?: (model: ModelProviderModelItem) => void;
}): React.ReactElement {
  return (
    <div
      className={`model-list-row saved ${props.selected ? "selected" : ""}`}
      role="option"
      aria-selected={props.selected}
      tabIndex={0}
      onClick={() => props.onSelectCatalogModel(props.model.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        props.onSelectCatalogModel(props.model.id);
      }}
    >
      <ModelIcon svg={props.iconSvg} />
      <div className="model-row-copy">
        <div className="model-row-name-line">
          <input
            className="model-name-input"
            value={props.nameDraft}
            placeholder={props.model.id}
            aria-label={`修改模型展示名称 ${props.model.id}`}
            title="点击可直接编辑修改模型展示名称"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => props.onModelNameDraftChange(props.model.id, event.target.value)}
            onBlur={(event) => {
              void props.onCommitModelDisplayName(props.model.id, event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
        </div>
        <small title={`原始模型标识: ${props.model.id}`}>{props.model.id}</small>
      </div>
      <div className="model-row-actions">
        {props.onEditModelSettings !== undefined && <button
          type="button"
          className="model-row-action"
          aria-label={`设置模型能力 ${props.model.displayName || props.model.id}`}
          title="模型能力设置"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            props.onEditModelSettings?.(props.model);
          }}
          disabled={props.saving}
        >
          <Settings2 size={14} />
        </button>}
        <button
          type="button"
          className="model-row-action"
          aria-label={`移除 ${props.model.displayName}`}
          title={`从列表中移除 ${props.model.displayName}`}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={(event) => {
            event.stopPropagation();
            void props.onRemoveCatalogModel(props.model.id);
          }}
          disabled={props.saving}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
