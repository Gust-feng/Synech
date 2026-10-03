import { getJson, postJson } from "../../../api";
import type { ConfigResponse, ModelProviderAuthResponse } from "@panel-api/config";

function authPath(profileId: string, action: "status" | "login" | "respond" | "cancel" | "logout"): string {
  return `/api/config/model-profiles/${encodeURIComponent(profileId)}/auth/${action}`;
}

export function readModelProviderAuth(profileId: string): Promise<ModelProviderAuthResponse> {
  return getJson<ModelProviderAuthResponse>(authPath(profileId, "status"));
}

export function loginModelProvider(profileId: string): Promise<ModelProviderAuthResponse> {
  return postJson<ModelProviderAuthResponse>(authPath(profileId, "login"), {});
}

export function answerModelProviderAuth(
  profileId: string,
  sessionId: string,
  promptId: string,
  value: string,
): Promise<ModelProviderAuthResponse> {
  return postJson<ModelProviderAuthResponse>(authPath(profileId, "respond"), { sessionId, promptId, value });
}

export function cancelModelProviderAuth(profileId: string, sessionId: string): Promise<ModelProviderAuthResponse> {
  return postJson<ModelProviderAuthResponse>(authPath(profileId, "cancel"), { sessionId });
}

export function logoutModelProvider(profileId: string): Promise<ModelProviderAuthResponse> {
  return postJson<ModelProviderAuthResponse>(authPath(profileId, "logout"), {});
}

export function fetchModelAuthConfigSnapshot(): Promise<ConfigResponse> {
  return getJson<ConfigResponse>("/api/config");
}
