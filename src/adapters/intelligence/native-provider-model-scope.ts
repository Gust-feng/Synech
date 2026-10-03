import type { Models, MutableModels } from "@earendil-works/pi-ai";
import type { ModelProviderConnectionSettings } from "../../domain/config/index.js";
import { modelProviderConnectionSettingsSchema } from "../../domain/config/model-connection-settings-schema.js";

export type NativeModelFactsScope = {
  readonly profileId?: string;
  readonly piProviderId?: string;
  readonly baseUrl?: string;
  readonly connection?: ModelProviderConnectionSettings;
  readonly secretUpdatedAt?: string;
};

type NativeModelRegistryIdentity = {
  readonly profileId: string;
  readonly descriptor: string;
  readonly connectionDescriptor: string;
};

type NativeModelRegistryReference = {
  readonly identity: NativeModelRegistryIdentity;
  readonly sequence: number;
  readonly providerId: string;
  readonly modelRegistry: Models;
};

type ProfileModelRegistryState = {
  nextSequence: number;
  reference?: NativeModelRegistryReference;
};

type NativeModelRegistryRegistration = {
  readonly identity: NativeModelRegistryIdentity;
  readonly providerId: string;
  successfulSequence?: number;
};

// Retain only the actual Pi registry, never another model list or capability owner.
const profileRegistries = new Map<string, ProfileModelRegistryState>();
const registeredScopes = new WeakMap<Models, NativeModelRegistryRegistration>();

/** Dynamic facts become readable only after a successful Pi refresh. */
export function trackNativeModelRegistry(
  scope: NativeModelFactsScope,
  providerId: string,
  modelRegistry: MutableModels,
): void {
  const identity = registryIdentity(scope);
  if (identity === undefined) return;
  const provider = modelRegistry.getProvider(providerId);
  if (provider?.refreshModels === undefined) return;
  const registration: NativeModelRegistryRegistration = { identity, providerId };
  registeredScopes.set(modelRegistry, registration);
  const refresh = modelRegistry.refresh.bind(modelRegistry);
  modelRegistry.refresh = async (options = {}) => {
    if (options.providers !== undefined && !options.providers.includes(providerId)) {
      return refresh(options);
    }
    let state = profileRegistries.get(identity.profileId);
    if (state === undefined) {
      state = { nextSequence: 0 };
      profileRegistries.set(identity.profileId, state);
    }
    const sequence = ++state.nextSequence;
    registration.successfulSequence = undefined;
    const result = await refresh(options);
    if (!result.aborted && !options.signal?.aborted && !result.errors.has(providerId)) {
      registration.successfulSequence = sequence;
      retainRegistry(identity, sequence, providerId, modelRegistry);
    }
    return result;
  };
}

/**
 * Publish with the credential revision read after refresh. A frozen credential
 * store check prevents relabeling an obsolete account's registry as its replacement.
 */
export async function publishNativeModelRegistry(
  scope: NativeModelFactsScope,
  collection: { readonly providerId: string; readonly modelRegistry: Models },
  options?: { readonly signal?: AbortSignal },
): Promise<boolean> {
  options?.signal?.throwIfAborted();
  const identity = registryIdentity(scope);
  const registration = registeredScopes.get(collection.modelRegistry);
  if (identity === undefined || registration?.successfulSequence === undefined ||
      registration.providerId !== collection.providerId ||
      registration.identity.profileId !== identity.profileId ||
      registration.identity.connectionDescriptor !== identity.connectionDescriptor) {
    return false;
  }
  const sequence = registration.successfulSequence;
  const configured = await collection.modelRegistry.checkAuth(collection.providerId, options);
  options?.signal?.throwIfAborted();
  if (configured === undefined || registration.successfulSequence !== sequence) return false;
  return retainRegistry(identity, sequence, collection.providerId, collection.modelRegistry);
}

/** Model selection and labels do not change a connection's catalog identity. */
export function findNativeModelRegistry(
  scope: NativeModelFactsScope,
): Pick<NativeModelRegistryReference, "providerId" | "modelRegistry"> | undefined {
  const identity = registryIdentity(scope);
  if (identity === undefined) return undefined;
  const reference = profileRegistries.get(identity.profileId)?.reference;
  if (reference === undefined ||
      reference.identity.descriptor !== identity.descriptor) {
    return undefined;
  }
  return reference;
}

function retainRegistry(
  identity: NativeModelRegistryIdentity,
  sequence: number,
  providerId: string,
  modelRegistry: Models,
): boolean {
  const state = profileRegistries.get(identity.profileId);
  if (state === undefined || (state.reference?.sequence ?? 0) > sequence ||
      (state.reference?.sequence === sequence && state.reference.modelRegistry !== modelRegistry)) {
    return false;
  }
  state.reference = { identity, sequence, providerId, modelRegistry };
  return true;
}

function registryIdentity(scope: NativeModelFactsScope): NativeModelRegistryIdentity | undefined {
  const profileId = scope.profileId?.trim();
  const piProviderId = scope.piProviderId?.trim();
  if (!profileId || !piProviderId || scope.baseUrl === undefined) {
    return undefined;
  }
  const connection = scope.connection === undefined
    ? null
    : modelProviderConnectionSettingsSchema.parse(scope.connection);
  const connectionFacts = [piProviderId, scope.baseUrl.trim(), connection];
  const connectionDescriptor = JSON.stringify(connectionFacts);
  return {
    profileId,
    connectionDescriptor,
    descriptor: JSON.stringify([...connectionFacts, scope.secretUpdatedAt ?? null]),
  };
}
