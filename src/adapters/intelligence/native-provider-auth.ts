import type { ModelProviderAuthMode } from "../../domain/config/index.js";
import type { ModelProviderAuthFailure } from "../../app/model-service-auth/contracts.js";
import {
  createNativeModelProviderCollection,
  type NativeModelProviderOptions,
} from "./native-model-provider.js";

export type NativeProviderAuthPrompt = {
  readonly signal?: AbortSignal;
} & (
  | { readonly type: "text" | "secret" | "manual_code"; readonly message: string; readonly placeholder?: string }
  | {
      readonly type: "select";
      readonly message: string;
      readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
    }
);

export type NativeProviderAuthEvent =
  | {
      readonly type: "info";
      readonly message: string;
      readonly links?: readonly { readonly url: string; readonly label?: string }[];
    }
  | { readonly type: "auth_url"; readonly url: string; readonly instructions?: string }
  | {
      readonly type: "device_code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly intervalSeconds?: number;
      readonly expiresInSeconds?: number;
    }
  | { readonly type: "progress"; readonly message: string };

export type NativeProviderAuthInteraction = {
  readonly signal?: AbortSignal;
  readonly prompt: (prompt: NativeProviderAuthPrompt) => Promise<string>;
  readonly notify: (event: NativeProviderAuthEvent) => void;
};

export type NativeProviderAuthStatus = {
  readonly configured: boolean;
  readonly authMode?: ModelProviderAuthMode;
  readonly source?: string;
};

export type NativeModelProviderAuth = {
  login(type: "api_key" | "oauth", interaction: NativeProviderAuthInteraction): Promise<void>;
  logout(options?: { readonly signal?: AbortSignal }): Promise<void>;
  status(options?: { readonly signal?: AbortSignal }): Promise<NativeProviderAuthStatus>;
};

/** Product-facing interaction port; credentials never leave the Pi/store boundary. */
export function createNativeModelProviderAuth(
  options: Omit<NativeModelProviderOptions, "resolveCredential">,
): NativeModelProviderAuth {
  const { providerId, modelRegistry } = createNativeModelProviderCollection(options);
  return {
    login: async (type, interaction) => {
      if (options.credentialStore === undefined) {
        throw new Error("Native provider login requires a persistent credential store.");
      }
      if (options.connection?.authMode === "ambient") {
        throw new Error("Ambient connections use existing platform credentials, not interactive login.");
      }
      await modelRegistry.login(providerId, type, interaction);
    },
    logout: (operation) => modelRegistry.logout(providerId, operation),
    status: async (operation) => {
      const auth = await modelRegistry.checkAuth(providerId, operation);
      return auth === undefined
        ? { configured: false }
        : {
            configured: true,
            authMode: options.connection?.authMode ?? auth.type,
            ...(auth.source === undefined ? {} : { source: auth.source }),
          };
    },
  };
}

/** Only structured allowlisted facts leave the provider failure boundary. */
export function describeModelProviderAuthFailure(error: unknown): ModelProviderAuthFailure {
  const seen = new Set<unknown>();
  let current = error;
  let status: number | undefined;
  const codes = new Set<string>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as { readonly code?: unknown; readonly status?: unknown; readonly cause?: unknown };
    if (typeof record.code === "string") codes.add(record.code);
    if (status === undefined && typeof record.status === "number" && Number.isInteger(record.status) &&
        record.status >= 400 && record.status <= 599) status = record.status;
    current = record.cause;
  }
  const details = status === undefined ? {} : { httpStatus: status };
  if (["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT",
    "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].some((code) => codes.has(code))) {
    return { code: "model_auth_network", message: "无法连接登录服务，请检查网络、代理和证书。", ...details };
  }
  if (status === 429) return { code: "model_auth_rate_limit", message: "登录请求过于频繁，请稍后重试。", ...details };
  if (status === 401 || status === 403 || codes.has("oauth")) {
    return { code: "model_auth_rejected", message: "账号授权未完成或已失效，请重新登录。", ...details };
  }
  if (codes.has("auth")) {
    return { code: "model_auth_storage", message: "登录凭据无法读取或保存，请检查本地配置状态。", ...details };
  }
  return { code: "model_auth_failed", message: "登录未完成，请重试；问题持续时可查看本地诊断记录。", ...details };
}
