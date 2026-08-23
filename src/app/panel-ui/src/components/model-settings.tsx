import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  ConfigResponse,
  ModelProviderModelCatalog,
} from "../contracts/config";
import { resolveModelIconSvgForModel } from "../model-icons";
import { resolveModelProviderIdentity } from "../model-provider-logos";
import { EmptyBlock } from "./workspace-common";
import { ModelCatalogPanel } from "./model-catalog-panel";
import { removeRecordKey, useModelCatalogState } from "./model-catalog-state";
import { ModelProviderForm } from "./model-provider-form";
import { ProviderLogo } from "./model-settings-icons";
import { sameStringList } from "./model-settings-list-equality";
import { ModelProviderList } from "./model-provider-list";
import {
  modelFormFromProviderItem,
  modelProviderFormId,
  modelProviderItems,
  type ModelForm,
  type ModelProviderListItem,
  type ModelProviderModelItem,
  type ModelProviderProfileItem,
} from "./model-settings-projection";
export type { ModelForm } from "./model-settings-projection";

const LOGO_FILE_MAX_BYTES = 3 * 1024 * 1024;
const LOGO_FILE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);
const LOGO_FILE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

type ModelProviderProjectionDraft = {
  readonly createdProfiles: readonly ModelProviderProfileItem[];
  readonly editedProfiles: readonly ModelProviderProfileItem[];
  readonly removedProfileIds: readonly string[];
  readonly activeProfile?: ModelProviderProfileItem;
  readonly order?: readonly string[];
};

