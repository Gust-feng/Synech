import React from "react";
import { resolveModelIconSvgForModel } from "./icons";
import { EmptyBlock } from "../../../components/workspace-common";
import { ModelCatalogPanel } from "./catalog-panel";
import { ModelProviderForm } from "./provider-form";
import { ProviderLogo } from "./settings-icons";
import { ModelProviderList } from "./provider-list";
import {
  useModelProviderManagerState,
  type ModelProviderManagerOptions,
} from "./provider-manager-state";

type ModelProviderManagerProps = ModelProviderManagerOptions & {
  readonly saving?: boolean;
};

export function ModelProviderManager(props: ModelProviderManagerProps): React.ReactElement {
  const controller = useModelProviderManagerState(props);
  const {
    filteredItems,
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
    catalogState,
    selectItem,
    addCustomProvider,
    reorderProviders,
    deleteProvider,
    updateModelForm,
    updateProviderLogo,
    setSelectedModelForm,
    revealSelectedApiKey,
    scheduleSelectedModelSave,
    fetchSelectedModels,
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
        onAddCustomProvider={() => void addCustomProvider()}
        onReorder={reorderProviders}
        onDeleteProvider={deleteProvider}
      />

      <section className="provider-detail-pane" aria-label="模型服务详情">
        <header className="provider-detail-header">
          {selectedBuiltinLocked ? (
            <>
              <ProviderLogo item={selectedItem} large />
              <div className="provider-detail-title">
                <strong>{selectedItem.title}</strong>
              </div>
            </>
          ) : (
            <>
              <label className="provider-detail-logo-edit" aria-label="替换供应商 logo">
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
                  aria-label="供应商名称"
                  placeholder="自定义厂商"
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                />
              </div>
            </>
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
          selectedModelRowId={catalogState.selectedModelRowId}
          modelNameDrafts={catalogState.modelNameDrafts}
          modelIconSvg={(model) => resolveModelIconSvgForModel({
            providerIdentity: selectedProviderIdentity,
            modelId: model.id,
            displayName: model.displayName,
          })}
          saving={props.saving}
          modelsFetchBusy={modelsFetchBusy}
          onModelQueryChange={catalogState.setModelQuery}
          onFetchModels={fetchSelectedModels}
          onSelectCatalogModel={selectCatalogModel}
          onModelNameDraftChange={(modelId, value) => catalogState.setModelNameDrafts((previous) => ({ ...previous, [modelId]: value }))}
          onCommitModelDisplayName={commitModelDisplayName}
          onRemoveCatalogModel={removeCatalogModel}
          onAddCatalogModel={addCatalogModel}
        />
      </section>
    </div>
  );
}
