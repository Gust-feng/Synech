import { randomUUID } from "node:crypto";
import type {
  ModelProviderAuthApplicationOptions,
  ModelProviderAuthPort,
  ModelProviderAuthResponse,
  ModelProviderAuthSession,
  ModelProviderLoginPrompt,
} from "./contracts.js";
import type { SanitizedModelProviderConfig } from "../../domain/config/index.js";

export class ModelProviderAuthError extends Error {
  constructor(readonly code: "model_profile_not_found" | "model_auth_unsupported" | "model_auth_session_stale", message: string) {
    super(message);
    this.name = "ModelProviderAuthError";
  }
}

type PendingAuthPrompt = {
  readonly promptId: string;
  readonly respond: (value: string) => void;
  readonly cancel: () => void;
};

type AuthSessionState = {
  snapshot: ModelProviderAuthSession;
  readonly controller: AbortController;
  pendingPrompt?: PendingAuthPrompt;
  timer?: ReturnType<typeof setTimeout>;
  finished?: Promise<void>;
  publicationStarted?: boolean;
};

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** One host-owned application instance coordinates every model login entry point. */
export class ModelProviderAuthApplication {
  private readonly sessions = new Map<string, AuthSessionState>();
  private readonly starts = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(private readonly options: ModelProviderAuthApplicationOptions) {}

  async login(profileId: string): Promise<ModelProviderAuthResponse> {
    return this.serializeStart(profileId, async () => {
      this.requireOpen();
      const profile = await this.requireProfile(profileId);
      if (profile.protocolKind !== "native" || profile.connection?.authMode === "ambient") {
        throw new ModelProviderAuthError("model_auth_unsupported", "该连接不使用交互登录。");
      }
      await this.finishPublication(this.sessions.get(profileId));
      this.cancelPending(this.sessions.get(profileId));
      await this.options.profiles.invalidateModelProviderLogin(profileId);
      const state: AuthSessionState = {
        snapshot: { sessionId: randomUUID(), profileId, status: "pending", events: [] },
        controller: new AbortController(),
      };
      const auth = await this.createAuth(profile, state);
      this.requireOpen();
      this.sessions.set(profileId, state);
      state.timer = setTimeout(() => this.cancelPending(state), LOGIN_TIMEOUT_MS);
      state.timer.unref();
      state.finished = this.runLogin(profile, auth, state);
      return this.response(profileId, state);
    });
  }

  async status(profileId: string): Promise<ModelProviderAuthResponse> {
    await this.starts.get(profileId);
    return this.response(profileId, this.sessions.get(profileId));
  }

  async respond(profileId: string, input: { readonly sessionId: string; readonly promptId: string; readonly value: string }): Promise<ModelProviderAuthResponse> {
    await this.requireProfile(profileId);
    const state = this.requireSession(profileId, input.sessionId);
    const prompt = state.pendingPrompt;
    if (state.snapshot.status !== "pending" || prompt?.promptId !== input.promptId) {
      throw new ModelProviderAuthError("model_auth_session_stale", "登录步骤已结束，请刷新登录状态。");
    }
    if (state.snapshot.prompt?.type === "select" &&
        !state.snapshot.prompt.options?.some((option) => option.id === input.value)) {
      throw new ModelProviderAuthError("model_auth_session_stale", "请选择当前登录步骤中的选项。");
    }
    prompt.respond(input.value);
    return this.response(profileId, state);
  }

  async cancel(profileId: string, sessionId: string): Promise<ModelProviderAuthResponse> {
    await this.requireProfile(profileId);
    const state = this.requireSession(profileId, sessionId);
    await this.finishPublication(state);
    if (state.snapshot.status === "pending") {
      this.cancelPending(state);
      await this.options.profiles.invalidateModelProviderLogin(profileId);
    }
    return this.response(profileId, state);
  }

  async logout(profileId: string): Promise<ModelProviderAuthResponse> {
    return this.serializeStart(profileId, async () => {
      const profile = await this.requireProfile(profileId);
      if (profile.connection?.authMode === "ambient") {
        throw new ModelProviderAuthError("model_auth_unsupported", "该连接使用平台管理的凭据，请在对应平台退出。");
      }
      await this.finishPublication(this.sessions.get(profileId));
      this.cancelPending(this.sessions.get(profileId));
      await this.options.profiles.invalidateModelProviderLogin(profileId);
      if (profile.protocolKind === "native") {
        const auth = await this.createAuth(profile);
        await auth.logout();
      } else {
        await this.options.profiles.updateModelProviderConfig({ profileId, clearApiKey: true });
      }
      return this.response(profileId, this.sessions.get(profileId));
    });
  }