export function ModelSettings(props: {
  readonly config?: ConfigResponse;
  readonly active?: boolean;
  readonly modelForm: ModelForm;
  readonly setModelForm: (form: ModelForm) => void;
  readonly saving?: boolean;
  readonly onSave: (form?: ModelForm) => Promise<void>;
  readonly onCreateCustomProfile: (form?: ModelForm) => Promise<void>;
  readonly onReorderModelProviders: (order: readonly string[]) => Promise<void>;
  readonly onDeleteModelProvider: (profileId: string, fallbackProfileId?: string) => Promise<void>;
  readonly onFetchModels: (profileId?: string) => Promise<ModelProviderModelCatalog | undefined>;
  readonly onSaveModelCatalog: (profileId: string, catalog: ModelProviderModelCatalog) => Promise<void>;
  readonly onRevealModelApiKey: (profileId: string) => Promise<string | undefined>;
  readonly modelCatalogs?: Readonly<Record<string, ModelProviderModelCatalog>>;
}): React.ReactElement {
  const [providerDraft, setProviderDraft] = useState<ModelProviderProjectionDraft>({
    createdProfiles: [],
    editedProfiles: [],
    removedProfileIds: [],
  });
  const [query, setQuery] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [revealBusy, setRevealBusy] = useState(false);
  const [modelsFetchBusy, setModelsFetchBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState("");
  const saveTimerRef = useRef<number | undefined>(undefined);
  const pendingModelSaveRef = useRef<ModelForm | undefined>(undefined);
  const revealSeqRef = useRef(0);
  const providerOrderRef = useRef<readonly string[]>([]);
  const lastActiveProfileIdRef = useRef<string | undefined>(undefined);
  const selectedKeyRef = useRef(selectedKey);
  const saveRef = useRef(props.onSave);
  saveRef.current = props.onSave;
  const revealRef = useRef(props.onRevealModelApiKey);
  revealRef.current = props.onRevealModelApiKey;
  const modelFormRef = useRef(props.modelForm);
  const projectedConfig = useMemo(
    () => applyModelProviderProjectionDraft(props.config, providerDraft),
    [props.config, providerDraft]
  );
  const activeProfileId = projectedConfig?.config?.profileId ?? "";
  const providerItems = useMemo(() => modelProviderItems(projectedConfig), [projectedConfig]);
  const items = providerItems;
  providerOrderRef.current = items.map((item) => item.key);
  const filteredItems = items.filter((item) => {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) return true;
    return [item.title, item.model, item.baseUrl].some((value) => value.toLowerCase().includes(normalized));
  });
  const selectedItem =
    items.find((item) => item.key === selectedKey) ??
    items.find((item) => item.profileId === activeProfileId) ??
    items[0];
  const selectedForm =
    selectedItem === undefined || props.modelForm.profileId === modelProviderFormId(selectedItem)
      ? props.modelForm
      : modelFormFromProviderItem(selectedItem);
  const selectedActive = selectedItem?.profileId !== undefined && selectedItem.profileId === activeProfileId;
  const selectedSecretConfigured = selectedItem?.profile?.secretConfigured === true || (selectedActive && projectedConfig?.config?.secretConfigured === true);
  const selectedCatalog = selectedItem?.profileId === undefined ? undefined : props.modelCatalogs?.[selectedItem.profileId];
  const catalogState = useModelCatalogState({ selectedItem, selectedCatalog });
  const selectedProfileId = selectedItem?.profileId;
  const selectedProviderIdentity = selectedItem === undefined ? "unknown" : resolveModelProviderIdentity(selectedItem);
  const selectedBuiltinLocked = selectedItem?.protectedBuiltin === true;
  const hasKey = selectedForm.apiKey.length > 0;
  const hasApiKeyAction = hasKey || selectedSecretConfigured;
  const isActive = props.active !== false;
  modelFormRef.current = selectedForm;
  selectedKeyRef.current = selectedKey;

  useEffect(() => {
    setProviderDraft((previous) => reconcileModelProviderProjectionDraft(previous, props.config));
  }, [props.config]);

  useEffect(() => {
    if (items.length === 0) return;
    const activeKey = items.find((item) => item.profileId === activeProfileId)?.key;
    if (activeProfileId !== lastActiveProfileIdRef.current) {
      lastActiveProfileIdRef.current = activeProfileId;
      setSelectedKey(activeKey ?? items[0]!.key);
      return;
    }
    if (selectedKey.length > 0 && items.some((item) => item.key === selectedKey)) return;
    setSelectedKey(activeKey ?? items[0]!.key);
  }, [activeProfileId, items, selectedKey]);

  useEffect(() => {
    if (!isActive || selectedItem === undefined) return;
    // 表单已经指向选中项时不重复初始化：保存厂商配置后激活关系会把预设项的 key
    // 从 preset:X 翻转为 profile:X，若此时重置表单会清掉用户刚输入的 API Key。
    if (props.modelForm.profileId === modelProviderFormId(selectedItem)) return;
    const nextForm = modelFormFromProviderItem(selectedItem);
    setRevealed(false);
    catalogState.setModelQuery("");
    catalogState.setSelectedModelRowId(nextForm.model.trim().length === 0 ? undefined : nextForm.model);
    props.setModelForm(nextForm);
  }, [isActive, props.setModelForm, selectedItem, props.modelForm.profileId]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== undefined) {
        window.clearTimeout(saveTimerRef.current);
      }
      const pending = pendingModelSaveRef.current;
      pendingModelSaveRef.current = undefined;
      if (pending !== undefined) {
        void saveRef.current(pending).catch(() => undefined);
      }
    };
  }, []);

  function scheduleModelSave(nextForm: ModelForm): void {
    pendingModelSaveRef.current = nextForm;
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = undefined;
      const pending = pendingModelSaveRef.current;
      pendingModelSaveRef.current = undefined;
      if (pending !== undefined) {
        void saveRef.current(pending).catch(() => undefined);
      }
    }, 700);
  }

  async function saveModelImmediately(nextForm: ModelForm): Promise<void> {
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    pendingModelSaveRef.current = undefined;
    await saveRef.current(nextForm);
  }

  function flushScheduledModelSave(): void {
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    const pending = pendingModelSaveRef.current;
    pendingModelSaveRef.current = undefined;
    if (pending !== undefined) {
      void saveRef.current(pending).catch(() => undefined);
    }
  }

  function selectItem(item: ModelProviderListItem): void {
    flushScheduledModelSave();
    setSelectedKey(item.key);
  }

  async function addCustomProvider(): Promise<void> {
    flushScheduledModelSave();
    const profileId = nextCustomProfileId(providerItems, providerDraft.createdProfiles);
    const nextForm: ModelForm = {
      profileId,
      label: "自定义厂商",
      logoDataUrl: "",
      logoCleared: false,
      baseUrl: "https://api.example.com/v1",
      protocolKind: "openai_compatible_chat_completions",
      model: "",
      apiKey: "",
      apiKeyCleared: false,
    };
    const nextProfile = profileFromModelForm(nextForm, projectedConfig?.config?.defaultAiMode);
    const nextKey = `profile:${profileId}`;
    const previousOrder = providerOrderRef.current;
    const nextOrder = addProviderKey(providerOrderRef.current, undefined, nextKey);
    providerOrderRef.current = nextOrder;
    setSelectedKey(nextKey);
    props.setModelForm(nextForm);
    setProviderDraft((previous) => ({
      ...previous,
      createdProfiles: upsertProfileDraft(previous.createdProfiles, nextProfile),
      removedProfileIds: previous.removedProfileIds.filter((removedProfileId) => removedProfileId !== profileId),
      activeProfile: nextProfile,
      order: nextOrder,
    }));
    try {
      await props.onCreateCustomProfile(nextForm);
      void props.onReorderModelProviders(providerOrderRef.current.length > 0 ? providerOrderRef.current : nextOrder).catch(() => {
        setProviderDraft((previous) => ({ ...previous, order: undefined }));
      });
    } catch {
      providerOrderRef.current = previousOrder;
      setProviderDraft((previous) => removeCreatedProfileDraft(previous, profileId));
      setSelectedKey((current) => current === nextKey ? "" : current);
      // The parent owns user-facing error state.
    }
  }

  async function reorderProviders(nextOrder: readonly string[]): Promise<void> {
    if (query.trim().length > 0 || sameStringList(providerOrderRef.current, nextOrder)) return;
    providerOrderRef.current = nextOrder;
    setProviderDraft((previous) => ({ ...previous, order: nextOrder }));
    try {
      await props.onReorderModelProviders(nextOrder);
    } catch {
      setProviderDraft((previous) => ({ ...previous, order: undefined }));
      // The parent owns user-facing error state.
    }
  }

  async function deleteProvider(item: ModelProviderListItem): Promise<void> {
    if (item.profileId === undefined) return;
    flushScheduledModelSave();
    const deletingActive = item.profileId === activeProfileId;
    const fallbackItem = items.find((candidate) => candidate.key !== item.key);
    const fallbackProfile = deletingActive ? fallbackItem?.profile : undefined;
    if (deletingActive && fallbackProfile?.profileId === undefined) {
      try {
        await props.onDeleteModelProvider(item.profileId);
      } catch {
        // The parent owns user-facing error state.
      }
      return;
    }
    const previousOrder = providerOrderRef.current;
    const nextOrder = items.map((provider) => provider.key).filter((key) => key !== item.key);
    providerOrderRef.current = nextOrder;
    const wasSelected = selectedKey === item.key;
    setProviderDraft((previous) => ({
      ...previous,
      createdProfiles: previous.createdProfiles.filter((profile) => profile.profileId !== item.profileId),
      editedProfiles: previous.editedProfiles.filter((profile) => profile.profileId !== item.profileId),
      removedProfileIds: [...new Set([...previous.removedProfileIds, item.profileId!])],
      activeProfile: deletingActive
        ? fallbackProfile
        : previous.activeProfile?.profileId === item.profileId
          ? undefined
          : previous.activeProfile,
      order: nextOrder,
    }));
    if (wasSelected) {
      setSelectedKey(fallbackItem?.key ?? "");
    }
    try {
      await props.onDeleteModelProvider(item.profileId, deletingActive ? fallbackProfile?.profileId : undefined);
    } catch {
      providerOrderRef.current = previousOrder;
      setProviderDraft((previous) => ({
        ...previous,
        removedProfileIds: previous.removedProfileIds.filter((profileId) => profileId !== item.profileId),
        activeProfile: previous.activeProfile?.profileId === fallbackProfile?.profileId ? undefined : previous.activeProfile,
        order: previousOrder,
      }));
      if (wasSelected) {
        setSelectedKey((current) => current === (fallbackItem?.key ?? "") ? item.key : current);
      }
      // The parent owns user-facing error state.
    }
  }

  function updateModelForm(patch: Partial<ModelForm>): void {
    if (selectedItem === undefined) return;
    const nextForm = modelFormForProviderItem({ ...selectedForm, ...patch }, selectedItem);
    props.setModelForm(nextForm);
    upsertModelFormDraft(nextForm);
    scheduleModelSave(nextForm);
  }

  function updateProviderLogo(file: File | undefined): void {
    if (file === undefined || selectedItem === undefined) return;
    const targetItem = selectedItem;
    const targetForm = selectedForm;
    const targetSecretConfigured = selectedSecretConfigured;
    const mimeType = supportedLogoMimeType(file);
    if (mimeType === undefined || file.size > LOGO_FILE_MAX_BYTES) {
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const logoDataUrl = logoDataUrlFromFileReaderResult(reader.result, mimeType);
      if (logoDataUrl === undefined) return;
      const nextForm = modelFormForProviderItem({ ...targetForm, logoDataUrl, logoCleared: false }, targetItem);
      if (selectedKeyRef.current === targetItem.key) {
        props.setModelForm(nextForm);
      }
      upsertModelFormDraftForItem(nextForm, targetItem, targetSecretConfigured);
      void saveModelImmediately(nextForm).catch(() => undefined);
    });
    reader.readAsDataURL(file);
  }

  function upsertModelFormDraft(form: ModelForm): void {
    if (selectedItem?.profileId === undefined) return;
    upsertModelFormDraftForItem(form, selectedItem, selectedSecretConfigured);
  }

  function upsertModelFormDraftForItem(
    form: ModelForm,
    item: ModelProviderListItem,
    secretConfigured: boolean
  ): void {
    if (item.profileId === undefined) return;
    const nextProfile = profileDraftFromModelForm(modelFormForProviderItem(form, item), item, secretConfigured);
    setProviderDraft((previous) => {
      const isCreatedProfile = previous.createdProfiles.some((profile) => profile.profileId === nextProfile.profileId);
      return {
        ...previous,
        createdProfiles: isCreatedProfile
          ? upsertProfileDraft(previous.createdProfiles, nextProfile)
          : previous.createdProfiles,
        editedProfiles: isCreatedProfile
            ? previous.editedProfiles.filter((profile) => profile.profileId !== nextProfile.profileId)
            : upsertProfileDraft(previous.editedProfiles, nextProfile),
        activeProfile:
          previous.activeProfile?.profileId === nextProfile.profileId || activeProfileId === nextProfile.profileId
            ? nextProfile
            : previous.activeProfile,
      };
    });
  }

  async function revealSelectedApiKey(): Promise<void> {
    if (selectedProfileId === undefined || revealBusy) return;
    if (revealed && selectedForm.apiKey.length > 0) {
      setRevealed(false);
      return;
    }
    const seq = ++revealSeqRef.current;
    setRevealBusy(true);
    try {
      const key = await revealRef.current(selectedProfileId);
      if (seq !== revealSeqRef.current || selectedKeyRef.current !== selectedItem?.key) return;
      if (typeof key === "string" && key.length > 0) {
        const nextForm = modelFormForProviderItem({
          ...modelFormRef.current,
          apiKey: key,
          apiKeyCleared: false,
        }, selectedItem!);
        props.setModelForm(nextForm);
        setRevealed(true);
      }
    } finally {
      if (seq === revealSeqRef.current) setRevealBusy(false);
    }
  }

  async function fetchSelectedModels(): Promise<void> {
    if (selectedItem === undefined) return;
    const profileId = selectedItem.profileId ?? modelProviderFormId(selectedItem);
    setModelsFetchBusy(true);
    try {
      if (selectedItem.profileId === undefined) {
        await saveRef.current(modelFormForProviderItem(selectedForm, selectedItem));
      }
      const catalog = await props.onFetchModels(profileId);
      if (catalog !== undefined) {
        catalogState.setFetchedCatalogs((previous) => ({ ...previous, [catalog.profileId]: catalog }));
      }
    } catch {
      // The parent owns user-facing error state.
    } finally {
      setModelsFetchBusy(false);
    }
  }

  async function saveCatalogModels(models: readonly ModelProviderModelItem[]): Promise<void> {
    if (selectedItem?.profileId === undefined) return;
    const catalog = selectedCatalog ?? catalogState.fetchedCatalog ?? {
      profileId: selectedItem.profileId,
      label: selectedItem.title,
      baseUrl: selectedItem.baseUrl,
      modelsPath: "/models",
      fetchedAt: new Date().toISOString(),
      models: [],
    };
    await props.onSaveModelCatalog(selectedItem.profileId, {
      ...catalog,
      profileId: selectedItem.profileId,
      label: catalog.label ?? selectedItem.title,
      baseUrl: catalog.baseUrl || selectedItem.baseUrl,
      fetchedAt: new Date().toISOString(),
      models,
    });
  }

  async function addCatalogModel(model: ModelProviderModelItem): Promise<void> {
    if (selectedItem?.profileId === undefined) return;
    const profileId = selectedItem.profileId;
    const nextModels = [...catalogState.catalogModels.filter((item) => item.id !== model.id), model];
    try {
      await saveCatalogModels(nextModels);
    } catch {
      return;
    }
    catalogState.setFetchedCatalogs((previous) => {
      const current = previous[profileId];
      if (current === undefined) return previous;
      return {
        ...previous,
        [profileId]: {
          ...current,
          models: current.models.filter((item) => item.id !== model.id),
        },
      };
    });
  }

  async function removeCatalogModel(modelId: string): Promise<void> {
    const nextModels = (selectedCatalog?.models ?? catalogState.catalogModels).filter((model) => model.id !== modelId);
    if (selectedForm.model === modelId || selectedItem?.model === modelId) {
      const nextForm = selectedItem === undefined
        ? { ...selectedForm, model: "" }
        : modelFormForProviderItem({ ...selectedForm, model: "" }, selectedItem);
      props.setModelForm(nextForm);
      upsertModelFormDraft(nextForm);
      catalogState.setSelectedModelRowId(undefined);
    }
    catalogState.setModelNameDrafts((previous) => removeRecordKey(previous, modelId));
    try {
      await saveCatalogModels(nextModels);
    } catch {
      return;
    }
  }

  function selectCatalogModel(modelId: string): void {
    catalogState.setSelectedModelRowId(modelId);
    if (selectedForm.model === modelId) return;
    if (selectedItem === undefined) return;
    const nextForm = modelFormForProviderItem({ ...selectedForm, model: modelId }, selectedItem);
    props.setModelForm(nextForm);
    upsertModelFormDraft(nextForm);
    void saveModelImmediately(nextForm).catch(() => undefined);
  }

  function setSelectedModelForm(form: ModelForm): void {
    if (selectedItem === undefined) {
      props.setModelForm(form);
      return;
    }
    props.setModelForm(modelFormForProviderItem(form, selectedItem));
  }

  function scheduleSelectedModelSave(form: ModelForm): void {
    if (selectedItem === undefined) return;
    const nextForm = modelFormForProviderItem(form, selectedItem);
    upsertModelFormDraftForItem(nextForm, selectedItem, selectedSecretConfigured);
    scheduleModelSave(nextForm);
  }

  async function commitModelDisplayName(modelId: string, value: string): Promise<void> {
    const model = catalogState.catalogModels.find((item) => item.id === modelId);
    if (model === undefined) return;
    const displayName = value.trim().length === 0 ? model.id : value.trim();
    if (displayName === model.displayName) {
      catalogState.setModelNameDrafts((previous) => removeRecordKey(previous, modelId));
      return;
    }
    try {
      await saveCatalogModels(catalogState.catalogModels.map((item) => item.id === modelId ? { ...item, displayName } : item));
      catalogState.setModelNameDrafts((previous) => removeRecordKey(previous, modelId));
    } catch {
      // The parent owns user-facing error state.
    }
  }

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

