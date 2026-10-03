import type { ModelProviderAuthResponse } from "@panel-api/config";
import type { SettingsControllerContext } from "./controller-types";
import type { ModelProviderAuthActions } from "../model/provider-auth-state";
import {
  answerModelProviderAuth,
  cancelModelProviderAuth,
  fetchModelAuthConfigSnapshot,
  loginModelProvider,
  logoutModelProvider,
  readModelProviderAuth,
} from "../model/model-auth-api";
import { mergeConfigResponse } from "../config-projection";

export function createModelProviderAuthActions(context: SettingsControllerContext): ModelProviderAuthActions {
  async function synchronizeAuth(response: ModelProviderAuthResponse, force = false): Promise<ModelProviderAuthResponse> {
    if (force || response.authSession?.status !== "pending") {
      try {
        const config = await fetchModelAuthConfigSnapshot();
        if (context.mountedRef.current) {
          context.setApp((previous) => ({ ...previous, config: mergeConfigResponse(previous.config, config) }));
        }
      } catch (error) {
        if (context.mountedRef.current) {
          context.setApp((previous) => ({
            ...previous,
            error: error instanceof Error ? error.message : "登录配置状态刷新失败。",
          }));
        }
      }
    }
    return response;
  }

  return {
    read: async (profileId) => synchronizeAuth(await readModelProviderAuth(profileId)),
    start: async (profileId) => synchronizeAuth(await loginModelProvider(profileId), true),
    poll: async (profileId) => synchronizeAuth(await readModelProviderAuth(profileId)),
    answer: async (profileId, sessionId, promptId, value) => synchronizeAuth(await answerModelProviderAuth(profileId, sessionId, promptId, value)),
    cancel: async (profileId, sessionId) => synchronizeAuth(await cancelModelProviderAuth(profileId, sessionId), true),
    logout: async (profileId) => synchronizeAuth(await logoutModelProvider(profileId), true),
  };
}
