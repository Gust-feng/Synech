import React from "react";
import { RefreshCw, Search, Trash2 } from "lucide-react";
import type { ModelProviderModelItem } from "./model-settings-projection";
import { formatModelCount } from "./model-settings-projection";
import { ModelIcon } from "./model-settings-icons";

export function ModelCatalogPanel(props: {
  readonly catalogModels: readonly ModelProviderModelItem[];
  readonly visibleCatalogModels: readonly ModelProviderModelItem[];
  readonly fetchedCandidates: readonly ModelProviderModelItem[];
  readonly visibleFetchedCandidates: readonly ModelProviderModelItem[];
  readonly fetched: boolean;
  readonly hasModelQuery: boolean;
  readonly showSavedCount: boolean;
  readonly showModelSearch: boolean;
  readonly modelQuery: string;
  readonly selectedModelRowId?: string;
  readonly modelNameDrafts: Readonly<Record<string, string>>;
  readonly modelIconSvg: (model: ModelProviderModelItem) => string | undefined;
  readonly saving?: boolean;
  readonly modelsFetchBusy?: boolean;
  readonly onModelQueryChange: (value: string) => void;
  readonly onFetchModels: () => Promise<void>;
  readonly onSelectCatalogModel: (modelId: string) => void;
  readonly onModelNameDraftChange: (modelId: string, value: string) => void;
  readonly onCommitModelDisplayName: (modelId: string, value: string) => Promise<void>;
  readonly onRemoveCatalogModel: (modelId: string) => Promise<void>;
  readonly onAddCatalogModel: (model: ModelProviderModelItem) => Promise<void>;
}): React.ReactElement {
  return (
    <section className="model-list-panel">
      <div className="model-panel-toolbar">
        <div className="model-panel-title">
          <strong>模型列表</strong>
          {props.showSavedCount && <span>{formatModelCount(props.visibleCatalogModels.length, props.catalogModels.length, props.hasModelQuery)}</span>}
        </div>
        {props.showModelSearch && (
          <label className="model-search-field">
            <Search size={14} />
            <input
              value={props.modelQuery}
              onChange={(event) => props.onModelQueryChange(event.target.value)}
              placeholder="搜索模型"
              spellCheck={false}
            />
          </label>
        )}
        <button
          type="button"
          className={`model-fetch-button ${props.modelsFetchBusy ? "loading" : ""}`}
          onClick={() => void props.onFetchModels()}
          disabled={props.saving || props.modelsFetchBusy}
          aria-busy={props.modelsFetchBusy ? "true" : "false"}
        >
          <RefreshCw className="model-fetch-icon" size={14} />
          <span className="model-fetch-label" aria-live="polite">
            {props.modelsFetchBusy ? "获取中" : "获取模型"}
          </span>
        </button>
      </div>
      <SavedModels {...props} />
      {props.fetched && <FetchedModels {...props} />}
    </section>
  );
}

function SavedModels(props: {
  readonly catalogModels: readonly ModelProviderModelItem[];
  readonly visibleCatalogModels: readonly ModelProviderModelItem[];
  readonly modelNameDrafts: Readonly<Record<string, string>>;
  readonly modelIconSvg: (model: ModelProviderModelItem) => string | undefined;
  readonly selectedModelRowId?: string;
  readonly saving?: boolean;
  readonly onSelectCatalogModel: (modelId: string) => void;
  readonly onModelNameDraftChange: (modelId: string, value: string) => void;
  readonly onCommitModelDisplayName: (modelId: string, value: string) => Promise<void>;
  readonly onRemoveCatalogModel: (modelId: string) => Promise<void>;
}): React.ReactElement {
  return (
    <div className="model-section">
      {props.visibleCatalogModels.length === 0 && props.catalogModels.length > 0 ? (
        <div className="model-empty compact">无匹配模型</div>
      ) : (
        props.catalogModels.length > 0 && (
          <div className="model-list">
            {props.visibleCatalogModels.map((model) => (
              <SavedModelRow
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
        )
      )}
    </div>
  );
}

function SavedModelRow(props: {
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
        <input
          className="model-name-input"
          value={props.nameDraft}
          placeholder={props.model.id}
          aria-label={`模型名称 ${props.model.id}`}
          spellCheck={false}
          onChange={(event) => props.onModelNameDraftChange(props.model.id, event.target.value)}
          onFocus={() => props.onSelectCatalogModel(props.model.id)}
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
        <small>{props.model.id}</small>
      </div>
      <button
        type="button"
        className="model-row-action"
        aria-label={`移除 ${props.model.displayName}`}
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

function FetchedModels(props: {
  readonly fetchedCandidates: readonly ModelProviderModelItem[];
  readonly visibleFetchedCandidates: readonly ModelProviderModelItem[];
  readonly hasModelQuery: boolean;
  readonly modelIconSvg: (model: ModelProviderModelItem) => string | undefined;
  readonly saving?: boolean;
  readonly onAddCatalogModel: (model: ModelProviderModelItem) => Promise<void>;
}): React.ReactElement {
  return (
    <div className="model-section model-candidate-section">
      <header>
        <strong>可添加</strong>
        <span>{formatModelCount(props.visibleFetchedCandidates.length, props.fetchedCandidates.length, props.hasModelQuery)}</span>
      </header>
      {props.fetchedCandidates.length === 0 ? (
        <div className="model-empty compact">没有新的模型</div>
      ) : props.visibleFetchedCandidates.length === 0 ? (
        <div className="model-empty compact">无匹配模型</div>
      ) : (
        <div className="model-list">
          {props.visibleFetchedCandidates.map((model) => {
            return (
              <div className="model-list-row" key={model.id}>
                <ModelIcon svg={props.modelIconSvg(model)} />
                <div className="model-candidate-copy">
                  <strong>{model.displayName === model.id ? model.id : model.displayName}</strong>
                  {model.displayName !== model.id && <small>{model.id}</small>}
                </div>
                <button
                  type="button"
                  className="model-row-add"
                  onClick={() => void props.onAddCatalogModel(model)}
                  disabled={props.saving}
                >
                  添加
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}