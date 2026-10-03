import React, { useState } from "react";
import { Trash2 } from "lucide-react";
import { resolveModelIconSvgForModel } from "./icons";
import { ModelCatalogPanel } from "./catalog-panel";
import { ModelCapabilityEditor } from "./model-capability-editor";
import { modelCapabilitiesForProfileModel } from "./options";
import type { ModelProviderModelItem } from "./settings-projection";
import { ModelPickerPanel } from "./model-picker-panel";
import { ModelProviderForm } from "./provider-form";
import { ModelProviderAuthPanel } from "./provider-auth-panel";
import { ProviderLogo } from "./settings-icons";
import { ModelProviderList, ProviderDirectory } from "./provider-list";
import { modelProviderFormId } from "./settings-projection";
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
  const [editingModel, setEditingModel] = useState<{
    readonly profileId: string;
    readonly model: ModelProviderModelItem;
  }>();
  const editingProfile = props.config?.profiles?.find((profile) => profile.profileId === editingModel?.profileId);
  const editingConfiguration = editingModel !== undefined && editingProfile?.modelSettings !== undefined &&
    Object.hasOwn(editingProfile.modelSettings, editingModel.model.id)
      ? editingProfile.modelSettings[editingModel.model.id] : undefined;
  const {
    filteredItems,
    showProviderSearch,
    catalogItems,
    query,
    setQuery,
    mutationFailure,
    clearMutationFailure,
    selectedItem,
    selectedForm,
    selectedSecretConfigured,
    selectedProviderIdentity,
    hasApiKeyAction,
    revealed,
    revealBusy,
    modelsFetchBusy,
    fetchFeedback,
    clearFetchFeedback,
    catalogState,
    authState,
    canFetchModels,
    fetchDisabledReason,
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

  return (
    <div className="settings-provider-manager">
      <ModelProviderList
        items={filteredItems}
        selectedItem={selectedItem}
        query={query}
        saving={props.saving}
        reorderEnabled={query.trim().length === 0 && !props.saving}
        failure={mutationFailure}
        onDismissFailure={clearMutationFailure}
        onQueryChange={setQuery}
        onSelect={(item) => { setEditingModel(undefined); selectItem(item); setDirectoryOpen(false); }}
        onReorder={reorderProviders}
        onDeleteProvider={deleteProvider}
        showProviderSearch={showProviderSearch}
        onOpenCatalog={() => { setEditingModel(undefined); setDirectoryOpen(true); }}
      />

      {directoryOpen || selectedItem === undefined ? (
        <ProviderDirectory
          items={catalogItems}
          warnings={props.config?.modelProviderMarket?.warnings}
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
      ) : editingModel !== undefined && editingModel.profileId === selectedItem.profileId ? (
        <ModelCapabilityEditor
          key={JSON.stringify([editingModel.profileId, editingModel.model.id])}
          profileLabel={selectedItem.title}
          model={editingModel.model}
          configuration={editingConfiguration}
          capabilities={modelCapabilitiesForProfileModel(props.config, editingModel.profileId, editingModel.model.id)}
          onClose={() => setEditingModel(undefined)}
          onSave={(settings) => props.onSaveModelConfiguration(editingModel.profileId, editingModel.model.id, settings)}
        />
      ) : catalogState.pickerOpenFor === modelProviderFormId(selectedItem) ? (
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
        <section key={modelProviderFormId(selectedItem)} className="provider-detail-pane" aria-label="模型服务详情">
        <header className="provider-detail-header">
          {selectedItem.protectedBuiltin ? (
            <ProviderLogo item={selectedItem} large />
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
            </>
          )}
          <div className="provider-detail-title-field">
            {selectedItem.protectedBuiltin ? <strong className="provider-detail-fixed-title">{selectedItem.title}</strong> : <input
              value={selectedForm.label}
              disabled={props.saving}
              onChange={(event) => updateModelForm({ label: event.target.value })}
              aria-label="服务名称"
              placeholder={selectedItem.preset?.label ?? "自定义服务"}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
            />}
            {selectedItem.serviceLabel !== undefined && (
              <small className="provider-field-hint">{selectedItem.brandLabel} · {selectedItem.serviceLabel}</small>
            )}
          </div>
          {selectedItem.profileId !== undefined && !selectedItem.protectedBuiltin && (
            <button
              type="button"
              className="provider-detail-delete"
              title="删除此模型服务"
              aria-label={`删除 ${selectedItem.title}`}
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
          authPanel={<ModelProviderAuthPanel
            auth={authState.auth}
            busy={authState.busy || props.saving === true}
            error={authState.error}
            onStart={authState.start}
            onAnswer={authState.answer}
            onCancel={authState.cancel}
            onLogout={authState.logout}
          />}
        />

        <ModelCatalogPanel
          key={modelProviderFormId(selectedItem)}
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
          canFetchModels={canFetchModels}
          fetchDisabledReason={fetchDisabledReason}
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
          onEditModelSettings={selectedItem.profileId === undefined ? undefined : (model) => {
            setEditingModel({ profileId: selectedItem.profileId!, model });
          }}
        />
      </section>
      )}
    </div>
  );
}
