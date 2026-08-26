import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { applyAppBootstrap, loadAppBootstrap } from "../shell/bootstrap";
import type { AppState } from "./state";

export type AppBootstrapLoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready" }
  | { readonly status: "retrying" }
  | { readonly status: "error"; readonly message: string };

export type AppBootstrapController = {
  readonly state: AppBootstrapLoadState;
  readonly retry: () => void;
};

export function useAppBootstrap(input: {
  readonly mountedRef: MutableRefObject<boolean>;
  readonly setApp: Dispatch<SetStateAction<AppState>>;
}): AppBootstrapController {
  const [state, setState] = useState<AppBootstrapLoadState>({ status: "loading" });
  const abortRef = useRef<AbortController | undefined>(undefined);
  const epochRef = useRef(0);

  const load = useCallback((retry: boolean): void => {
    const epoch = ++epochRef.current;
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;
    setState({ status: retry ? "retrying" : "loading" });
    void loadAppBootstrap(abortController.signal).then((loaded) => {
      if (!input.mountedRef.current || epochRef.current !== epoch) return;
      input.setApp((previous) => applyAppBootstrap(previous, loaded));
      setState({ status: "ready" });
    }).catch((error: unknown) => {
      if (!input.mountedRef.current || epochRef.current !== epoch || abortController.signal.aborted) return;
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "工作台启动数据加载失败。",
      });
    }).finally(() => {
      if (abortRef.current === abortController) abortRef.current = undefined;
    });
  }, [input.mountedRef, input.setApp]);

  const retry = useCallback((): void => load(true), [load]);

  useEffect(() => {
    load(false);
    return () => {
      epochRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = undefined;
    };
  }, [load]);

  return { state, retry };
}