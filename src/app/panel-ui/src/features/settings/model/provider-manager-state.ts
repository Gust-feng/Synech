import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ConfigResponse, ModelConfiguration, ModelProviderModelCatalog } from "@panel-api/config";
import { resolveModelProviderIdentity } from "./provider-logos";
import { useModelCatalogState } from "./catalog-state";
import { useProviderCatalogActions } from "./provider-catalog-actions";
import { useProviderSaveQueue } from "./provider-save-queue";
import { useModelProviderAuthState, type ModelProviderAuthActions } from "./provider-auth-state";
import { sameStringList } from "./settings-list-equality";
import {
  modelFormFromProviderItem,
  modelProviderFormId,
  modelProviderItems,
  modelProviderPresetItems,
  type ModelForm,
  type ModelProviderListItem,
} from "./settings-projection";
import {
  addProviderKey,
  applyModelProviderProjectionDraft,
  modelFormForProviderItem,
  nextModelProviderProfileId,
  profileDraftFromModelForm,
  profileFromModelForm,
  reconcileModelProviderProjectionDraft,
  removeCreatedProfileDraft,
  settleModelProviderProfileDraft,
  upsertProfileDraft,
  type ModelProviderProjectionDraft,
} from "./provider-projection-draft";
import {
  logoDataUrlFromFileReaderResult,
  supportedLogoMimeType,
} from "./provider-logo-input";

export type ModelProviderManagerOptions = {
  readonly authActions: ModelProviderAuthActions;
  readonly config?: ConfigResponse;
  readonly active?: boolean;
  readonly modelForm: ModelForm;
  readonly setModelForm: (form: ModelForm) => void;
  readonly onSave: (form?: ModelForm) => Promise<void>;
  readonly onCreateCustomProfile: (form?: ModelForm) => Promise<void>;
  readonly onReorderModelProviders: (order: readonly string[]) => Promise<void>;
  readonly onDeleteModelProvider: (profileId: string, fallbackProfileId?: string) => Promise<void>;
  readonly onFetchModels: (profileId?: string) => Promise<ModelProviderModelCatalog | undefined>;
  readonly onSaveModelCatalog: (profileId: string, catalog: ModelProviderModelCatalog) => Promise<void>;
  readonly onSaveModelConfiguration: (profileId: string, modelId: string, settings: ModelConfiguration | null) => Promise<void>;
  readonly onRevealModelApiKey: (profileId: string) => Promise<string | undefined>;
  readonly modelCatalogs?: Readonly<Record<string, ModelProviderModelCatalog>>;
};

