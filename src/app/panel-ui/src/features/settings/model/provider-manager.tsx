import React, { useState } from "react";
import { Trash2 } from "lucide-react";
import { resolveModelIconSvgForModel } from "./icons";
import { EmptyBlock } from "../../../components/workspace-common";
import { ModelCatalogPanel } from "./catalog-panel";
import { ModelPickerPanel } from "./model-picker-panel";
import { ModelProviderForm } from "./provider-form";
import { ProviderLogo } from "./settings-icons";
import { ModelProviderList, ProviderDirectory } from "./provider-list";
import {
  useModelProviderManagerState,
  type ModelProviderManagerOptions,
} from "./provider-manager-state";

type ModelProviderManagerProps = ModelProviderManagerOptions & {
  readonly saving?: boolean;
};

export function ModelProviderManager(props: ModelProviderManagerProps): React.ReactElement {
  const controller = useModelProviderManagerState(props);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const {
    filteredItems,
    showProviderSearch,
    catalogItems,
    query,
    setQuery,
    selectedItem,
    selectedForm,
    selectedBuiltinLocked,
    selectedSecretConfigured,
    selectedProviderIdentity,
    hasApiKeyAction,
    revealed,
    revealBusy,
    modelsFetchBusy,
    fetchFeedback,
    clearFetchFeedback,
    catalogState,
    selectItem,
    addProvider,
    addCustomProvider,
    reorderProviders,
    deleteProvider,
    updateModelForm,
    updateProviderLogo,
    setSelectedModelForm,
    revealSelectedApiKey,
    scheduleSelectedModelSave,
    fetchSelectedModels,
    applySelectedModels,
    selectCatalogModel,
    commitModelDisplayName,
    removeCatalogModel,
    addCatalogModel,
  } = controller;

  if (selectedItem === undefined) {
    return (
      <div className="settings-provider-manager empty">
        <EmptyBlock>暂无模型服务。请添加一个模型服务。</EmptyBlock>
      </div>
    );
  }

  return (
    <div className="settings-provider-manager">
      <ModelProviderList
        items={filteredItems}
        selectedItem={selectedItem}
        query={query}
        saving={props.saving}
        reorderEnabled={query.trim().length === 0}
        onQueryChange={setQuery}
        onSelect={selectItem}
        onReorder={reorderProviders}
        onDeleteProvider={deleteProvider}
        showProviderSearch={showProviderSearch}
        onOpenCatalog={() => setDirectoryOpen(true)}
      />

      {directoryOpen ? (
        <ProviderDirectory
          items={catalogItems}
          saving={props.saving}
          onClose={() => setDirectoryOpen(false)}
          onAddProvider={async (item) => {
            await addProvider(item);
            setDirectoryOpen(false);
          }}
          onAddCustomProvider={async () => {
            await addCustomProvider();
            setDirectoryOpen(false);
          }}
        />
      ) : catalogState.pickerOpenFor === selectedItem.key ? (
        <ModelPickerPanel
          item={selectedItem}
          availableModels={catalogState.availableCandidates}
          currentSavedIds={catalogState.catalogModels.map((m) => m.id)}
          modelIconSvg={(model) => resolveModelIconSvgForModel({
            providerIdentity: selectedProviderIdentity,
            modelId: model.id,
            displayName: model.displayName,
          })}
          saving={props.saving}
          onClose={() => catalogState.setPickerOpenFor(undefined)}
          onConfirm={applySelectedModels}
        />
      ) : (
        <section className="provider-detail-pane" aria-label="模型服务详情">
        <header className="provider-detail-header">
          {selectedItem.presetId !== undefined ? (
            <>
              <ProviderLogo item={selectedItem} large />
              <div className="provider-detail-title">
                <strong>{selectedItem.title}</strong>
              </div>
            </>
          ) : (
            <>
              <label className="provider-detail-logo-edit" aria-label="替换服务 logo">
                <ProviderLogo item={{ ...selectedItem, logoDataUrl: selectedForm.logoDataUrl || selectedItem.logoDataUrl }} large />
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  disabled={props.saving}
                  onChange={(event) => {
                    updateProviderLogo(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </label>
              <div className="provider-detail-title-field">
                <input
                  value={selectedForm.label}
                  onChange={(event) => updateModelForm({ label: event.target.value })}
                  aria-label="服务名称"
                  placeholder="自定义服务"
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                />
              </div>
            </>
          )}
          {(selectedItem.presetId === undefined || selectedItem.configured) && (
            <button
              type="button"
              className="provider-detail-delete"
              title={selectedItem.presetId !== undefined ? "重置此服务配置" : "删除此模型服务"}
              aria-label={selectedItem.presetId !== undefined ? `重置 ${selectedItem.title} 配置` : `删除 ${selectedItem.title}`}
              disabled={props.saving}
              onClick={() => void deleteProvider(selectedItem)}
            >
              <Trash2 size={16} />
            </button>
          )}
        </header>

        <div className="provider-detail-divider" />

        <ModelProviderForm
          item={selectedItem}
          modelForm={selectedForm}
          revealed={revealed}
          revealBusy={revealBusy}
          saving={props.saving}
          hasApiKeyAction={hasApiKeyAction}
          selectedSecretConfigured={selectedSecretConfigured}
          onUpdateModelForm={updateModelForm}
          onSetModelForm={setSelectedModelForm}
          onRevealApiKey={revealSelectedApiKey}
          onScheduleModelSave={scheduleSelectedModelSave}
        />

        <ModelCatalogPanel
          catalogModels={catalogState.catalogModels}
          visibleCatalogModels={catalogState.visibleCatalogModels}
          fetchedCandidates={catalogState.fetchedCandidates}
          visibleFetchedCandidates={catalogState.visibleFetchedCandidates}
          fetched={catalogState.fetchedCatalog !== undefined}
          hasModelQuery={catalogState.hasModelQuery}
          showSavedCount={catalogState.showSavedCount}
          showModelSearch={catalogState.showModelSearch}
          modelQuery={catalogState.modelQuery}
          selectedModelRowId={catalogState.selectedModelRowId ?? selectedForm.model ?? selectedItem.model}
          modelNameDrafts={catalogState.modelNameDrafts}
          hasApiKey={hasApiKeyAction}
          modelIconSvg={(model) => resolveModelIconSvgForModel({
            providerIdentity: selectedProviderIdentity,
            modelId: model.id,
            displayName: model.displayName,
          })}
          saving={props.saving}
          modelsFetchBusy={modelsFetchBusy}
          fetchFeedback={fetchFeedback}
          onClearFetchFeedback={clearFetchFeedback}
          onModelQueryChange={catalogState.setModelQuery}
          onFetchModels={fetchSelectedModels}
          onSelectCatalogModel={selectCatalogModel}
          onModelNameDraftChange={(modelId, value) => catalogState.setModelNameDrafts((previous) => ({ ...previous, [modelId]: value }))}
          onCommitModelDisplayName={commitModelDisplayName}
          onRemoveCatalogModel={removeCatalogModel}
          onAddCatalogModel={addCatalogModel}
        />
      </section>
      )}
    </div>
  );
}
