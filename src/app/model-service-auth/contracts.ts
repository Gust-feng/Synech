import type { ModelProviderAuthMode, SanitizedModelProviderConfig } from "../../domain/config/index.js";

export type ModelProviderAuthEvent = {
  readonly type: "info" | "auth_url" | "device_code" | "progress";
  readonly message?: string;
  readonly url?: string;
  readonly instructions?: string;
  readonly userCode?: string;
  readonly verificationUri?: string;
  readonly intervalSeconds?: number;
  readonly expiresInSeconds?: number;
  readonly links?: readonly { readonly url: string; readonly label?: string }[];
};

export type ModelProviderAuthPrompt = {
  readonly promptId: string;
  readonly type: "text" | "secret" | "select" | "manual_code";
  readonly message: string;
  readonly placeholder?: string;
  readonly options?: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
};

export type ModelProviderAuthSession = {
  readonly sessionId: string;
  readonly profileId: string;
  readonly status: "pending" | "completed" | "cancelled" | "failed";
  readonly events: readonly ModelProviderAuthEvent[];
  readonly prompt?: ModelProviderAuthPrompt;
  readonly error?: { readonly code: string; readonly message: string };
};

export type ModelProviderAuthResponse = {
  readonly ok: true;
  readonly status: "completed";
  readonly configured: boolean;
  readonly authMode?: ModelProviderAuthMode;
  readonly source?: string;
  readonly authSession?: ModelProviderAuthSession;
};

export type ModelProviderLoginPrompt = Omit<ModelProviderAuthPrompt, "promptId"> & {
  readonly signal?: AbortSignal;
};

export type ModelProviderAuthPort = {
  login(type: "api_key" | "oauth", interaction: {
    readonly signal?: AbortSignal;
    readonly prompt: (prompt: ModelProviderLoginPrompt) => Promise<string>;
    readonly notify: (event: ModelProviderAuthEvent) => void;
  }): Promise<void>;
  logout(): Promise<void>;
  status(): Promise<Pick<ModelProviderAuthResponse, "configured" | "authMode" | "source">>;
};

export type ModelProviderAuthFailure = {
  readonly code: "model_auth_network" | "model_auth_rejected" | "model_auth_rate_limit" |
    "model_auth_storage" | "model_auth_failed";
  readonly message: string;
  readonly httpStatus?: number;
};

export type ModelProviderAuthApplicationOptions = {
  readonly profiles: {
    listModelProviderProfiles(): Promise<readonly SanitizedModelProviderConfig[]>;
    invalidateModelProviderLogin(profileId: string): Promise<void>;
    updateModelProviderConfig(input: { readonly profileId: string; readonly clearApiKey: true }): Promise<unknown>;
    deleteModelProviderProfile(profileId: string): Promise<readonly SanitizedModelProviderConfig[]>;
  };
  readonly createAuth: (profile: SanitizedModelProviderConfig, publication?: {
    readonly onStarted: () => void;
  }) => Promise<ModelProviderAuthPort>;
  readonly describeFailure: (error: unknown) => ModelProviderAuthFailure;
  readonly onFailure: (diagnostic: ModelProviderAuthFailure & {
    readonly profileId: string;
    readonly sessionId: string;
  }, failure: Error) => void;
};