function nextCustomProfileId(
  items: readonly ModelProviderListItem[],
  createdProfiles: readonly ModelProviderProfileItem[],
): string {
  const existingIds = new Set([
    ...items.map((item) => item.profileId).filter((id): id is string => id !== undefined),
    ...createdProfiles.map((profile) => profile.profileId).filter((id): id is string => id !== undefined),
  ]);
  let profileId = "";
  do {
    profileId = `custom_${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
  } while (existingIds.has(profileId));
  return profileId;
}

function applyModelProviderProjectionDraft(
  config: ConfigResponse | undefined,
  draft: ModelProviderProjectionDraft
): ConfigResponse | undefined {
  if (
    config === undefined ||
    (draft.createdProfiles.length === 0 &&
      draft.editedProfiles.length === 0 &&
      draft.removedProfileIds.length === 0 &&
      draft.activeProfile === undefined &&
      draft.order === undefined)
  ) {
    return config;
  }
  const removedProfileIds = new Set(draft.removedProfileIds);
  const profiles = new Map<string, ModelProviderProfileItem>();
  for (const profile of config.profiles ?? []) {
    if (profile.profileId !== undefined && !removedProfileIds.has(profile.profileId)) {
      profiles.set(profile.profileId, profile);
    }
  }
  for (const profile of draft.createdProfiles) {
    if (profile.profileId !== undefined && !removedProfileIds.has(profile.profileId)) {
      profiles.set(profile.profileId, profile);
    }
  }
  for (const profile of draft.editedProfiles) {
    if (profile.profileId !== undefined && !removedProfileIds.has(profile.profileId)) {
      profiles.set(profile.profileId, profile);
    }
  }
  const nextProfiles = [...profiles.values()];
  const currentProfileId = config.config?.profileId;
  const currentConfigRemoved = currentProfileId !== undefined && removedProfileIds.has(currentProfileId);
  const activeProfile =
    draft.activeProfile ??
    (currentConfigRemoved ? nextProfiles[0] : currentProfileId === undefined ? config.config : profiles.get(currentProfileId) ?? config.config) ??
    nextProfiles[0];
  return {
    ...config,
    config: activeProfile,
    profile: activeProfile,
    profiles: nextProfiles,
    modelProviderOrder: draft.order ?? config.modelProviderOrder,
    modelCatalogs: config.modelCatalogs?.filter((catalog) => !removedProfileIds.has(catalog.profileId)),
  };
}

function reconcileModelProviderProjectionDraft(
  draft: ModelProviderProjectionDraft,
  config: ConfigResponse | undefined
): ModelProviderProjectionDraft {
  if (config === undefined) return draft;
  const serverProfileIds = new Set((config.profiles ?? []).map((profile) => profile.profileId).filter(isDefinedString));
  const serverProfilesById = new Map((config.profiles ?? [])
    .filter((profile): profile is ModelProviderProfileItem & { readonly profileId: string } => profile.profileId !== undefined)
    .map((profile) => [profile.profileId, profile]));
  const nextCreatedProfiles = draft.createdProfiles.filter((profile) => profile.profileId === undefined || !serverProfileIds.has(profile.profileId));
  const nextEditedProfiles = draft.editedProfiles.filter((profile) => {
    if (profile.profileId === undefined) return false;
    const serverProfile = serverProfilesById.get(profile.profileId);
    return serverProfile === undefined || !sameProjectedProfile(serverProfile, profile);
  });
  const nextRemovedProfileIds = draft.removedProfileIds.filter((profileId) => serverProfileIds.has(profileId));
  const nextActiveProfile = draft.activeProfile?.profileId === config.config?.profileId ? undefined : draft.activeProfile;
  const nextOrder = sameStringList(draft.order, config.modelProviderOrder) ? undefined : draft.order;
  if (
    sameProfileList(nextCreatedProfiles, draft.createdProfiles) &&
    sameProfileList(nextEditedProfiles, draft.editedProfiles) &&
    sameStringList(nextRemovedProfileIds, draft.removedProfileIds) &&
    nextActiveProfile === draft.activeProfile &&
    nextOrder === draft.order
  ) {
    return draft;
  }
  return {
    createdProfiles: nextCreatedProfiles,
    editedProfiles: nextEditedProfiles,
    removedProfileIds: nextRemovedProfileIds,
    activeProfile: nextActiveProfile,
    order: nextOrder,
  };
}

function profileFromModelForm(
  form: ModelForm,
  defaultAiMode: ModelProviderProfileItem["defaultAiMode"] | undefined
): ModelProviderProfileItem {
  return {
    profileId: form.profileId,
    label: form.label.trim() || form.profileId,
    logoDataUrl: logoDataUrlFromModelForm(form),
    providerKind: "openai_compatible",
    protocolKind: form.protocolKind || "openai_compatible_chat_completions",
    baseUrl: form.baseUrl,
    model: form.model,
    defaultAiMode,
    secretConfigured: form.apiKey.length > 0 ? true : undefined,
  };
}

function profileDraftFromModelForm(
  form: ModelForm,
  item: ModelProviderListItem,
  selectedSecretConfigured: boolean
): ModelProviderProfileItem {
  const fallback = item.profile;
  const profileId = item.profileId || modelProviderFormId(item);
  return {
    profileId,
    label: form.label.trim() || fallback?.label || item.title || profileId,
    logoDataUrl: item.protectedBuiltin ? item.logoDataUrl : logoDataUrlFromModelForm(form),
    providerKind: fallback?.providerKind ?? item.preset?.providerKind ?? "openai_compatible",
    protocolKind: form.protocolKind || fallback?.protocolKind || item.protocolKind,
    baseUrl: form.baseUrl || fallback?.baseUrl || item.baseUrl,
    model: form.model,
    defaultAiMode: fallback?.defaultAiMode,
    secretConfigured: form.apiKeyCleared ? false : form.apiKey.length > 0 ? true : fallback?.secretConfigured ?? selectedSecretConfigured,
  };
}

function logoDataUrlFromModelForm(form: ModelForm): string | undefined {
  if (form.logoCleared) return undefined;
  return form.logoDataUrl.trim().length > 0 ? form.logoDataUrl : undefined;
}

function modelFormForProviderItem(form: ModelForm, item: ModelProviderListItem): ModelForm {
  return form.profileId === modelProviderFormId(item) ? form : modelFormFromProviderItem(item);
}

function upsertProfileDraft(
  profiles: readonly ModelProviderProfileItem[],
  nextProfile: ModelProviderProfileItem
): readonly ModelProviderProfileItem[] {
  return [
    ...profiles.filter((profile) => profile.profileId !== nextProfile.profileId),
    nextProfile,
  ];
}

function removeCreatedProfileDraft(
  draft: ModelProviderProjectionDraft,
  profileId: string
): ModelProviderProjectionDraft {
  const profileKey = `profile:${profileId}`;
  const order = draft.order?.filter((key) => key !== profileKey);
  return {
    ...draft,
    createdProfiles: draft.createdProfiles.filter((profile) => profile.profileId !== profileId),
    editedProfiles: draft.editedProfiles.filter((profile) => profile.profileId !== profileId),
    activeProfile: draft.activeProfile?.profileId === profileId ? undefined : draft.activeProfile,
    order: order === undefined || order.length === 0 ? undefined : order,
  };
}

function addProviderKey(
  currentKeys: readonly string[],
  previousKey: string | undefined,
  nextKey: string
): readonly string[] {
  const withoutAddedKey = currentKeys.filter((key) => key !== nextKey && key !== previousKey);
  return [...withoutAddedKey, nextKey];
}

function sameProfileList(
  left: readonly ModelProviderProfileItem[],
  right: readonly ModelProviderProfileItem[]
): boolean {
  return left.length === right.length && left.every((profile, index) => profile === right[index]);
}

function sameProjectedProfile(left: ModelProviderProfileItem, right: ModelProviderProfileItem): boolean {
  return left.profileId === right.profileId &&
    left.label === right.label &&
    left.logoDataUrl === right.logoDataUrl &&
    left.providerKind === right.providerKind &&
    left.protocolKind === right.protocolKind &&
    left.baseUrl === right.baseUrl &&
    left.model === right.model &&
    left.defaultAiMode === right.defaultAiMode;
}

function isDefinedString(value: string | undefined): value is string {
  return value !== undefined;
}

function supportedLogoMimeType(file: File): string | undefined {
  if (LOGO_FILE_TYPES.has(file.type)) {
    return file.type;
  }
  const normalizedName = file.name.toLowerCase();
  const extension = Object.keys(LOGO_FILE_MIME_BY_EXTENSION).find((item) => normalizedName.endsWith(item));
  return extension === undefined ? undefined : LOGO_FILE_MIME_BY_EXTENSION[extension];
}

function logoDataUrlFromFileReaderResult(result: FileReader["result"], mimeType: string): string | undefined {
  if (typeof result !== "string") {
    return undefined;
  }
  const separator = result.indexOf(",");
  if (!result.startsWith("data:") || separator < 0) {
    return undefined;
  }
  return `data:${mimeType};base64,${result.slice(separator + 1)}`;
}
