const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

type DesktopWindowPresentationState = {
  readonly maximized: boolean;
};

contextBridge.exposeInMainWorld("synechHost", {
  getLocalPreference: (key: string): string | undefined => {
    return readDesktopPreference(key);
  },
  setLocalPreference: (key: string, value: string): boolean => {
    return ipcRenderer.sendSync("synech:local-preference-set", { key, value }) === true;
  },
  getWindowState: () => {
    return ipcRenderer.invoke("synech:window-get-state") as Promise<DesktopWindowPresentationState>;
  },
  onWindowStateChanged: (callback: (state: DesktopWindowPresentationState) => void) => {
    const listener: Parameters<typeof ipcRenderer.on>[1] = (_event, payload: unknown) => {
      const state = readDesktopWindowPresentationState(payload);
      if (state !== undefined) {
        callback(state);
      }
    };
    ipcRenderer.on("synech:window-state-changed", listener);
    return () => {
      ipcRenderer.removeListener("synech:window-state-changed", listener);
    };
  },
  minimizeWindow: () => {
    ipcRenderer.send("synech:window-minimize");
  },
  toggleMaximizeWindow: () => {
    ipcRenderer.send("synech:window-toggle-maximize");
  },
  closeWindow: () => {
    ipcRenderer.send("synech:window-close");
  },
});

function readDesktopWindowPresentationState(payload: unknown): DesktopWindowPresentationState | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const candidate = payload as Partial<Record<keyof DesktopWindowPresentationState, unknown>>;
  if (typeof candidate.maximized !== "boolean") return undefined;
  return {
    maximized: candidate.maximized,
  };
}

function readDesktopPreference(key: string): string | undefined {
  try {
    return ipcRenderer.sendSync("synech:local-preference-get", key) as string | undefined;
  } catch {
    return undefined;
  }
}
