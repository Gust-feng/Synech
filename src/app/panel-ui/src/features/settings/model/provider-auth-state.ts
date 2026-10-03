import { useEffect, useRef, useState } from "react";
import type { ModelProviderAuthResponse } from "@panel-api/config";
import type { ModelForm, ModelProviderListItem } from "./settings-projection";

export type ModelProviderAuthActions = {
  readonly read: (profileId: string) => Promise<ModelProviderAuthResponse>;
  readonly start: (profileId: string) => Promise<ModelProviderAuthResponse>;
  readonly poll: (profileId: string, sessionId: string) => Promise<ModelProviderAuthResponse>;
  readonly answer: (profileId: string, sessionId: string, promptId: string, value: string) => Promise<ModelProviderAuthResponse>;
  readonly cancel: (profileId: string, sessionId: string) => Promise<ModelProviderAuthResponse>;
  readonly logout: (profileId: string) => Promise<ModelProviderAuthResponse>;
};

type AuthEntry = {
  readonly auth?: ModelProviderAuthResponse;
  readonly busy?: boolean;
  readonly error?: string;
};

export function useModelProviderAuthState(options: {
  readonly item?: ModelProviderListItem;
  readonly form: ModelForm;
  readonly actions: ModelProviderAuthActions;
  readonly saveModelImmediately: (form: ModelForm) => Promise<void>;
}) {
  const [entries, setEntries] = useState<Readonly<Record<string, AuthEntry>>>({});
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mountedRef = useRef(true);
  const busyRef = useRef(new Set<string>());
  const revisionsRef = useRef<Record<string, number>>({});
  const profileId = options.item?.profileId;
  const profileUpdatedAt = options.item?.profile?.updatedAt;
  const authMode = options.form.connection?.authMode;
  const oauth = options.form.protocolKind === "native" && authMode === "oauth";
  const entry = profileId === undefined ? undefined : entries[profileId];
  const session = entry?.auth?.authSession;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  function update(profile: string, patch: Partial<AuthEntry>): void {
    if (!mountedRef.current) return;
    setEntries((previous) => ({
      ...previous,
      [profile]: { ...previous[profile], ...patch },
    }));
  }

  useEffect(() => {
    if (profileId === undefined || !oauth || busyRef.current.has(profileId)) return;
    let cancelled = false;
    const revision = revisionsRef.current[profileId] ?? 0;
    void optionsRef.current.actions.read(profileId).then((auth) => {
      if (cancelled || revision !== (revisionsRef.current[profileId] ?? 0)) return;
      setEntries((previous) => ({
        ...previous,
        [profileId]: {
          ...previous[profileId],
          auth: auth.authSession === undefined && !auth.configured && previous[profileId]?.auth?.authSession?.status === "pending"
            ? { ...auth, authSession: previous[profileId]?.auth?.authSession }
            : auth,
          error: undefined,
        },
      }));
    }).catch((error) => {
      if (!cancelled) update(profileId, { error: error instanceof Error ? error.message : "登录状态读取失败。" });
    });
    return () => { cancelled = true; };
  }, [profileId, oauth, authMode, profileUpdatedAt]);

  useEffect(() => {
    if (profileId === undefined || !oauth || session?.status !== "pending") return;
    const sessionId = session.sessionId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (busyRef.current.has(profileId)) {
        timer = setTimeout(() => void poll(), 1500);
        return;
      }
      const revision = revisionsRef.current[profileId] ?? 0;
      try {
        const auth = await optionsRef.current.actions.poll(profileId, sessionId);
        if (cancelled) return;
        if (revision !== (revisionsRef.current[profileId] ?? 0)) {
          timer = setTimeout(() => void poll(), 1500);
          return;
        }
        update(profileId, { auth, error: undefined });
        if (auth.authSession?.status !== "pending") return;
      } catch (error) {
        if (cancelled || revision !== (revisionsRef.current[profileId] ?? 0)) return;
        update(profileId, { error: error instanceof Error ? error.message : "登录状态更新失败。" });
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [profileId, oauth, session?.sessionId, session?.status]);

  async function perform(action: (profile: string) => Promise<ModelProviderAuthResponse>): Promise<void> {
    if (profileId === undefined || busyRef.current.has(profileId)) return;
    busyRef.current.add(profileId);
    revisionsRef.current[profileId] = (revisionsRef.current[profileId] ?? 0) + 1;
    update(profileId, { busy: true, error: undefined });
    try {
      update(profileId, { auth: await action(profileId), error: undefined });
    } catch (error) {
      update(profileId, { error: error instanceof Error ? error.message : "账号操作失败。" });
    } finally {
      busyRef.current.delete(profileId);
      update(profileId, { busy: false });
    }
  }

  return {
    auth: entry?.auth !== undefined && (entry.auth.authMode === undefined || entry.auth.authMode === authMode) ? entry.auth : undefined,
    busy: entry?.busy === true,
    error: entry?.error,
    start: () => perform(async (profile) => {
      const form = optionsRef.current.form;
      await optionsRef.current.saveModelImmediately(form);
      return optionsRef.current.actions.start(profile);
    }),
    answer: (promptId: string, value: string) => perform(async (profile) => {
      if (session === undefined) throw new Error("登录会话已结束，请重新登录。");
      return optionsRef.current.actions.answer(profile, session.sessionId, promptId, value);
    }),
    cancel: () => perform(async (profile) => {
      if (session === undefined) throw new Error("登录会话已结束。");
      return optionsRef.current.actions.cancel(profile, session.sessionId);
    }),
    logout: () => perform((profile) => optionsRef.current.actions.logout(profile)),
  };
}
