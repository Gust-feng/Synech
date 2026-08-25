import { useEffect, useRef } from "react";
import type { ModelForm } from "./settings-projection";

const PROVIDER_SAVE_DELAY_MS = 700;

export function useProviderSaveQueue(onSave: (form?: ModelForm) => Promise<void>) {
  const onSaveRef = useRef(onSave);
  const timerRef = useRef<number | undefined>(undefined);
  const pendingRef = useRef<ModelForm | undefined>(undefined);
  onSaveRef.current = onSave;

  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    const pending = pendingRef.current;
    pendingRef.current = undefined;
    if (pending !== undefined) void onSaveRef.current(pending).catch(() => undefined);
  }, []);

  function schedule(form: ModelForm): void {
    pendingRef.current = form;
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      const pending = pendingRef.current;
      pendingRef.current = undefined;
      if (pending !== undefined) void onSaveRef.current(pending).catch(() => undefined);
    }, PROVIDER_SAVE_DELAY_MS);
  }

  async function commit(form: ModelForm): Promise<void> {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    pendingRef.current = undefined;
    await onSaveRef.current(form);
  }

  function flush(): void {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    const pending = pendingRef.current;
    pendingRef.current = undefined;
    if (pending !== undefined) void onSaveRef.current(pending).catch(() => undefined);
  }

  return {
    schedule,
    commit,
    flush,
    save: (form: ModelForm) => onSaveRef.current(form),
  };
}
