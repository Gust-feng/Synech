import type {
  AuthOperationOptions,
  Credential,
  CredentialStore,
  ProviderEnv,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import type {
  ModelProviderAuthMode,
  ModelProviderConnectionSettings,
  ModelProviderCredentialStorePort,
} from "../../domain/config/index.js";

const piCredentialSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("api_key"),
    key: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  }).strict(),
  z.object({
    type: z.literal("oauth"),
    refresh: z.string(),
    access: z.string(),
    expires: z.number().finite(),
  }).passthrough(),
]);

/** Move native login's public setup fields to their product owner before publication. */
export function normalizeNativeCredentialPublication(input: {
  readonly piProviderId: string;
  readonly connection: ModelProviderConnectionSettings;
  readonly credential: unknown;
}): {
  readonly connection: ModelProviderConnectionSettings;
  readonly credential: unknown | undefined;
} {
  const credential = piCredentialSchema.parse(input.credential);
  if (credential.type === "oauth") {
    return { connection: { ...input.connection, authMode: "oauth" }, credential };
  }
  const connection = { ...input.connection };
  const env = credential.env;
  switch (input.piProviderId) {
    case "google-vertex":
      if (env?.GOOGLE_CLOUD_PROJECT !== undefined) connection.cloudProject = env.GOOGLE_CLOUD_PROJECT;
      if (env?.GOOGLE_CLOUD_LOCATION !== undefined) connection.cloudLocation = env.GOOGLE_CLOUD_LOCATION;
      if (env?.GOOGLE_APPLICATION_CREDENTIALS !== undefined) connection.credentialsPath = env.GOOGLE_APPLICATION_CREDENTIALS;
      break;
    case "amazon-bedrock":
      if (env?.AWS_PROFILE !== undefined) connection.awsProfile = env.AWS_PROFILE;
      if (env?.AWS_REGION !== undefined) connection.awsRegion = env.AWS_REGION;
      break;
    case "cloudflare-workers-ai":
    case "cloudflare-ai-gateway":
      if (env?.CLOUDFLARE_ACCOUNT_ID !== undefined) connection.cloudflareAccountId = env.CLOUDFLARE_ACCOUNT_ID;
      if (env?.CLOUDFLARE_GATEWAY_ID !== undefined) connection.cloudflareGatewayId = env.CLOUDFLARE_GATEWAY_ID;
      break;
  }
  if (!credential.key?.trim()) {
    if (input.piProviderId !== "google-vertex" && input.piProviderId !== "amazon-bedrock") {
      throw new Error("This native provider requires a non-empty API key.");
    }
    return { connection: { ...connection, authMode: "ambient" }, credential: undefined };
  }
  return {
    connection: { ...connection, authMode: "api_key" },
    credential: { type: "api_key", key: credential.key },
  };
}

export type NativeProviderCredentialOptions = {
  readonly credentialStore?: ModelProviderCredentialStorePort;
  readonly resolveCredential?: () => Promise<Credential | undefined>;
  readonly apiKey?: string;
  readonly resolveApiKey?: () => string | undefined | Promise<string | undefined>;
};

/** Pi owns credential semantics; the product owns serialized, durable mutation. */
export function createNativeProviderCredentialStore(
  providerId: string,
  options: NativeProviderCredentialOptions,
  env: ProviderEnv,
  authMode: ModelProviderAuthMode,
): CredentialStore {
  const read = async (operation?: AuthOperationOptions): Promise<Credential | undefined> => {
    operation?.signal?.throwIfAborted();
    const value = options.credentialStore !== undefined
      ? await options.credentialStore.read(operation)
      : options.resolveCredential !== undefined
        ? await options.resolveCredential()
        : undefined;
    operation?.signal?.throwIfAborted();
    if (authMode === "ambient") return undefined;
    const credential = value === undefined ? undefined : piCredentialSchema.parse(value);
    // A slot holding the other authentication kind means the mode was switched; treat it as unconfigured.
    if (credential !== undefined && credential.type !== (authMode === "oauth" ? "oauth" : "api_key")) {
      return undefined;
    }
    if (credential !== undefined) {
      return credential.type === "api_key"
        ? { ...credential, env: { ...credential.env, ...env } }
        : credential;
    }
    if (options.credentialStore !== undefined || options.resolveCredential !== undefined) {
      return undefined;
    }
    const key = options.resolveApiKey === undefined ? options.apiKey : await options.resolveApiKey();
    operation?.signal?.throwIfAborted();
    return key === undefined || key.trim().length === 0
      ? undefined
      : { type: "api_key", key, env };
  };
  const requireStore = (): ModelProviderCredentialStorePort => {
    if (options.credentialStore === undefined) {
      throw new Error("Native provider login and OAuth refresh require a persistent credential store.");
    }
    return options.credentialStore;
  };
  return {
    read: async (id, operation) => id === providerId ? read(operation) : undefined,
    list: async (operation) => {
      const credential = await read(operation);
      return credential === undefined ? [] : [{ providerId, type: credential.type }];
    },
    modify: async (id, update, operation) => {
      if (id !== providerId) throw new Error("Credential mutation crossed the configured provider boundary.");
      const value = await requireStore().modify(async (current) => {
        const credential = current === undefined ? undefined : piCredentialSchema.parse(current);
        const next = await update(credential);
        return next === undefined ? undefined : piCredentialSchema.parse(next);
      }, operation);
      return value === undefined ? undefined : piCredentialSchema.parse(value);
    },
    delete: async (id, operation) => {
      if (id !== providerId) throw new Error("Credential deletion crossed the configured provider boundary.");
      await requireStore().delete(operation);
    },
  };
}
