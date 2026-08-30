export type InstallPhase =
  | "configure"
  | "preparing"
  | "installing"
  | "completed"
  | "failed";

export type InstallActivityId =
  | "prepare-installer"
  | "install-application"
  | "verify-application-files"
  | "verify-uninstall-info"
  | "sync-shortcuts";

export type InstallActivityKind = "package" | "files" | "verification" | "shortcuts" | "uninstall";

export type InstallActivityState = "started" | "progress" | "completed";

export type InstallActivityObject = {
  readonly kind: "package" | "directory" | "file" | "shortcut" | "registry" | "executable";
  readonly path: string;
  readonly value?: string;
  readonly detail?: string;
  readonly sizeBytes?: number;
};

export type InstallActivityPayload = {
  readonly id: InstallActivityId;
  readonly kind: InstallActivityKind;
  readonly state: InstallActivityState;
  readonly objects: readonly InstallActivityObject[];
};

export type InstallArtifact = {
  readonly path: string;
  readonly sizeBytes: number;
  readonly key?: string;
};

export type InstallLocationPayload = {
  readonly installParentPath: string;
  readonly installPath: string;
  readonly requiredBytes: number;
  readonly availableBytes: number;
};

export type HostMessage =
  | { readonly type: "host.ready"; readonly payload: InstallLocationPayload }
  | { readonly type: "directory.selected"; readonly payload: InstallLocationPayload }
  | { readonly type: "install.phase"; readonly payload: { readonly phase: InstallPhase } }
  | { readonly type: "install.activity"; readonly payload: InstallActivityPayload }
  | { readonly type: "install.artifacts"; readonly payload: { readonly artifacts: readonly InstallArtifact[] } }
  | { readonly type: "install.failure"; readonly payload: { readonly code: string } };

type WebViewHost = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent<HostMessage>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<HostMessage>) => void): void;
};

declare global {
  interface Window {
    chrome?: { readonly webview?: WebViewHost };
    /** Development-only host injection used by mock.html in a normal browser. */
    __synechInstallerMockWebview?: WebViewHost;
  }
}

function installerWebview(): WebViewHost | undefined {
  const isNativeDemo = new URLSearchParams(window.location.search).get("demo") === "1";
  if (isNativeDemo) return window.__synechInstallerMockWebview ?? window.chrome?.webview;
  return window.chrome?.webview ?? window.__synechInstallerMockWebview;
}

export function postHostCommand(command: Readonly<Record<string, unknown>>): void {
  installerWebview()?.postMessage(command);
}

export function subscribeToHost(listener: (message: HostMessage) => void): () => void {
  const webview = installerWebview();
  if (webview === undefined) return () => undefined;
  const handleMessage = (event: MessageEvent<HostMessage>): void => listener(event.data);
  webview.addEventListener("message", handleMessage);
  return () => webview.removeEventListener("message", handleMessage);
}
