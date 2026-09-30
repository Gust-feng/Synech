import React, { useMemo, useState } from "react";
import { ArrowLeft, Check, Search, X } from "lucide-react";
import type { ModelProviderListItem, ModelProviderModelItem } from "./settings-projection";
import { ProviderLogo, ModelIcon } from "./settings-icons";

export function ModelPickerPanel(props: {
  readonly item: ModelProviderListItem;
  readonly availableModels: readonly ModelProviderModelItem[];
  readonly currentSavedIds: readonly string[];
  readonly modelIconSvg: (model: ModelProviderModelItem) => string | undefined;
  readonly saving?: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (selectedIds: readonly string[]) => Promise<void>;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  // 初始勾选状态为当前已启用的模型 ID
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set(props.currentSavedIds));

  const initialSavedSet = useMemo(() => new Set(props.currentSavedIds), [props.currentSavedIds]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredModels = useMemo(() => {
    if (normalizedQuery.length === 0) return props.availableModels;
    return props.availableModels.filter((model) =>
      model.id.toLowerCase().includes(normalizedQuery) ||
      model.displayName.toLowerCase().includes(normalizedQuery)
    );
  }, [props.availableModels, normalizedQuery]);

  const toggleCheck = (modelId: string) => {
    setCheckedIds((previous) => {
      const next = new Set(previous);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  };

  const selectAllFiltered = () => {
    setCheckedIds((previous) => {
      const next = new Set(previous);
      for (const model of filteredModels) {
        next.add(model.id);
      }
      return next;
    });
  };

  const deselectAllFiltered = () => {
    setCheckedIds((previous) => {
      const next = new Set(previous);
      for (const model of filteredModels) {
        next.delete(model.id);
      }
      return next;
    });
  };

  const handleConfirm = async () => {
    // 保持用户选择的 ID 顺序（优先按 availableModels 的原始顺序）
    const orderedSelected = props.availableModels
      .filter((model) => checkedIds.has(model.id))
      .map((model) => model.id);
    await props.onConfirm(orderedSelected);
  };

  return (
    <section className="model-picker-pane" aria-label="选择模型">
      <header className="model-picker-header">
        <div className="model-picker-header-start">
          <button
            type="button"
            className="model-picker-back-btn"
            onClick={props.onClose}
            aria-label="返回模型服务详情"
            title="返回"
          >
            <ArrowLeft size={16} />
          </button>
          <ProviderLogo item={props.item} large />
          <div className="model-picker-header-text">
            <h2>选择模型</h2>
            <p>
              从 <strong>{props.item.title}</strong> 发现的可用模型。勾选您需要使用的模型以添加到列表：
            </p>
          </div>
        </div>
        <button
          type="button"
          className="model-picker-close-btn"
          onClick={props.onClose}
          aria-label="关闭选择面板"
          title="关闭"
        >
          <X size={16} />
        </button>
      </header>

      <div className="model-picker-toolbar">
        <label className="model-picker-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索可用模型 (ID 或名称)"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
          {query.length > 0 && (
            <button
              type="button"
              className="model-picker-search-clear"
              onClick={() => setQuery("")}
              aria-label="清空搜索"
            >
              <X size={13} />
            </button>
          )}
        </label>

        <div className="model-picker-toolbar-actions">
          <span className="model-picker-count-badge">
            已勾选 {checkedIds.size} / {props.availableModels.length} 个模型
          </span>
          <button
            type="button"
            className="model-picker-action-btn"
            onClick={selectAllFiltered}
            title="勾选当前列表中的所有模型"
          >
            全选
          </button>
          <button
            type="button"
            className="model-picker-action-btn"
            onClick={deselectAllFiltered}
            title="取消勾选当前列表中的所有模型"
          >
            清空
          </button>
        </div>
      </div>

      <div className="model-picker-list-container">
        {filteredModels.length === 0 ? (
          <div className="model-picker-empty">
            <span>未找到与 “{query}” 匹配的模型</span>
          </div>
        ) : (
          <div className="model-picker-list">
            {filteredModels.map((model) => {
              const isChecked = checkedIds.has(model.id);
              const wasAlreadySaved = initialSavedSet.has(model.id);
              return (
                <div
                  key={model.id}
                  className={`model-picker-row ${isChecked ? "checked" : ""}`}
                  role="checkbox"
                  aria-checked={isChecked}
                  tabIndex={0}
                  onClick={() => toggleCheck(model.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleCheck(model.id);
                    }
                  }}
                >
                  <div className={`model-picker-checkbox ${isChecked ? "active" : ""}`} aria-hidden="true">
                    {isChecked && <Check size={12} strokeWidth={2.8} />}
                  </div>

                  <ModelIcon svg={props.modelIconSvg(model)} />

                  <div className="model-picker-row-info">
                    <span className="model-picker-row-name">
                      {model.displayName === model.id ? model.id : model.displayName}
                    </span>
                    <span className="model-picker-row-id">{model.id}</span>
                  </div>

                  {wasAlreadySaved && (
                    <span className="model-picker-row-status-tag" title="该模型已在您当前的服务列表中">
                      已在列表
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <footer className="model-picker-footer">
        <button
          type="button"
          className="model-picker-cancel-btn"
          onClick={props.onClose}
          disabled={props.saving}
        >
          取消
        </button>
        <button
          type="button"
          className="model-picker-confirm-btn"
          onClick={() => void handleConfirm()}
          disabled={props.saving}
        >
          {props.saving ? "保存中..." : `确认选择 (${checkedIds.size} 个模型)`}
        </button>
      </footer>
    </section>
  );
}
