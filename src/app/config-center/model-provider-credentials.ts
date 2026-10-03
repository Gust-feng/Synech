import type { LocalDevSecretStore, ModelProviderProfileSettings } from "../../domain/config/index.js";
import { ConfigSchemaValidationError } from "./settings-utils.js";

/** OAuth credentials live in their own slot so switching authentication modes never destroys a login. */
export function modelProviderOAuthSecretRef(profileId: string): string {
  return `secret://local-dev/model-provider/${profileId}/oauth`;
}

export function modelProviderCredentialSecretRef(profile: ModelProviderProfileSettings): string {
  return profile.protocolKind === "native" && profile.connection?.authMode === "oauth"
    ? modelProviderOAuthSecretRef(profile.profileId)
    : profile.secretRef;
}

export async function readModelProviderCredential(
  secretStore: LocalDevSecretStore,
  profile: ModelProviderProfileSettings,
): Promise<unknown | undefined> {
  const value = await secretStore.readSecret(modelProviderCredentialSecretRef(profile));
  if (value === undefined) return undefined;
  if (profile.protocolKind !== "native") return { type: "api_key", key: value };
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw new Error(`Invalid native credential for profile ${profile.profileId}.`, { cause });
  }
}

export async function readModelProviderKey(
  secretStore: LocalDevSecretStore,
  profile: ModelProviderProfileSettings,
): Promise<string | undefined> {
  if (profile.protocolKind !== "native") return secretStore.readSecret(profile.secretRef);
  if (profile.connection?.authMode === "oauth" || profile.connection?.authMode === "ambient") return undefined;
  const credential = await readModelProviderCredential(secretStore, profile);
  if (credential === undefined) return undefined;
  if (typeof credential !== "object" || credential === null || !("type" in credential)) {
    throw new ConfigSchemaValidationError(`Invalid native credential for profile ${profile.profileId}.`);
  }
  if (credential.type !== "api_key") return undefined;
  if (!("key" in credential) || credential.key === undefined) return undefined;
  if (typeof credential.key !== "string") {
    throw new ConfigSchemaValidationError(`Invalid native API key for profile ${profile.profileId}.`);
  }
  return credential.key;
}

export async function writeModelProviderKey(
  secretStore: LocalDevSecretStore,
  profile: ModelProviderProfileSettings,
  key: string,
): Promise<void> {
  if (profile.protocolKind === "native" && profile.connection?.authMode !== "api_key") {
    throw new ConfigSchemaValidationError("This model service does not use an API key.");
  }
  await secretStore.writeSecret(
    profile.secretRef,
    profile.protocolKind === "native" ? JSON.stringify({ type: "api_key", key }) : key,
  );
}

export function modelProviderConnectionIdentity(profile: ModelProviderProfileSettings): string {
  return JSON.stringify([
    profile.protocolKind,
    profile.piProviderId,
    profile.baseUrl,
    profile.connection,
    profile.secretRef,
  ]);
}
