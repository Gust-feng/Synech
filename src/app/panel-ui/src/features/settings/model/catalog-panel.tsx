import React from "react";
import { AlertCircle, RefreshCw, Search, Trash2, X } from "lucide-react";
import type { ModelProviderModelItem } from "./settings-projection";
import { formatModelCount } from "./settings-projection";
import { ModelIcon } from "./settings-icons";

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
  readonly hasApiKey: boolean;
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
}): React.ReactElement {
  const modelCount = props.catalogModels.length;
  const visibleCount = props.visibleCatalogModels.length;

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
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
            />
          </label>
        )}

        <div className="model-panel-actions">
          <button
            type="button"
            className={`model-fetch-button ${props.modelsFetchBusy ? "loading" : ""}`}
            onClick={() => void props.onFetchModels()}
            disabled={props.saving || props.modelsFetchBusy || !props.hasApiKey}
            title={props.hasApiKey ? "获取该服务商提供的可用模型列表" : "请先填写并保存 API Key"}
            aria-busy={props.modelsFetchBusy ? "true" : "false"}
          >
            <RefreshCw className="model-fetch-icon" size={14} />
            <span className="model-fetch-label" aria-live="polite">
              {props.modelsFetchBusy ? "获取中" : "获取模型"}
            </span>
          </button>
        </div>
      </div>

      {props.fetchFeedback && props.fetchFeedback.type === "error" && (
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
          <span className="model-empty-start-mark" aria-hidden="true">+</span>
          <span className="model-empty-start-title">暂无可用的模型</span>
          <span className="model-empty-start-detail">
            {props.hasApiKey
              ? "可点击右上角「获取模型」同步该服务商的最新可用模型"
              : "填写 API Key 后，点击右上角「获取模型」即可载入可用模型列表"}
          </span>
        </div>
      ) : visibleCount === 0 ? (
        <div className="model-empty compact">未找到与关键词匹配的模型</div>
      ) : (
        <div className="model-list-scroll">
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
  );
}