export function useModelProviderManagerState(props: ModelProviderManagerOptions) {
  const [providerDraft, setProviderDraft] = useState<ModelProviderProjectionDraft>({
    createdProfiles: [],
    editedProfiles: [],
    removedProfileIds: [],
  });
  const [query, setQuery] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [revealBusy, setRevealBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState("");
  const [mutationFailure, setMutationFailure] = useState<{
    readonly message: string;
    readonly retry?: () => void;
  } | undefined>(undefined);
  const revealSeqRef = useRef(0);
  const providerOrderRef = useRef<readonly string[]>([]);
  const deletedProfileIdsRef = useRef(new Set<string>());
  const selectedKeyRef = useRef(selectedKey);
  const previousSelectedProfileIdRef = useRef<string | undefined>(undefined);
  const saveQueue = useProviderSaveQueue(persistModelForm);
  const revealRef = useRef(props.onRevealModelApiKey);
  revealRef.current = props.onRevealModelApiKey;
  const modelFormRef = useRef(props.modelForm);
  const projectedConfig = useMemo(
    () => applyModelProviderProjectionDraft(props.config, providerDraft),
    [props.config, providerDraft],
  );
  const activeProfileId = projectedConfig?.config?.profileId ?? "";
  const providerItems = useMemo(() => modelProviderItems(projectedConfig), [projectedConfig]);
  const providerItemsRef = useRef(providerItems);
  providerItemsRef.current = providerItems;
  const items = providerItems;
  providerOrderRef.current = items.map((item) => item.key);
  const visibleItems = items;
  const filteredItems = visibleItems.filter((item) => {
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
  const selectedSecretConfigured = selectedItem?.profile?.secretConfigured === true ||
    (selectedActive && projectedConfig?.config?.secretConfigured === true);
  const selectedCatalog = selectedItem?.profileId === undefined ? undefined : props.modelCatalogs?.[selectedItem.profileId];
  const catalogState = useModelCatalogState({ selectedItem, selectedCatalog });
  const selectedProfileId = selectedItem?.profileId;
  const selectedProviderIdentity = selectedItem === undefined ? "unknown" : resolveModelProviderIdentity(selectedItem);
  const selectedBuiltinLocked = selectedItem?.protectedBuiltin === true;
  const hasKey = selectedForm.apiKey.length > 0;
  const hasApiKeyAction = hasKey || selectedSecretConfigured;
  const isActive = props.active !== false;
  modelFormRef.current = selectedForm;
  selectedKeyRef.current = selectedItem?.key ?? "";

  useEffect(() => {
    setProviderDraft((previous) => reconcileModelProviderProjectionDraft(previous, props.config));
  }, [props.config]);

  useEffect(() => {
    if (items.length === 0) return;
    const activeKey = items.find((item) => item.profileId === activeProfileId)?.key;
    if (selectedKey.length > 0 && items.some((item) => item.key === selectedKey)) return;
    setSelectedKey(activeKey ?? items[0]!.key);
  }, [activeProfileId, items, selectedKey]);

  useLayoutEffect(() => {
    const nextProfileId = selectedItem === undefined ? undefined : modelProviderFormId(selectedItem);
    const switchedProvider = previousSelectedProfileIdRef.current !== nextProfileId;
    previousSelectedProfileIdRef.current = nextProfileId;
    if (switchedProvider) {
      // 挑选语义只属于打开时的厂商：切换供应商即清空选择面板与名称草稿
      catalogState.setPickerOpenFor(undefined);
      catalogState.setModelNameDrafts({});
      revealSeqRef.current += 1;
      setRevealBusy(false);
      setRevealed(false);
      catalogState.setModelQuery("");
      catalogState.setSelectedModelRowId(selectedItem?.model.trim() || undefined);
    }
    if (!isActive || selectedItem === undefined) return;
    if (props.modelForm.profileId === modelProviderFormId(selectedItem)) return;
    const nextForm = modelFormFromProviderItem(selectedItem);
    setRevealed(false);
    catalogState.setModelQuery("");
    catalogState.setSelectedModelRowId(nextForm.model.trim().length === 0 ? undefined : nextForm.model);
    props.setModelForm(nextForm);
  }, [isActive, props.setModelForm, selectedItem, props.modelForm.profileId]);

  function selectItem(item: ModelProviderListItem): void {
    if (item.key === selectedItem?.key) return;
    saveQueue.flush();
    setQuery("");
    setSelectedKey(item.key);
    props.setModelForm(modelFormFromProviderItem(item));
  }

  function reportMutationFailure(error: unknown, fallback: string, retry?: () => void): void {
    setMutationFailure({ message: error instanceof Error ? error.message : fallback, retry });
  }

  async function persistModelForm(form: ModelForm): Promise<void> {
    const item = providerItemsRef.current.find((candidate) => candidate.profileId === form.profileId);
    if (item === undefined || deletedProfileIdsRef.current.has(form.profileId)) return;
    const submitted = profileDraftFromModelForm(form, item, item.profile?.secretConfigured === true);
    setMutationFailure(undefined);
    try {
      await props.onSave(form);
    } catch (error) {
      reportMutationFailure(error, "模型服务保存失败。", () => {
        const currentItem = providerItemsRef.current.find((candidate) => candidate.profileId === form.profileId);
        if (currentItem === undefined) return;
        const retryForm = modelFormRef.current.profileId === form.profileId ? modelFormRef.current : form;
        void saveQueue.commit(retryForm).catch(() => undefined);
      });
      throw error;
    } finally {
      // Settle only this submission; a newer edit must survive an older response.
      setProviderDraft((previous) => settleModelProviderProfileDraft(previous, submitted));
    }
  }

  async function addProvider(item: ModelProviderListItem): Promise<void> {
    if (item.presetId === undefined) return;
    const count = providerItems.filter((provider) => provider.presetId === item.presetId).length;
    await createProvider({
      ...modelFormFromProviderItem(item),
      profileId: nextModelProviderProfileId(providerItems, providerDraft.createdProfiles),
      label: count === 0 ? item.title : `${item.title} ${count + 1}`,
    });
  }

  async function addCustomProvider(): Promise<void> {
    const nextForm: ModelForm = {
      profileId: nextModelProviderProfileId(providerItems, providerDraft.createdProfiles),
      label: "自定义服务",
      logoDataUrl: "",
      logoCleared: false,
      baseUrl: "",
      protocolKind: "openai_compatible_chat_completions",
      piProviderId: "",
      model: "",
      apiKey: "",
      apiKeyCleared: false,
    };
    await createProvider(nextForm);
  }

  async function createProvider(nextForm: ModelForm): Promise<void> {
    saveQueue.flush();
    setQuery("");
    const profileId = nextForm.profileId;
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
      void props.onReorderModelProviders(providerOrderRef.current.length > 0 ? providerOrderRef.current : nextOrder).catch((error) => {
        setProviderDraft((previous) => ({ ...previous, order: undefined }));
        reportMutationFailure(error, "模型服务已添加，但排序保存失败。");
      });
    } catch (error) {
      providerOrderRef.current = previousOrder;
      setProviderDraft((previous) => removeCreatedProfileDraft(previous, profileId));
      setSelectedKey((current) => current === nextKey ? "" : current);
      throw error;
    }
  }

  async function reorderProviders(nextOrder: readonly string[]): Promise<void> {
    if (query.trim().length > 0) return;
    const visibleKeys = new Set(nextOrder);
    const orderedVisible = [...nextOrder];
    const completeOrder = providerOrderRef.current.map((key) =>
      visibleKeys.has(key) ? orderedVisible.shift()! : key
    );
    if (sameStringList(providerOrderRef.current, completeOrder)) return;
    providerOrderRef.current = completeOrder;
    setProviderDraft((previous) => ({ ...previous, order: completeOrder }));
    try {
      await props.onReorderModelProviders(completeOrder);
    } catch (error) {
      setProviderDraft((previous) => ({ ...previous, order: undefined }));
      reportMutationFailure(error, "模型服务排序保存失败。");
    }
  }

  async function deleteProvider(item: ModelProviderListItem): Promise<void> {
    if (item.profileId === undefined) return;
    setMutationFailure(undefined);
    saveQueue.discard(item.profileId);
    saveQueue.flush();
    const deletingActive = item.profileId === activeProfileId;
    const fallbackItem =
      items.find((candidate) => candidate.key !== item.key && candidate.configured) ??
      items.find((candidate) => candidate.key !== item.key);
    const fallbackProfile = deletingActive ? fallbackItem?.profile : undefined;
    if (deletingActive && fallbackProfile?.profileId === undefined) {
      try {
        await props.onDeleteModelProvider(item.profileId);
      } catch (error) {
        reportMutationFailure(error, "模型服务删除失败。");
      }
      return;
    }
    const previousOrder = providerOrderRef.current;
    const previousEditedProfile = providerDraft.editedProfiles.find((profile) => profile.profileId === item.profileId);
    const nextOrder = items.map((provider) => provider.key).filter((key) => key !== item.key);
    providerOrderRef.current = nextOrder;
    const wasSelected = selectedItem?.key === item.key;
    deletedProfileIdsRef.current.add(item.profileId);
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
    if (wasSelected) setSelectedKey(fallbackItem?.key ?? "");
    if (wasSelected && fallbackItem !== undefined) props.setModelForm(modelFormFromProviderItem(fallbackItem));
    try {
      await props.onDeleteModelProvider(item.profileId, deletingActive ? fallbackProfile?.profileId : undefined);
    } catch (error) {
      deletedProfileIdsRef.current.delete(item.profileId);
      providerOrderRef.current = previousOrder;
      setProviderDraft((previous) => ({
        ...previous,
        editedProfiles: previousEditedProfile === undefined ? previous.editedProfiles
          : upsertProfileDraft(previous.editedProfiles, previousEditedProfile),
        removedProfileIds: previous.removedProfileIds.filter((profileId) => profileId !== item.profileId),
        activeProfile: previous.activeProfile?.profileId === fallbackProfile?.profileId ? undefined : previous.activeProfile,
        order: previousOrder,
      }));
      if (wasSelected) {
        setSelectedKey((current) => current === (fallbackItem?.key ?? "") ? item.key : current);
        if (selectedKeyRef.current === fallbackItem?.key) props.setModelForm(selectedForm);
      }
      reportMutationFailure(error, "模型服务删除失败。");
    }
  }

  function updateModelForm(patch: Partial<ModelForm>): void {
    if (selectedItem === undefined) return;
    if (selectedItem.protocolKind === "native" && patch.protocolKind !== undefined && patch.protocolKind !== "native") return;
    const authChanged = patch.connection !== undefined &&
      patch.connection.authMode !== selectedForm.connection?.authMode;
    if (authChanged) setRevealed(false);
    const nextForm = modelFormForProviderItem({
      ...selectedForm,
      ...patch,
      ...(authChanged ? { apiKey: "", apiKeyCleared: false } : {}),
    }, selectedItem);
    props.setModelForm(nextForm);
    upsertModelFormDraft(nextForm);
    saveQueue.schedule(nextForm);
  }

  function updateProviderLogo(file: File | undefined): void {
    if (file === undefined || selectedItem === undefined) return;
    const targetItem = selectedItem;
    const mimeType = supportedLogoMimeType(file);
    if (mimeType === undefined) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const currentItem = providerItemsRef.current.find((item) => item.key === targetItem.key);
      if (currentItem === undefined || deletedProfileIdsRef.current.has(modelProviderFormId(currentItem))) return;
      const logoDataUrl = logoDataUrlFromFileReaderResult(reader.result, mimeType);
      if (logoDataUrl === undefined) return;
      const currentForm = selectedKeyRef.current === currentItem.key
        ? modelFormRef.current
        : modelFormFromProviderItem(currentItem);
      const nextForm = modelFormForProviderItem({ ...currentForm, logoDataUrl, logoCleared: false }, currentItem);
      if (selectedKeyRef.current === targetItem.key) props.setModelForm(nextForm);
      upsertModelFormDraftForItem(nextForm, currentItem, currentItem.profile?.secretConfigured === true);
      void saveQueue.commit(nextForm).catch(() => undefined);
    });
    reader.readAsDataURL(file);
  }

  function upsertModelFormDraft(form: ModelForm): void {
    if (selectedItem?.profileId === undefined || form.profileId !== modelFormRef.current.profileId) return;
    upsertModelFormDraftForItem(form, selectedItem, selectedSecretConfigured);
  }

  function upsertModelFormDraftForItem(
    form: ModelForm,
    item: ModelProviderListItem,
    secretConfigured: boolean,
  ): void {
    if (item.profileId === undefined) return;
    if (deletedProfileIdsRef.current.has(item.profileId) ||
      !providerItemsRef.current.some((candidate) => candidate.profileId === item.profileId)) return;
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
      if (seq !== revealSeqRef.current || selectedKeyRef.current !== selectedItem?.key ||
        modelFormRef.current.apiKey !== selectedForm.apiKey ||
        modelFormRef.current.apiKeyCleared !== selectedForm.apiKeyCleared) return;
      if (typeof key === "string" && key.length > 0) {
        const nextForm = modelFormForProviderItem({
          ...modelFormRef.current,
          apiKey: key,
          apiKeyCleared: false,
        }, selectedItem!);
        props.setModelForm(nextForm);
        setRevealed(true);
      }
    } catch (error) {
      reportMutationFailure(error, "API Key 读取失败。");
    } finally {
      if (seq === revealSeqRef.current) setRevealBusy(false);
    }
  }

  function setSelectedModelForm(form: ModelForm): void {
    if (form.profileId !== modelFormRef.current.profileId) return;
    props.setModelForm(selectedItem === undefined ? form : modelFormForProviderItem(form, selectedItem));
  }

  function scheduleSelectedModelSave(form: ModelForm): void {
    if (selectedItem === undefined) return;
    const nextForm = modelFormForProviderItem(form, selectedItem);
    upsertModelFormDraftForItem(nextForm, selectedItem, selectedSecretConfigured);
    saveQueue.schedule(nextForm);
  }

  const catalogActions = useProviderCatalogActions({
    selectedItem,
    selectedForm,
    selectedCatalog,
    catalogState,
    setModelForm: setSelectedModelForm,
    upsertModelFormDraft,
    saveModelImmediately: saveQueue.commit,
    onFetchModels: props.onFetchModels,
    onSaveModelCatalog: async (profileId, catalog) => {
      try {
        await props.onSaveModelCatalog(profileId, catalog);
      } catch (error) {
        reportMutationFailure(error, "模型列表保存失败。");
        throw error;
      }
    },
  });
  const authState = useModelProviderAuthState({
    item: selectedItem,
    form: selectedForm,
    actions: props.authActions,
    saveModelImmediately: saveQueue.commit,
  });
  const authMode = selectedForm.connection?.authMode ?? "api_key";
  const fetchDisabledReason = selectedForm.protocolKind === "native"
    ? authMode === "oauth" && (authState.auth?.configured !== true || authState.auth?.authSession?.status === "pending")
      ? "请先完成账号登录"
      : authMode === "api_key" && !hasApiKeyAction
        ? "请先填写 API Key"
        : undefined
    : selectedForm.baseUrl.trim().length === 0 ? "请先填写服务地址" : undefined;

  return {
    filteredItems,
    showProviderSearch: visibleItems.length > 6 || query.trim().length > 0,
    mutationFailure,
    clearMutationFailure: () => setMutationFailure(undefined),
    catalogItems: modelProviderPresetItems(projectedConfig),
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
    modelsFetchBusy: catalogActions.modelsFetchBusy,
    fetchFeedback: catalogActions.fetchFeedback,
    clearFetchFeedback: catalogActions.clearFetchFeedback,
    catalogState,
    authState,
    canFetchModels: fetchDisabledReason === undefined,
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
    fetchSelectedModels: catalogActions.fetchSelectedModels,
    applySelectedModels: catalogActions.applySelectedModels,
    selectCatalogModel: catalogActions.selectCatalogModel,
    commitModelDisplayName: catalogActions.commitModelDisplayName,
    removeCatalogModel: catalogActions.removeCatalogModel,
    addCatalogModel: catalogActions.addCatalogModel,
  };
}
