import {
  createModels,
  defaultProviderAuthContext,
  lazyStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type DeferredHandle,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderEnv,
  type ProviderAuth,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { builtinProviders, radiusProvider } from "@earendil-works/pi-ai/providers/all";
import type { ModelProviderConnectionSettings } from "../../domain/config/index.js";
import {
  createNativeProviderCredentialStore,
  type NativeProviderCredentialOptions,
} from "./native-provider-credentials.js";
import { trackNativeModelRegistry } from "./native-provider-model-scope.js";

export type NativeModelProviderOptions = NativeProviderCredentialOptions & {
  readonly profileId: string;
  /** Credential revision; model/name changes must not invalidate the live catalog. */
  readonly secretUpdatedAt?: string;
  readonly piProviderId?: string;
  readonly baseUrl: string;
  readonly connection?: ModelProviderConnectionSettings;
};

export type NativeModelProviderCollection = {
  readonly providerId: string;
  readonly piProviderId: string;
  readonly modelRegistry: MutableModels;
};

/** Keep the native factory's auth, model policy, dynamic catalog and stream wrappers. */
export function createNativeModelProviderCollection(
  options: NativeModelProviderOptions,
): NativeModelProviderCollection {
  const providerId = nativeModelProviderRegistryId(options.profileId);
  const piProviderId = options.piProviderId?.trim();
  if (!piProviderId) throw new Error("A native connection requires an explicit Pi provider.");
  const native = piProviderId === "radius"
    ? radiusProvider({
        id: providerId,
        ...(options.baseUrl.trim().length === 0 ? {} : { gateway: options.baseUrl }),
      })
    : builtinProviders().find((provider) => provider.id === piProviderId);
  if (native === undefined) throw new Error(`Pi does not declare native provider ${piProviderId}.`);
  const authMode = options.connection?.authMode ?? (native.auth.apiKey === undefined ? "oauth" : "api_key");
  const auth = selectedNativeAuth(native.auth, authMode);
  if (authMode === "oauth" && options.credentialStore === undefined) {
    throw new Error("A native OAuth connection requires a persistent credential store.");
  }
  const env = nativeConnectionEnvironment(options, piProviderId);
  const baseUrlOverride = options.baseUrl.trim().length > 0 &&
    options.baseUrl.trim() !== (native.baseUrl ?? "").trim();
  const ambient = defaultProviderAuthContext();
  const modelRegistry = createModels({
    credentials: createNativeProviderCredentialStore(providerId, options, env, authMode),
    authContext: {
      env: async (name) => env[name] ?? (authMode === "ambient" ? ambient.env(name) : undefined),
      fileExists: (path) => authMode === "ambient" ? ambient.fileExists(path) : Promise.resolve(false),
    },
  });
  const scopedModel = (model: Model<Api>): Model<Api> => ({
    ...model,
    provider: providerId,
    ...(canOverrideBaseUrl(piProviderId) && baseUrlOverride
      ? { baseUrl: options.baseUrl }
      : {}),
  });
  const requestModel = (model: Model<Api>): Model<Api> => ({ ...model, provider: native.id });
  const requestContext = (context: TranscriptContext): TranscriptContext => ({
    ...context,
    messages: context.messages.map((message) =>
      message.role === "assistant" && message.provider === providerId
        ? withProviderIdentity(message, native.id)
        : message),
  });
  const requestHandle = (handle: DeferredHandle): DeferredHandle => {
    if (handle.provider !== providerId) {
      throw new Error("Deferred response belongs to a different model connection.");
    }
    return { ...handle, provider: native.id };
  };
  const requestOptions = <T extends StreamOptions>(model: Model<Api>, settings: T | undefined) => ({
    ...settings,
    env: {
      ...settings?.env,
      ...env,
      ...(piProviderId === "azure-openai-responses" && options.connection?.azureDeployment
        ? { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${model.id}=${options.connection.azureDeployment}` }
        : {}),
    },
  });
  // A registry alias must not replace the identity used by Pi's Copilot/OpenCode policies.
  const provider: Provider = {
    ...native,
    id: providerId,
    auth,
    getModels: () => native.getModels().map(scopedModel),
    ...(native.filterModels === undefined ? {} : {
      filterModels: (models, credential) => native.filterModels!(
        models.map(requestModel), credential,
      ).map(scopedModel),
    }),
    stream: (model, context, settings) => lazyStream(model, async () => scopeNativeStream(
      native.stream(requestModel(model), requestContext(context), requestOptions(model, settings)),
      providerId,
    )),
    streamSimple: (model, context, settings) => lazyStream(model, async () => scopeNativeStream(
      native.streamSimple(requestModel(model), requestContext(context), requestOptions(model, settings)),
      providerId,
    )),
    ...(native.fetchDeferred === undefined ? {} : {
      fetchDeferred: (model, handle, settings) => lazyStream(model, async () => scopeNativeStream(
        native.fetchDeferred!(requestModel(model), requestHandle(handle), requestOptions(model, settings)),
        providerId,
      )),
    }),
    ...(native.cancelDeferred === undefined ? {} : {
      cancelDeferred: (model, handle, settings) => native.cancelDeferred!(
        requestModel(model), requestHandle(handle), requestOptions(model, settings),
      ),
    }),
  };
  modelRegistry.setProvider(provider);
  trackNativeModelRegistry(options, providerId, modelRegistry);
  return { providerId, piProviderId, modelRegistry };
}

export function nativeModelProviderRegistryId(profileId: string): string {
  const profile = profileId.trim();
  if (profile.length === 0) throw new Error("Model provider profileId must not be blank.");
  return `synech-${profile}`;
}

function selectedNativeAuth(
  auth: ProviderAuth,
  mode: ModelProviderConnectionSettings["authMode"],
): ProviderAuth {
  const selected = mode === "oauth" ? auth.oauth : auth.apiKey;
  if (selected === undefined) throw new Error(`This Pi provider does not support ${mode} authentication.`);
  if (mode === "oauth") return { oauth: auth.oauth };
  const apiKey = auth.apiKey!;
  if (mode === "ambient") return { apiKey };
  return {
    apiKey: {
      ...apiKey,
      check: apiKey.check === undefined ? undefined : async (input) =>
        input.credential?.key ? apiKey.check!(input) : undefined,
      resolve: async (input) => input.credential?.key ? apiKey.resolve(input) : undefined,
    },
  };
}

function withProviderIdentity(message: AssistantMessage, providerId: string): AssistantMessage {
  return {
    ...message,
    provider: providerId,
    ...(message.deferred === undefined ? {} : {
      deferred: { ...message.deferred, provider: providerId },
    }),
  };
}

/** Preserve Pi's shared live partial object semantics while isolating transcript identity. */
async function* scopeNativeStream(
  source: AssistantMessageEventStream,
  providerId: string,
): AsyncIterable<AssistantMessageEvent> {
  const partials = new WeakMap<AssistantMessage, AssistantMessage>();
  const scoped = (message: AssistantMessage): AssistantMessage => {
    const previous = partials.get(message);
    const current = withProviderIdentity(message, providerId);
    if (previous !== undefined) return Object.assign(previous, current);
    partials.set(message, current);
    return current;
  };
  for await (const event of source) {
    switch (event.type) {
      case "done":
        yield { ...event, message: scoped(event.message) };
        break;
      case "error":
        yield { ...event, error: scoped(event.error) };
        break;
      default:
        yield { ...event, partial: scoped(event.partial) };
    }
  }
}

function canOverrideBaseUrl(providerId: string): boolean {
  return providerId !== "radius";
}

function nativeConnectionEnvironment(
  options: NativeModelProviderOptions,
  providerId: string,
): ProviderEnv {
  const connection = options.connection;
  const env: Record<string, string> = {};
  const set = (name: string, value: string | undefined) => {
    if (value !== undefined && value.trim().length > 0) env[name] = value.trim();
  };
  switch (providerId) {
    case "google-vertex":
      set("GOOGLE_CLOUD_PROJECT", connection?.cloudProject);
      set("GOOGLE_CLOUD_LOCATION", connection?.cloudLocation);
      set("GOOGLE_APPLICATION_CREDENTIALS", connection?.credentialsPath);
      break;
    case "amazon-bedrock":
      set("AWS_REGION", connection?.awsRegion);
      set("AWS_PROFILE", connection?.awsProfile);
      break;
    case "azure-openai-responses":
      set("AZURE_OPENAI_RESOURCE_NAME", connection?.azureResource);
      set("AZURE_OPENAI_API_VERSION", connection?.azureApiVersion);
      set("AZURE_OPENAI_BASE_URL", options.baseUrl);
      break;
    case "cloudflare-ai-gateway":
    case "cloudflare-workers-ai":
      set("CLOUDFLARE_ACCOUNT_ID", connection?.cloudflareAccountId);
      set("CLOUDFLARE_GATEWAY_ID", connection?.cloudflareGatewayId);
      break;
  }
  return env;
}