  async deleteProfile(profileId: string): Promise<readonly SanitizedModelProviderConfig[]> {
    const profiles = await this.options.profiles.deleteModelProviderProfile(profileId);
    this.cancelPending(this.sessions.get(profileId));
    this.sessions.delete(profileId);
    return profiles;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const state of this.sessions.values()) this.cancelPending(state);
    const pending = [...this.sessions.values()].flatMap((state) => state.finished === undefined ? [] : [state.finished]);
    pending.push(...this.starts.values());
    this.sessions.clear();
    await Promise.allSettled(pending);
  }

  private async runLogin(
    profile: SanitizedModelProviderConfig,
    auth: ModelProviderAuthPort,
    state: AuthSessionState,
  ): Promise<void> {
    try {
      await auth.login(profile.connection?.authMode === "oauth" ? "oauth" : "api_key", {
        signal: state.controller.signal,
        prompt: (prompt) => this.prompt(state, prompt),
        notify: (event) => {
          if (state.snapshot.status !== "pending") return;
          state.snapshot = { ...state.snapshot, events: [...state.snapshot.events, event].slice(-64) };
        },
      });
      state.controller.signal.throwIfAborted();
      state.snapshot = { ...state.snapshot, status: "completed", prompt: undefined };
    } catch (error) {
      if (state.controller.signal.aborted) {
        state.snapshot = { ...state.snapshot, status: "cancelled", prompt: undefined };
      } else {
        const failure = this.options.describeFailure(error);
        this.options.onFailure({
          ...failure,
          profileId: profile.profileId,
          sessionId: state.snapshot.sessionId,
        }, new Error("Model provider login failed.", { cause: error }));
        state.snapshot = {
          ...state.snapshot,
          status: "failed",
          prompt: undefined,
          error: { code: failure.code, message: failure.message },
        };
      }
    } finally {
      state.pendingPrompt?.cancel();
      delete state.pendingPrompt;
      if (state.timer !== undefined) clearTimeout(state.timer);
      delete state.timer;
    }
  }

  private prompt(state: AuthSessionState, prompt: ModelProviderLoginPrompt): Promise<string> {
    state.controller.signal.throwIfAborted();
    prompt.signal?.throwIfAborted();
    const promptId = randomUUID();
    const { signal: promptSignal, ...displayPrompt } = prompt;
    state.snapshot = { ...state.snapshot, prompt: { ...displayPrompt, promptId } };
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (value?: string, error?: unknown) => {
        if (settled) return;
        settled = true;
        state.controller.signal.removeEventListener("abort", abort);
        promptSignal?.removeEventListener("abort", abort);
        if (state.pendingPrompt?.promptId === promptId) {
          delete state.pendingPrompt;
          state.snapshot = { ...state.snapshot, prompt: undefined };
        }
        if (error === undefined) resolve(value ?? "");
        else reject(error);
      };
      const abort = () => finish(undefined, new Error("Model login prompt cancelled."));
      state.pendingPrompt = {
        promptId,
        respond: (value) => finish(value),
        cancel: abort,
      };
      state.controller.signal.addEventListener("abort", abort, { once: true });
      promptSignal?.addEventListener("abort", abort, { once: true });
      if (state.controller.signal.aborted || promptSignal?.aborted) abort();
    });
  }

  private cancelPending(state: AuthSessionState | undefined): void {
    if (state === undefined || state.snapshot.status !== "pending" || state.publicationStarted) return;
    state.snapshot = { ...state.snapshot, status: "cancelled", prompt: undefined };
    state.controller.abort();
    state.pendingPrompt?.cancel();
    delete state.pendingPrompt;
    if (state.timer !== undefined) clearTimeout(state.timer);
    delete state.timer;
  }

  private async finishPublication(state: AuthSessionState | undefined): Promise<void> {
    // Once durable publication starts, completion wins over a late cancel.
    if (state?.publicationStarted && state.finished !== undefined) await state.finished;
  }

  private requireSession(profileId: string, sessionId: string): AuthSessionState {
    const state = this.sessions.get(profileId);
    if (state === undefined || state.snapshot.sessionId !== sessionId) {
      throw new ModelProviderAuthError("model_auth_session_stale", "登录会话已结束，请重新登录。");
    }
    return state;
  }

  private requireOpen(): void {
    if (this.disposed) throw new ModelProviderAuthError("model_auth_session_stale", "应用正在关闭，登录已终止。");
  }

  private async requireProfile(profileId: string): Promise<SanitizedModelProviderConfig> {
    const profile = (await this.options.profiles.listModelProviderProfiles()).find((item) => item.profileId === profileId);
    if (profile === undefined) throw new ModelProviderAuthError("model_profile_not_found", "未找到模型连接。");
    return profile;
  }

  private createAuth(profile: SanitizedModelProviderConfig, login?: AuthSessionState): Promise<ModelProviderAuthPort> {
    return this.options.createAuth(profile, login === undefined ? undefined : {
      onStarted: () => { login.publicationStarted = true; },
    });
  }

  private async response(profileId: string, state: AuthSessionState | undefined): Promise<ModelProviderAuthResponse> {
    await this.finishPublication(state);
    const profile = await this.requireProfile(profileId);
    if (state?.snapshot.status === "pending") {
      return {
        ok: true,
        status: "completed",
        configured: false,
        authMode: profile.connection?.authMode,
        authSession: state.snapshot,
      };
    }
    const auth = profile.protocolKind === "native"
      ? await (await this.createAuth(profile)).status()
      : { configured: profile.secretConfigured, authMode: "api_key" as const };
    return {
      ok: true,
      status: "completed",
      ...auth,
      ...(state === undefined ? {} : { authSession: state.snapshot }),
    };
  }

  private serializeStart<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.starts.get(profileId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.starts.set(profileId, tail);
    void tail.then(() => {
      if (this.starts.get(profileId) === tail) this.starts.delete(profileId);
    });
    return result;
  }
}
