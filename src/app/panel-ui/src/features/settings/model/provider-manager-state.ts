import { useEffect, useMemo, useRef, useState } from "react";
import type { ConfigResponse, ModelProviderModelCatalog } from "@panel-api/config";
import { resolveModelProviderIdentity } from "./provider-logos";
import { useModelCatalogState } from "./catalog-state";
import { useProviderCatalogActions } from "./provider-catalog-actions";
import { useProviderSaveQueue } from "./provider-save-queue";
import { sameStringList } from "./settings-list-equality";
import {
  modelFormFromProviderItem,
  modelProviderFormId,
  modelProviderItems,
  type ModelForm,
  type ModelProviderListItem,
} from "./settings-projection";
import {
  addProviderKey,
  applyModelProviderProjectionDraft,
  modelFormForProviderItem,
  nextCustomProfileId,
  profileDraftFromModelForm,
  profileFromModelForm,
  reconcileModelProviderProjectionDraft,
  removeCreatedProfileDraft,
  upsertProfileDraft,
  type ModelProviderProjectionDraft,
} from "./provider-projection-draft";
import {
  logoDataUrlFromFileReaderResult,
  supportedLogoMimeType,
} from "./provider-logo-input";

export type ModelProviderManagerOptions = {
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
  const revealSeqRef = useRef(0);
  const providerOrderRef = useRef<readonly string[]>([]);
  const lastActiveProfileIdRef = useRef<string | undefined>(undefined);
  const selectedKeyRef = useRef(selectedKey);
  const saveQueue = useProviderSaveQueue(props.onSave);
  const revealRef = useRef(props.onRevealModelApiKey);
  revealRef.current = props.onRevealModelApiKey;
  const modelFormRef = useRef(props.modelForm);
  const projectedConfig = useMemo(
    () => applyModelProviderProjectionDraft(props.config, providerDraft),
    [props.config, providerDraft],
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
    if (props.modelForm.profileId === modelProviderFormId(selectedItem)) return;
    const nextForm = modelFormFromProviderItem(selectedItem);
    setRevealed(false);
    catalogState.setModelQuery("");
    catalogState.setSelectedModelRowId(nextForm.model.trim().length === 0 ? undefined : nextForm.model);
    props.setModelForm(nextForm);
  }, [isActive, props.setModelForm, selectedItem, props.modelForm.profileId]);

  function selectItem(item: ModelProviderListItem): void {
    saveQueue.flush();
    setSelectedKey(item.key);
  }

  async function addCustomProvider(): Promise<void> {
    saveQueue.flush();
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
    }
  }

  async function deleteProvider(item: ModelProviderListItem): Promise<void> {
    if (item.profileId === undefined) return;
    saveQueue.flush();
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
    if (wasSelected) setSelectedKey(fallbackItem?.key ?? "");
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
      if (wasSelected) setSelectedKey((current) => current === (fallbackItem?.key ?? "") ? item.key : current);
    }
  }

  function updateModelForm(patch: Partial<ModelForm>): void {
    if (selectedItem === undefined) return;
    const nextForm = modelFormForProviderItem({ ...selectedForm, ...patch }, selectedItem);
    props.setModelForm(nextForm);
    upsertModelFormDraft(nextForm);
    saveQueue.schedule(nextForm);
  }

  function updateProviderLogo(file: File | undefined): void {
    if (file === undefined || selectedItem === undefined) return;
    const targetItem = selectedItem;
    const targetForm = selectedForm;
    const targetSecretConfigured = selectedSecretConfigured;
    const mimeType = supportedLogoMimeType(file);
    if (mimeType === undefined) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const logoDataUrl = logoDataUrlFromFileReaderResult(reader.result, mimeType);
      if (logoDataUrl === undefined) return;
      const nextForm = modelFormForProviderItem({ ...targetForm, logoDataUrl, logoCleared: false }, targetItem);
      if (selectedKeyRef.current === targetItem.key) props.setModelForm(nextForm);
      upsertModelFormDraftForItem(nextForm, targetItem, targetSecretConfigured);
      void saveQueue.commit(nextForm).catch(() => undefined);
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
    secretConfigured: boolean,
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

  function setSelectedModelForm(form: ModelForm): void {
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
    setModelForm: props.setModelForm,
    upsertModelFormDraft,
    saveModelImmediately: saveQueue.commit,
    saveProvider: saveQueue.save,
    onFetchModels: props.onFetchModels,
    onSaveModelCatalog: props.onSaveModelCatalog,
  });

  return {
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
    modelsFetchBusy: catalogActions.modelsFetchBusy,
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
    fetchSelectedModels: catalogActions.fetchSelectedModels,
    selectCatalogModel: catalogActions.selectCatalogModel,
    commitModelDisplayName: catalogActions.commitModelDisplayName,
    removeCatalogModel: catalogActions.removeCatalogModel,
    addCatalogModel: catalogActions.addCatalogModel,
  };
}
