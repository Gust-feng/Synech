import {
  createNativeModelProviderAuth,
  describeModelProviderAuthFailure,
  normalizeNativeCredentialPublication,
} from "../../../adapters/intelligence/index.js";
import type { ConfigCenter } from "../../config-center/index.js";
import {
  ModelProviderAuthApplication,
  ModelProviderAuthError,
} from "../../model-service-auth/model-provider-auth-application.js";
import type { ModelProviderAuthApplicationOptions, ModelProviderAuthPort } from "../../model-service-auth/contracts.js";
import type { PanelServerOptions } from "../types.js";

export function createModelProviderAuthApplication(
  configCenter: ConfigCenter,
  onFailure: ModelProviderAuthApplicationOptions["onFailure"] = (diagnostic) => {
    // Raw provider errors may contain tokens, authorization codes and response bodies.
    console.error("model_provider_auth_failed", JSON.stringify(diagnostic));
  },
  openExternalResource?: PanelServerOptions["externalResourceOpener"],
): ModelProviderAuthApplication {
  return new ModelProviderAuthApplication({
    profiles: configCenter,
    describeFailure: describeModelProviderAuthFailure,
    onFailure,
    createAuth: async (profile, publication) => {
      const auth = createNativeModelProviderAuth({
        profileId: profile.profileId,
        secretUpdatedAt: profile.secretUpdatedAt,
        piProviderId: profile.piProviderId,
        baseUrl: profile.baseUrl,
        connection: profile.connection,
        credentialStore: await configCenter.createModelProviderCredentialStore(profile.profileId, {
          rotateRevisionOnWrite: publication !== undefined,
          ...(publication === undefined ? {} : {
            onPublicationStarted: publication.onStarted,
            preparePublication: ({ connection, credential }) => {
              if (profile.piProviderId === undefined) {
                throw new ModelProviderAuthError("model_auth_unsupported", "该连接缺少原生服务身份。");
              }
              return normalizeNativeCredentialPublication({
                piProviderId: profile.piProviderId,
                connection,
                credential,
              });
            },
          }),
        }),
      });
      return withAuthorizationBrowser(auth, openExternalResource);
    },
  });
}

function withAuthorizationBrowser(
  auth: ModelProviderAuthPort,
  openExternalResource: PanelServerOptions["externalResourceOpener"],
): ModelProviderAuthPort {
  if (openExternalResource === undefined) return auth;
  return {
    ...auth,
    login: (type, interaction) => {
      const openedUrls = new Set<string>();
      let active = true;
      return auth.login(type, {
        ...interaction,
        notify: (event) => {
          interaction.notify(event);
          const url = event.type === "auth_url" ? event.url
            : event.type === "device_code" ? event.verificationUri : undefined;
          if (!active || url === undefined || interaction.signal?.aborted || openedUrls.has(url)) return;
          openedUrls.add(url);
          void openAuthorizationPage(url, openExternalResource).catch(() => {
            if (!active || interaction.signal?.aborted) return;
            interaction.notify({ type: "info", message: "无法自动打开浏览器，请使用登录链接完成授权。" });
          });
        },
      }).finally(() => { active = false; });
    },
  };
}

async function openAuthorizationPage(
  value: string,
  openExternalResource: NonNullable<PanelServerOptions["externalResourceOpener"]>,
): Promise<void> {
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("Invalid model authorization URL.");
  }
  await openExternalResource({ kind: "url", value: url.href });
}
